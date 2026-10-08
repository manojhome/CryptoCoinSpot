using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

namespace CryptoTrader;

public sealed record MoomooTokens(string ClientId, string AccessToken, string RefreshToken, string Scope, DateTimeOffset ExpiresAt);
public sealed record MoomooAuthorization(string ClientId, string Verifier, string BrowserBinding);
public sealed record MoomooOrder(string AccountId, string Symbol, string Side, int Quantity, decimal LimitPrice);
public sealed record MoomooReview(MoomooOrder Order, DateTimeOffset ExpiresAt);
public sealed record MoomooHolding(string Symbol, string Company, decimal? Quantity, decimal? SellableQuantity,
    decimal? CostPrice, decimal? Last, decimal? MarketValue, decimal? Gain, decimal? GainPercent, string Side,
    string Currency, string AccountId = "");
public sealed record MoomooGainer(string Symbol, string Company, decimal? Price, decimal DayChange,
    decimal? PreviousDay, decimal? DayBefore, decimal? ThreeDayAverage, decimal? HourChange,
    string TradingDate, DateTimeOffset? QuoteTime);

// Credentials and OAuth exchanges stay on the server. No browser session
// cookies from moomoo are copied into this application.
public sealed class MoomooClient
{
    private readonly HttpClient http;
    private readonly IDataProtector protector;
    private readonly IMemoryCache cache;
    private readonly IConfiguration configuration;
    private readonly string tokenFile;
    private readonly SemaphoreSlim tokenLock = new(1, 1);
    private readonly SemaphoreSlim gainersLock = new(1, 1);

    public MoomooClient(IHttpClientFactory factory, IDataProtectionProvider protection,
        IMemoryCache cache, IConfiguration configuration)
    {
        http = factory.CreateClient("Moomoo");
        protector = protection.CreateProtector("CryptoCoinSpot.Moomoo.Tokens.v1");
        this.cache = cache;
        this.configuration = configuration;
        tokenFile = Path.Combine(configuration["Storage:DataDirectory"] ?? "Data", "moomoo-tokens.json");
    }

    public string RedirectUri => configuration["Moomoo:RedirectUri"] ?? "http://localhost:55109/access/moomoo/callback";
    public bool ProductionVerified => configuration.GetValue<bool>("Moomoo:ProductionAccountVerified");

    public MoomooTokens? ReadTokens()
    {
        if (!File.Exists(tokenFile)) return null;
        return JsonSerializer.Deserialize<MoomooTokens>(protector.Unprotect(File.ReadAllText(tokenFile)));
    }

    private void SaveTokens(MoomooTokens tokens)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(tokenFile))!);
        var temporary = tokenFile + ".tmp";
        File.WriteAllText(temporary, protector.Protect(JsonSerializer.Serialize(tokens)));
        File.Move(temporary, tokenFile, overwrite: true);
    }

    public object Status()
    {
        var tokens = ReadTokens();
        return new { connected = tokens != null, productionVerified = ProductionVerified,
            canTrade = tokens?.Scope.Split(' ').Contains("trade:write") == true && ProductionVerified,
            scopes = tokens?.Scope ?? "", message = tokens == null
                ? "Connect Moomoo to load US stocks and authorized accounts."
                : ProductionVerified ? "Moomoo connected. Review account permissions before enabling orders."
                : "Connected; production account is unverified. Live orders are locked." };
    }

    public async Task<string> BeginAuthorizationAsync(string browserBinding, CancellationToken ct)
    {
        var redirect = new Uri(RedirectUri);
        if (redirect.Scheme != "https" && !redirect.IsLoopback)
            throw new InvalidOperationException("OAuth requires an HTTPS callback or loopback address.");
        var clientFile = Path.Combine(Path.GetDirectoryName(tokenFile)!, "moomoo-client.json");
        string? clientId = configuration["Moomoo:ClientId"];
        if (clientId == null && File.Exists(clientFile))
        {
            using var saved = JsonDocument.Parse(File.ReadAllText(clientFile));
            if (saved.RootElement.GetProperty("redirectUri").GetString() == RedirectUri)
                clientId = saved.RootElement.GetProperty("clientId").GetString();
        }
        if (clientId == null)
        {
            var registration = await SendRawAsync(HttpMethod.Post, "/oauth2/register", new
            {
                redirect_uris = new[] { RedirectUri }, token_endpoint_auth_method = "none",
                grant_types = new[] { "authorization_code", "refresh_token" },
                response_types = new[] { "code" }, client_name = "CryptoCoinSpot US Stocks"
            }, null, ct);
            clientId = registration.GetProperty("client_id").GetString()!;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(clientFile))!);
            File.WriteAllText(clientFile, JsonSerializer.Serialize(new { clientId, redirectUri = RedirectUri }));
        }
        var verifier = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(48));
        var state = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        cache.Set("moomoo-auth:" + state, new MoomooAuthorization(clientId, verifier, browserBinding), TimeSpan.FromMinutes(15));
        return QueryHelpers.AddQueryString("https://webapi.moomoo.com/oauth2/authorize/confirm", new Dictionary<string, string?>
        {
            ["client_id"] = clientId, ["redirect_uri"] = RedirectUri, ["response_type"] = "code",
            ["state"] = state, ["code_challenge_method"] = "S256",
            ["code_challenge"] = WebEncoders.Base64UrlEncode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
        });
    }

    public async Task CompleteAuthorizationAsync(string state, string code, string browserBinding, CancellationToken ct)
    {
        if (!cache.TryGetValue<MoomooAuthorization>("moomoo-auth:" + state, out var pending) || pending == null ||
            !string.Equals(pending.BrowserBinding, browserBinding, StringComparison.Ordinal))
            throw new InvalidOperationException("Authorization expired or browser validation failed. Connect again.");
        cache.Remove("moomoo-auth:" + state);
        var response = await TokenRequestAsync(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = code, ["client_id"] = pending.ClientId,
            ["redirect_uri"] = RedirectUri, ["code_verifier"] = pending.Verifier
        }, ct);
        SaveTokens(ParseTokens(response, pending.ClientId, "", ""));
    }

    private static MoomooTokens ParseTokens(JsonElement value, string clientId, string refresh, string scope) => new(
        clientId, value.GetProperty("access_token").GetString()!,
        value.TryGetProperty("refresh_token", out var r) ? r.GetString()! : refresh,
        value.TryGetProperty("scope", out var s) ? s.GetString()! : scope,
        DateTimeOffset.UtcNow.AddSeconds(value.GetProperty("expires_in").GetInt32()));

    private async Task<JsonElement> TokenRequestAsync(Dictionary<string, string> values, CancellationToken ct)
    {
        using var response = await http.PostAsync("/oauth2/token", new FormUrlEncodedContent(values), ct);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Moomoo token exchange failed. Connect again.");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        if (!document.RootElement.TryGetProperty("access_token", out _))
            throw new InvalidOperationException("Moomoo did not grant an access token.");
        return document.RootElement.Clone();
    }

    private async Task<MoomooTokens> GetTokensAsync(CancellationToken ct)
    {
        await tokenLock.WaitAsync(ct);
        try
        {
            var tokens = ReadTokens() ?? throw new InvalidOperationException("Connect Moomoo first; no API credentials are configured.");
            if (tokens.ExpiresAt <= DateTimeOffset.UtcNow.AddMinutes(1))
            {
                var response = await TokenRequestAsync(new Dictionary<string, string>
                {
                    ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken, ["client_id"] = tokens.ClientId
                }, ct);
                tokens = ParseTokens(response, tokens.ClientId, tokens.RefreshToken, tokens.Scope);
                SaveTokens(tokens);
            }
            return tokens;
        }
        finally { tokenLock.Release(); }
    }

    private async Task<JsonElement> SendRawAsync(HttpMethod method, string path, object? body, string? token, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body != null) request.Content = JsonContent.Create(body);
        if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Moomoo request failed ({(int)response.StatusCode}). Check authorization and market-data permissions.");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        var root = document.RootElement;
        if ((root.TryGetProperty("ret_code", out var ret) && ret.GetInt32() != 0) ||
            (root.TryGetProperty("s", out var status) && status.GetString() == "error"))
            throw new InvalidOperationException("Moomoo rejected this request. Check permissions or complete any required action in the Moomoo app. Orders are never automatically retried.");
        return root.Clone();
    }

    public static string NormalizeSymbol(string symbol)
    {
        symbol = symbol.Trim().ToUpperInvariant();
        if (symbol.StartsWith("US.")) symbol = symbol[3..];
        if (!Regex.IsMatch(symbol, "^[A-Z]{1,6}(?:[.-][A-Z])?$")) throw new ArgumentException("Enter a US stock ticker, for example AAPL or BRK.B.");
        return "US." + symbol;
    }

    private static decimal? Decimal(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number)) return number;
        return value.ValueKind == JsonValueKind.String && decimal.TryParse(value.GetString(), NumberStyles.Float,
            CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    public static MoomooHolding ParseHolding(JsonElement item)
    {
        decimal? Valid(string field, string flag) => item.TryGetProperty(flag, out var valid) && valid.ValueKind == JsonValueKind.True
            ? Decimal(item, field) : null;
        return new(item.GetProperty("code").GetString()!, item.GetProperty("stock_name").GetString() ?? "",
            Decimal(item, "qty"), Decimal(item, "can_sell_qty"), Valid("cost_price", "cost_price_valid"),
            Decimal(item, "nominal_price"), Decimal(item, "market_val"), Valid("pl_val", "pl_val_valid"),
            Valid("pl_ratio", "pl_ratio_valid"), item.GetProperty("position_side").GetString() ?? "NONE",
            item.TryGetProperty("currency", out var currency) ? currency.GetString() ?? "" : "");
    }

    public async Task<object> GetHoldingsAsync(string accountId, CancellationToken ct)
    {
        var accounts = await GetAccountsAsync(ct);
        var selected = accounts.Where(a => accountId == "all" || a.GetProperty("account_id").ToString() == accountId).ToArray();
        if (selected.Length == 0) throw new ArgumentException("Select an authorized account.");
        var tokens = await GetTokensAsync(ct);
        var items = new List<MoomooHolding>();
        foreach (var account in selected)
        {
            var id = account.GetProperty("account_id").ToString();
            var root = await SendRawAsync(HttpMethod.Get, $"/api/v1.0/accounts/{Uri.EscapeDataString(id)}/positions", null, tokens.AccessToken, ct);
            items.AddRange(root.GetProperty("d").EnumerateArray().Select(p => ParseHolding(p) with { AccountId = id }));
        }
        return new { items, accountId, retrievedAt = DateTimeOffset.UtcNow,
            note = "All positions returned by your authorized accounts, in their reported currencies. Change uses Moomoo's cost basis (which may include prior sales), not a specific purchase date. Purchase dates are not supplied. Buy/Sell is currently supported for US stocks only." };
    }

    public async Task<object> GetStocksAsync(string symbols, CancellationToken ct)
    {
        var codes = symbols.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizeSymbol).Distinct().ToArray();
        if (codes.Length is < 1 or > 20) throw new ArgumentException("Request between 1 and 20 US symbols.");
        var tokens = await GetTokensAsync(ct);
        var root = await SendRawAsync(HttpMethod.Post, "/api/v1.0/quote/snapshot", new { code_list = codes }, tokens.AccessToken, ct);
        var items = root.GetProperty("data").GetProperty("snapshot_list").EnumerateArray().Select(item =>
        {
            var last = Decimal(item, "last_price");
            var previous = Decimal(item, "prev_close_price");
            return new
            {
                symbol = item.GetProperty("code").GetString(), company = item.GetProperty("name").GetString(), last,
                changePercent = previous > 0 && last > 0 ? (last - previous) / previous * 100 : null,
                bid = Decimal(item, "bid_price"), ask = Decimal(item, "ask_price"), volume = Decimal(item, "volume"),
                open = Decimal(item, "open_price"), dayHigh = Decimal(item, "high_price"), dayLow = Decimal(item, "low_price"),
                week52High = Decimal(item, "highest52weeks_price"), week52Low = Decimal(item, "lowest52weeks_price"),
                marketCap = Decimal(item, "total_market_val"), pe = Decimal(item, "pe_ttm_ratio"),
                tradingDate = item.TryGetProperty("data_date", out var date) ? date.GetString() : null,
                quoteTime = item.TryGetProperty("update_time", out var time) && time.TryGetInt64(out var ms) && ms > 0
                    ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : (DateTimeOffset?)null
            };
        }).ToArray();
        var returned = root.GetProperty("data").GetProperty("snapshot_list").EnumerateArray()
            .Select(item => item.GetProperty("code").GetString()).ToHashSet();
        return new { items, missingSymbols = codes.Where(code => !returned.Contains(code)), retrievedAt = DateTimeOffset.UtcNow,
            source = "Moomoo", productionVerified = ProductionVerified,
            note = "USD prices. Quote timestamps and trading dates are supplied by Moomoo; real-time entitlement and production data have not been independently verified." };
    }

    public async Task<JsonElement[]> GetAccountsAsync(CancellationToken ct)
    {
        var tokens = await GetTokensAsync(ct);
        var root = await SendRawAsync(HttpMethod.Get, "/api/v1.0/accounts/authorized_trd_accs", null, tokens.AccessToken, ct);
        return root.GetProperty("d").GetProperty("accounts").EnumerateArray().Select(item => item.Clone()).ToArray();
    }

    public async Task<object> GetGainersAsync(CancellationToken ct)
    {
        await gainersLock.WaitAsync(ct);
        try
        {
            if (cache.TryGetValue<object>("moomoo-us-gainers", out var saved) && saved != null) return saved;
            var tokens = await GetTokensAsync(ct);
            var screen = await SendRawAsync(HttpMethod.Post, "/api/v1.0/quote/stock-screen", new
            {
                limit = 300, screen_queries = new[] { new { simple_field_query = new { simple_field = 1, screen_value_list = new[] { 2 } } } },
                retrieve_queries = new object[] { new { simple_property = new { name = 2201 } }, new { cumulative_property = new { name = 3102, days = 1 } } },
                sort = new { direction = 2, cumulative_property = new { name = 3102, days = 1 } }
            }, tokens.AccessToken, ct);
            var codes = screen.GetProperty("data").GetProperty("items").EnumerateArray()
                .Select(p => p.GetProperty("code").GetString()!).Where(c => Regex.IsMatch(c, "^US\\.[A-Z]{1,6}(?:[.-][A-Z])?$")).Distinct().ToArray();
            var rows = new List<MoomooGainer>();
            if (codes.Length > 0)
            {
                var basic = await SendRawAsync(HttpMethod.Post, "/api/v1.0/quote/stock-basicinfo", new { code_list = codes }, tokens.AccessToken, ct);
                var stocks = basic.GetProperty("data").GetProperty("basic_list").EnumerateArray().Where(p =>
                    p.GetProperty("stock_type").GetString() == "STOCK" && p.GetProperty("state").GetString() == "NORMAL" &&
                    (!p.TryGetProperty("suspension", out var suspension) || suspension.ValueKind != JsonValueKind.True))
                    .Select(p => p.GetProperty("code").GetString()).ToHashSet();
                var selected = codes.Where(c => stocks.Contains(c)).Take(75).ToArray();
                if (selected.Length > 0)
                {
                    var snapshots = await SendRawAsync(HttpMethod.Post, "/api/v1.0/quote/snapshot", new { code_list = selected }, tokens.AccessToken, ct);
                    foreach (var item in snapshots.GetProperty("data").GetProperty("snapshot_list").EnumerateArray())
                    {
                        var price = Decimal(item, "last_price"); var previous = Decimal(item, "prev_close_price");
                        if (price <= 0 || previous <= 0 || price == null || previous == null || price <= previous) continue;
                        rows.Add(new(item.GetProperty("code").GetString()!, item.GetProperty("name").GetString() ?? "", price,
                            (price.Value / previous.Value - 1) * 100, null, null, null, null,
                            item.TryGetProperty("data_date", out var date) ? date.GetString() ?? "" : "",
                            Decimal(item, "update_time") is > 0 and var ms ? DateTimeOffset.FromUnixTimeMilliseconds((long)ms) : null));
                    }
                }
            }
            using var throttle = new SemaphoreSlim(3);
            var enriched = await Task.WhenAll(rows.OrderByDescending(r => r.DayChange).Take(50).Select(async row =>
            {
                await throttle.WaitAsync(ct);
                try { return await EnrichGainerAsync(row, tokens.AccessToken, ct); }
                finally { throttle.Release(); }
            }));
            var result = new { items = enriched.OrderByDescending(r => r.DayChange).ToArray(), retrievedAt = DateTimeOffset.UtcNow,
                note = "Top positive movers from Moomoo's first 300 US screening results, filtered to active stocks (including OTC). Day = price versus previous close, not rolling 24H. Previous days use completed trading sessions; 1H uses completed regular-session five-minute candles. N/A means history unavailable. USD prices; provider quote timestamps shown. Results cached for 2 minutes." };
            cache.Set("moomoo-us-gainers", result, TimeSpan.FromMinutes(2));
            return result;
        }
        finally { gainersLock.Release(); }
    }

    public static (decimal? Previous, decimal? Before, decimal? Hour) GainerHistory(JsonElement daily, JsonElement intraday, string tradingDate, DateTimeOffset quoteTime)
    {
        var ny = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        string Date(JsonElement candle) => TimeZoneInfo.ConvertTime(DateTimeOffset.FromUnixTimeMilliseconds(candle.GetProperty("time_key").GetInt64()), ny).ToString("yyyy-MM-dd");
        var completed = daily.EnumerateArray().Where(c => string.CompareOrdinal(Date(c), tradingDate) < 0)
            .OrderByDescending(c => c.GetProperty("time_key").GetInt64()).Take(2).ToArray();
        decimal? Change(JsonElement candle) => Decimal(candle, "close") is > 0 and var close && Decimal(candle, "last_close") is > 0 and var previous ? (close / previous - 1) * 100 : null;
        var candles = intraday.EnumerateArray().Where(c => Date(c) == tradingDate && c.GetProperty("time_key").GetInt64() + 300000 <= quoteTime.ToUnixTimeMilliseconds())
            .OrderByDescending(c => c.GetProperty("time_key").GetInt64()).ToArray();
        decimal? hourly = null;
        if (candles.Length > 0)
        {
            var latest = candles[0]; var target = latest.GetProperty("time_key").GetInt64() - 3600000;
            var earlier = candles.FirstOrDefault(c => c.GetProperty("time_key").GetInt64() == target);
            if (earlier.ValueKind != JsonValueKind.Undefined && Decimal(earlier, "close") is > 0 and var old && Decimal(latest, "close") is > 0 and var current)
                hourly = (current / old - 1) * 100;
        }
        return (completed.Length > 0 ? Change(completed[0]) : null, completed.Length > 1 ? Change(completed[1]) : null, hourly);
    }

    private async Task<MoomooGainer> EnrichGainerAsync(MoomooGainer row, string token, CancellationToken ct)
    {
        if (!System.DateOnly.TryParseExact(row.TradingDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date) || row.QuoteTime == null) return row;
        try
        {
            var path = $"/api/v1.0/quote/{Uri.EscapeDataString(row.Symbol)}/history-kline";
            var daily = await SendRawAsync(HttpMethod.Get, $"{path}?start={date.AddDays(-20):yyyy-MM-dd}&end={date:yyyy-MM-dd}&ktype=2&autype=1&num=20", null, token, ct);
            JsonElement hourly;
            try { hourly = (await SendRawAsync(HttpMethod.Get, $"{path}?start={date:yyyy-MM-dd}&end={date:yyyy-MM-dd}&ktype=6&autype=1&num=100&extended_time=0", null, token, ct)).GetProperty("data").GetProperty("kline_list"); }
            catch (Exception) when (!ct.IsCancellationRequested) { hourly = JsonSerializer.SerializeToElement(Array.Empty<object>()); }
            var history = GainerHistory(daily.GetProperty("data").GetProperty("kline_list"), hourly, row.TradingDate, row.QuoteTime.Value);
            return row with { PreviousDay = history.Previous, DayBefore = history.Before, HourChange = history.Hour,
                ThreeDayAverage = history.Previous != null && history.Before != null ? (row.DayChange + history.Previous + history.Before) / 3 : null };
        }
        catch (Exception) when (!ct.IsCancellationRequested) { return row; }
    }

    public async Task ValidateOrderAsync(MoomooOrder order, CancellationToken ct)
    {
        if (!ProductionVerified) throw new InvalidOperationException("Production account verification is required; sandbox/unverified accounts cannot place live orders.");
        var tokens = await GetTokensAsync(ct);
        if (!tokens.Scope.Split(' ').Contains("trade:write")) throw new InvalidOperationException("Trading permission has not been granted.");
        if (order.Side is not ("BUY" or "SELL") || order.Quantity is < 1 or > 10000 || order.LimitPrice <= 0 ||
            decimal.Round(order.LimitPrice, 4) != order.LimitPrice || order.LimitPrice * order.Quantity > 10000)
            throw new ArgumentException("Use BUY or SELL, 1–10,000 whole shares, a positive limit price with up to four decimals, and an order value of at most US$10,000.");
        var account = (await GetAccountsAsync(ct)).FirstOrDefault(a => a.GetProperty("account_id").ToString() == order.AccountId);
        if (account.ValueKind == JsonValueKind.Undefined || !account.GetProperty("enable_market").EnumerateArray().Any(m => m.GetInt32() == 2))
            throw new InvalidOperationException("Select an authorized account that supports US securities.");
        if (configuration["Moomoo:ProductionAccountId"] != order.AccountId)
            throw new InvalidOperationException("This account is not the configured verified production account.");
        NormalizeSymbol(order.Symbol);
    }

    public async Task<string> PlaceOrderAsync(MoomooOrder order, CancellationToken ct)
    {
        await ValidateOrderAsync(order, ct);
        var tokens = await GetTokensAsync(ct);
        var result = await SendRawAsync(HttpMethod.Post, $"/api/v1.0/accounts/{order.AccountId}/orders", new
        {
            code = NormalizeSymbol(order.Symbol), qty = order.Quantity.ToString(CultureInfo.InvariantCulture),
            price = order.LimitPrice.ToString(CultureInfo.InvariantCulture), side = order.Side,
            order_type = "LIMIT", time_in_force = "DAY", session = "RTH", remark = "CryptoCoinSpot user-confirmed order"
        }, tokens.AccessToken, ct);
        return result.GetProperty("d").GetProperty("order_id").ToString();
    }
}
