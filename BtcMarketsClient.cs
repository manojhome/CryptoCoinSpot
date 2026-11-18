using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Caching.Memory;

namespace CryptoTrader;

public sealed class BtcMarketsClient(HttpClient http, IConfiguration config, IMemoryCache cache)
{
    string? Key => Environment.GetEnvironmentVariable("BTCMARKETS_API_KEY") ?? config["BtcMarkets:ApiKey"];
    string? Secret => Environment.GetEnvironmentVariable("BTCMARKETS_API_SECRET") ?? config["BtcMarkets:ApiSecret"];
    public bool Configured => !string.IsNullOrWhiteSpace(Key) && !string.IsNullOrWhiteSpace(Secret);
    public bool Trading => Configured && string.Equals(Environment.GetEnvironmentVariable("BTCMARKETS_LIVE_TRADING_ENABLED") ?? config["BtcMarkets:LiveTradingEnabled"], "true", StringComparison.OrdinalIgnoreCase);
    public static decimal Number(JsonNode? node) => decimal.TryParse(node?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : 0;
    public async Task<JsonNode> Send(string path, CancellationToken ct, bool signed = false, JsonNode? body = null)
    {
        using var request = new HttpRequestMessage(body is null ? HttpMethod.Get : HttpMethod.Post, path);
        var data = body?.ToJsonString() ?? "";
        if (body is not null) request.Content = new StringContent(data, Encoding.UTF8, "application/json");
        if (signed)
        {
            if (!Configured) throw new InvalidOperationException("Configure BTCMARKETS_API_KEY and BTCMARKETS_API_SECRET on the server to load your wallet.");
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            var message = request.Method.Method + path.Split('?')[0] + timestamp + data;
            var signature = Convert.ToBase64String(HMACSHA512.HashData(Convert.FromBase64String(Secret!), Encoding.UTF8.GetBytes(message)));
            request.Headers.Add("BM-AUTH-APIKEY", Key);
            request.Headers.Add("BM-AUTH-TIMESTAMP", timestamp);
            request.Headers.Add("BM-AUTH-SIGNATURE", signature);
        }
        using var response = await http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"BTC Markets returned {(int)response.StatusCode}. Check API permissions and account status.");
        return JsonNode.Parse(await response.Content.ReadAsStringAsync(ct)) ?? throw new InvalidOperationException("Empty exchange response.");
    }
    public async Task<JsonArray> Markets(CancellationToken ct)
    {
        if (cache.TryGetValue<JsonArray>("btc-markets", out var saved)) return saved!;
        var markets = (await Send("/v3/markets", ct)).AsArray();
        cache.Set("btc-markets", markets, TimeSpan.FromMinutes(2));
        return markets;
    }
    public async Task<JsonArray> Tickers(CancellationToken ct)
    {
        if (cache.TryGetValue<JsonArray>("btc-tickers", out var saved)) return saved!;
        var markets = await Markets(ct);
        var query = string.Join("&", markets.Select(m => "marketId=" + Uri.EscapeDataString(m!["marketId"]!.ToString())));
        var tickers = (await Send("/v3/markets/tickers?" + query, ct)).AsArray();
        cache.Set("btc-tickers", tickers, TimeSpan.FromSeconds(15));
        return tickers;
    }
}

public static class BtcMarketsEndpoints
{
    public static void MapBtcMarkets(this WebApplication app)
    {
        var gate = new SemaphoreSlim(1, 1);
        var attempts = new HashSet<Guid>();
        app.MapGet("/api/btc/status", (HttpContext ctx, BtcMarketsClient client, IAntiforgery csrf) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { configured = client.Configured, trading = client.Trading, csrfToken = csrf.GetAndStoreTokens(ctx).RequestToken });
        });
        app.MapGet("/api/btc/markets", async (BtcMarketsClient client, CancellationToken ct) =>
        {
            try { return Results.Ok(await client.Tickers(ct)); }
            catch (Exception) { return Results.Json(new { error = "BTC Markets prices unavailable. Try refreshing shortly." }, statusCode: 502); }
        });
        app.MapGet("/api/btc/wallet", async (HttpContext ctx, BtcMarketsClient client, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            try { return Results.Ok(await client.Send("/v3/accounts/me/balances", ct, true)); }
            catch (Exception ex) when (ex is InvalidOperationException or FormatException) { return Results.BadRequest(new { error = ex is FormatException ? "API secret must be Base64 encoded." : ex.Message }); }
            catch { return Results.Json(new { error = "Wallet unavailable. Check exchange connectivity." }, statusCode: 502); }
        });
        app.MapPost("/api/btc/orders", async (HttpContext ctx, BtcOrder order, BtcMarketsClient client, IAntiforgery csrf) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            try { await csrf.ValidateRequestAsync(ctx); }
            catch (AntiforgeryValidationException) { return Results.BadRequest(new { error = "Refresh the page before trading." }); }
            if (!client.Trading) return Results.BadRequest(new { error = "Configure credentials and enable BTCMARKETS_LIVE_TRADING_ENABLED on the server." });
            if (order.Side is not ("Bid" or "Ask") || order.Amount <= 0 || order.Price <= 0 || order.Id == Guid.Empty)
                return Results.BadRequest(new { error = "Select a market, positive coin amount and limit price." });
            await gate.WaitAsync(ctx.RequestAborted);
            try
            {
                if (attempts.Contains(order.Id)) return Results.Conflict(new { error = "This order was already submitted. Check BTC Markets order history before trying again." });
                var market = (await client.Markets(ctx.RequestAborted)).FirstOrDefault(m => m?["marketId"]?.ToString() == order.MarketId);
                if (market is null || market["status"]?.ToString() != "Online") throw new InvalidOperationException("Select an online market.");
                var amountDecimals = (int)BtcMarketsClient.Number(market["amountDecimals"]);
                var priceDecimals = (int)BtcMarketsClient.Number(market["priceDecimals"]);
                if (amountDecimals is < 0 or > 28 || priceDecimals is < 0 or > 28 || decimal.Round(order.Amount, amountDecimals) != order.Amount || decimal.Round(order.Price, priceDecimals) != order.Price)
                    throw new InvalidOperationException($"Market allows {amountDecimals} amount decimals and {priceDecimals} price decimals.");
                if (order.Amount < BtcMarketsClient.Number(market["minOrderAmount"]) || order.Amount > BtcMarketsClient.Number(market["maxOrderAmount"]))
                    throw new InvalidOperationException("Amount is outside the market order limits.");
                var balances = (await client.Send("/v3/accounts/me/balances", ctx.RequestAborted, true)).AsArray();
                var asset = market[order.Side == "Ask" ? "baseAssetName" : "quoteAssetName"]!.ToString();
                var available = BtcMarketsClient.Number(balances.FirstOrDefault(b => b?["assetName"]?.ToString() == asset)?["available"]);
                if (available < (order.Side == "Ask" ? order.Amount : order.Amount * order.Price)) throw new InvalidOperationException("Insufficient available balance (buy fees may require additional funds).");
                attempts.Add(order.Id);
                var payload = new JsonObject { ["marketId"] = order.MarketId, ["side"] = order.Side, ["type"] = "Limit", ["timeInForce"] = "IOC", ["amount"] = order.Amount.ToString(CultureInfo.InvariantCulture), ["price"] = order.Price.ToString(CultureInfo.InvariantCulture), ["clientOrderId"] = order.Id.ToString() };
                // Never retry a submission: a lost response may still represent an accepted order.
                return Results.Ok(await client.Send("/v3/orders", ctx.RequestAborted, true, payload));
            }
            catch (InvalidOperationException ex) { return Results.BadRequest(new { error = ex.Message }); }
            catch { return Results.Json(new { error = $"Order outcome uncertain. Check BTC Markets history for client ID {order.Id} before placing another order." }, statusCode: 502); }
            finally { gate.Release(); }
        });
    }
}
public sealed record BtcOrder(string MarketId, string Side, decimal Amount, decimal Price, Guid Id);
