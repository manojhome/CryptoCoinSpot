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
        using var response = await http.GetAsync($"{PublicRoot}/latest/{NormalizeCoin(coin)}", cancellationToken);
        var json = await ReadSuccessfulJsonAsync(response, cancellationToken);
        var last = json.RootElement.GetProperty("prices").GetProperty("last");
        return last.ValueKind == JsonValueKind.String
            ? decimal.Parse(last.GetString()!, CultureInfo.InvariantCulture)
            : last.GetDecimal();
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
            .OrderByDescending(x => x.AudBalance)
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
