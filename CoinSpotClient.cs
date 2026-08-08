using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CryptoTrader;

public sealed class CoinSpotClient(HttpClient http, string? apiKey, string? apiSecret)
{
    private const string ApiRoot = "https://www.coinspot.com.au/api/v2";
    private const string ReadOnlyRoot = "https://www.coinspot.com.au/api/v2/ro";
    private const string PublicRoot = "https://www.coinspot.com.au/pubapi/v2";
    private static long _lastNonce;

    public async Task<decimal> GetPriceAsync(string coin, CancellationToken cancellationToken)
    {
        var symbol = NormalizeCoin(coin);
        using (var response = await http.GetAsync($"{PublicRoot}/latest/{symbol}", cancellationToken))
        using (var json = await ReadSuccessfulJsonAsync(response, cancellationToken))
        {
            if (TryReadMarketLast(json.RootElement, symbol, out var price)) return price;
        }

        // Some CoinSpot-listed markets return an empty or keyed object from the
        // per-coin route. The complete public ticker list includes those markets.
        using var allResponse = await http.GetAsync($"{PublicRoot}/latest", cancellationToken);
        using var allJson = await ReadSuccessfulJsonAsync(allResponse, cancellationToken);
        if (TryReadMarketLast(allJson.RootElement, symbol, out var fallbackPrice))
            return fallbackPrice;
        throw new InvalidOperationException($"CoinSpot returned no current AUD price for {symbol}.");
    }

    private static bool TryReadMarketLast(JsonElement root, string coin, out decimal price)
    {
        price = 0;
        if (!root.TryGetProperty("prices", out var prices) || prices.ValueKind != JsonValueKind.Object)
            return false;
        if (prices.TryGetProperty("last", out var directLast))
        {
            price = ReadDecimal(directLast);
            return price > 0;
        }

        foreach (var market in prices.EnumerateObject())
        {
            if (!market.Name.Equals(coin, StringComparison.OrdinalIgnoreCase) ||
                market.Value.ValueKind != JsonValueKind.Object ||
                !market.Value.TryGetProperty("last", out var marketLast)) continue;
            price = ReadDecimal(marketLast);
            return price > 0;
        }
        return false;
    }

    public Task<JsonDocument> GetBuyQuoteAsync(string coin, decimal amount, string amountType, CancellationToken ct) =>
        PostPrivateAsync("/quote/buy/now", Fields(coin, amount, amountType), ct);

    public Task<JsonDocument> GetSellQuoteAsync(string coin, decimal amount, string amountType, CancellationToken ct) =>
        PostPrivateAsync("/quote/sell/now", Fields(coin, amount, amountType), ct);

    public Task<JsonDocument> BuyNowAsync(
        string coin, decimal amount, string amountType, decimal quotedRate, decimal threshold,
        CancellationToken ct) =>
        PostPrivateAsync("/my/buy/now", TradeFields(coin, amount, amountType, quotedRate, threshold), ct);

    public Task<JsonDocument> SellNowAsync(
        string coin, decimal amount, string amountType, decimal quotedRate, decimal threshold,
        CancellationToken ct) =>
        PostPrivateAsync("/my/sell/now", TradeFields(coin, amount, amountType, quotedRate, threshold), ct);

    public async Task<IReadOnlyList<WalletHolding>> GetBalancesAsync(CancellationToken cancellationToken)
    {
        using var json = await PostAuthenticatedAsync(
            ReadOnlyRoot, "/my/balances", new Dictionary<string, string>(), cancellationToken);
        return json.RootElement.GetProperty("balances").EnumerateArray()
            .SelectMany(item => item.EnumerateObject().Select(entry =>
            {
                var value = entry.Value;
                return new WalletHolding(
                    entry.Name.ToUpperInvariant(),
                    ReadDecimal(value.GetProperty("balance")),
                    ReadDecimal(value.GetProperty("audbalance")),
                    ReadDecimal(value.GetProperty("rate")));
            }))
            .Where(x => x.Balance > 0 || x.AudBalance > 0)
            .OrderByDescending(x => x.Coin == "AUD")
            .ThenByDescending(x => x.AudBalance)
            .ToArray();
    }

    private static Dictionary<string, string> Fields(string coin, decimal amount, string amountType)
    {
        amountType = amountType.ToLowerInvariant();
        if (amount <= 0) throw new ArgumentOutOfRangeException(nameof(amount), "Amount must be positive.");
        if (amountType is not ("coin" or "aud")) throw new ArgumentException("Amount type must be 'coin' or 'aud'.");
        return new()
        {
            ["cointype"] = NormalizeCoin(coin),
            ["amount"] = amount.ToString(CultureInfo.InvariantCulture),
            ["amounttype"] = amountType
        };
    }

    private static Dictionary<string, string> TradeFields(
        string coin, decimal amount, string amountType, decimal quotedRate, decimal threshold)
    {
        if (quotedRate <= 0) throw new ArgumentOutOfRangeException(nameof(quotedRate));
        if (threshold is < 0 or > 1000) throw new ArgumentOutOfRangeException(nameof(threshold));
        var fields = Fields(coin, amount, amountType);
        fields["rate"] = quotedRate.ToString(CultureInfo.InvariantCulture);
        fields["threshold"] = threshold.ToString(CultureInfo.InvariantCulture);
        return fields;
    }

    private async Task<JsonDocument> PostPrivateAsync(
        string path,
        Dictionary<string, string> fields,
        CancellationToken cancellationToken) =>
        await PostAuthenticatedAsync(ApiRoot, path, fields, cancellationToken);

    private async Task<JsonDocument> PostAuthenticatedAsync(
        string root,
        string path,
        Dictionary<string, string> fields,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(apiSecret))
            throw new InvalidOperationException(
                "Set COINSPOT_API_KEY and COINSPOT_API_SECRET environment variables.");

        fields["nonce"] = NextNonce().ToString(CultureInfo.InvariantCulture);
        var body = JsonSerializer.Serialize(fields);
        var signature = Convert.ToHexString(
            HMACSHA512.HashData(Encoding.UTF8.GetBytes(apiSecret), Encoding.UTF8.GetBytes(body)))
            .ToLowerInvariant();

        using var request = new HttpRequestMessage(HttpMethod.Post, root + path);
        request.Headers.Add("key", apiKey);
        request.Headers.Add("sign", signature);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(body, Encoding.UTF8, "application/json");

        using var response = await http.SendAsync(request, cancellationToken);
        return await ReadSuccessfulJsonAsync(response, cancellationToken);
    }

    private static decimal ReadDecimal(JsonElement value) =>
        value.ValueKind == JsonValueKind.String
            ? decimal.Parse(value.GetString()!, CultureInfo.InvariantCulture)
            : value.GetDecimal();

    private static long NextNonce()
    {
        while (true)
        {
            var current = Interlocked.Read(ref _lastNonce);
            var candidate = Math.Max(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), current + 1);
            if (Interlocked.CompareExchange(ref _lastNonce, candidate, current) == current) return candidate;
        }
    }

    private static async Task<JsonDocument> ReadSuccessfulJsonAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot returned {(int)response.StatusCode}: {text}");

        var json = JsonDocument.Parse(text);
        if (json.RootElement.TryGetProperty("status", out var status) &&
            !string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase))
        {
            var message = json.RootElement.TryGetProperty("message", out var m) ? m.GetString() : text;
            json.Dispose();
            throw new InvalidOperationException($"CoinSpot error: {message}");
        }
        return json;
    }

    public static string NormalizeCoin(string coin)
    {
        var normalized = coin.Trim().ToUpperInvariant();
        if (normalized.Length is < 2 or > 10 || normalized.Any(c => !char.IsLetterOrDigit(c)))
            throw new ArgumentException("Coin must be a ticker such as BTC, ETH or XRP.");
        return normalized;
    }
}
