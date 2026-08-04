using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CryptoTrader;

public sealed class MarketDataClient(HttpClient http)
{
    private const string KuCoinRoot = "https://api.kucoin.com/api/v1";
    private static readonly IReadOnlyDictionary<string, string> Ids =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["BTC"] = "bitcoin", ["ETH"] = "ethereum", ["XRP"] = "ripple",
            ["USDT"] = "tether", ["SOL"] = "solana", ["USDC"] = "usd-coin",
            ["TRX"] = "tron"
        };

    public async Task<IReadOnlyList<Candle>> GetDailyAsync(
        string coin, int years, string currency, CancellationToken cancellationToken)
    {
        if (years is < 1 or > 10) throw new ArgumentOutOfRangeException(nameof(years));
        if (!currency.Equals("usd", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Five-year history currently supports --currency usd.");
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        ResolveId(symbol);
        var to = DateTimeOffset.UtcNow;
        var from = to.AddYears(-years);
        var candles = new Dictionary<long, Candle>();

        // Coinbase Exchange returns at most 300 candles, so fetch 290-day windows.
        for (var start = from; start < to; start = start.AddDays(290))
        {
            var end = start.AddDays(290) < to ? start.AddDays(290) : to;
            var uri = "https://api.exchange.coinbase.com/products/" +
                      $"{symbol}-USD/candles?granularity=86400&start={Uri.EscapeDataString(start.ToString("O"))}" +
                      $"&end={Uri.EscapeDataString(end.ToString("O"))}";
            using var response = await http.GetAsync(uri, cancellationToken);
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Coinbase market data returned {(int)response.StatusCode}: {text}");
            using var json = JsonDocument.Parse(text);
            foreach (var row in json.RootElement.EnumerateArray())
            {
                // Coinbase candle order: time, low, high, open, close, volume.
                var time = DateTimeOffset.FromUnixTimeSeconds(row[0].GetInt64());
                candles[time.ToUnixTimeSeconds()] =
                    new Candle(time, row[3].GetDecimal(), row[2].GetDecimal(), row[1].GetDecimal(), row[4].GetDecimal());
            }
        }
        if (candles.Count == 0) throw new InvalidOperationException($"No {symbol}-USD daily candles were returned.");
        return candles.Values.OrderBy(x => x.Time).ToArray();
    }

    public async Task<IReadOnlyList<Candle>> GetHourlyAsync(
        string coin, int days, string currency, CancellationToken cancellationToken)
    {
        if (days is < 4 or > 90) throw new ArgumentOutOfRangeException(nameof(days));
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        return await GetKuCoinCandlesAsync(
            symbol, "1hour", DateTimeOffset.UtcNow.AddDays(-days), currency, cancellationToken);
    }

    public async Task<IReadOnlyList<Candle>> GetRecentDailyAsync(
        string coin, int days, string currency, CancellationToken cancellationToken)
    {
        if (days is < 21 or > 365) throw new ArgumentOutOfRangeException(nameof(days));
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        var candles = await GetKuCoinCandlesAsync(
            symbol, "1day", DateTimeOffset.UtcNow.AddDays(-days), currency, cancellationToken);
        var todayUtc = DateTimeOffset.UtcNow.Date;
        return candles.Where(x => x.Time.UtcDateTime.Date < todayUtc)
            .ToArray();
    }

    public async Task<IReadOnlyList<MarketGainer>> GetTopCoinSpotGainersAsync(
        int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 50) throw new ArgumentOutOfRangeException(nameof(limit));

        using var sitemapResponse = await http.GetAsync(
            "https://www.coinspot.com.au/sitemap.xml", cancellationToken);
        var sitemap = await sitemapResponse.Content.ReadAsStringAsync(cancellationToken);
        if (!sitemapResponse.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot listing returned {(int)sitemapResponse.StatusCode}.");
        var listed = Regex.Matches(
                sitemap,
                @"https://www\.coinspot\.com\.au/chart/([^<]+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            .Select(x => Uri.UnescapeDataString(x.Groups[1].Value).ToUpperInvariant())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var audPerUsdt = await GetCoinSpotPriceAsync("USDT", cancellationToken);

        using var response = await GetWithRateLimitRetryAsync(
            $"{KuCoinRoot}/market/allTickers", cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"KuCoin market data returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        ThrowIfKuCoinError(json.RootElement);
        var candidates = new List<(string Coin, string Name, decimal Price, decimal Change)>();
        foreach (var item in json.RootElement.GetProperty("data").GetProperty("ticker").EnumerateArray())
        {
            var market = item.GetProperty("symbol").GetString();
            if (market is null || !market.EndsWith("-USDT", StringComparison.OrdinalIgnoreCase)) continue;
            var symbol = market[..^5].ToUpperInvariant();
            if (!listed.Contains(symbol) ||
                !item.TryGetProperty("changeRate", out var changeElement) ||
                !item.TryGetProperty("last", out var lastElement)) continue;
            var change = ReadDecimal(changeElement) * 100m;
            var price = ReadDecimal(lastElement) * audPerUsdt;
            candidates.Add((symbol, symbol, price, change));
        }

        return candidates
            .GroupBy(x => x.Coin, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.First())
            .OrderByDescending(x => x.Change)
            .Take(limit)
            .Select((x, index) => new MarketGainer(index + 1, x.Coin, x.Name, x.Price, x.Change))
            .ToArray();
    }

    private async Task<HttpResponseMessage> GetWithRateLimitRetryAsync(
        string uri, CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            var response = await http.GetAsync(uri, cancellationToken);
            if ((int)response.StatusCode != 429 || attempt >= 4) return response;
            response.Dispose();
            await Task.Delay(TimeSpan.FromSeconds(5 * (attempt + 1)), cancellationToken);
        }
    }

    private async Task<IReadOnlyList<Candle>> GetKuCoinCandlesAsync(
        string coin, string type, DateTimeOffset start, string currency,
        CancellationToken cancellationToken)
    {
        var quote = currency.ToUpperInvariant();
        if (quote is not ("AUD" or "USD" or "USDT"))
            throw new ArgumentException("KuCoin dashboard candles support AUD, USD or USDT.");
        var market = coin.Equals("USDT", StringComparison.OrdinalIgnoreCase)
            ? "USDT-USDC"
            : $"{coin}-USDT";
        var end = DateTimeOffset.UtcNow;
        var uri = $"{KuCoinRoot}/market/candles?type={type}&symbol={market}" +
                  $"&startAt={start.ToUnixTimeSeconds()}&endAt={end.ToUnixTimeSeconds()}";
        using var response = await GetWithRateLimitRetryAsync(uri, cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"KuCoin returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        ThrowIfKuCoinError(json.RootElement);
        var multiplier = quote == "AUD"
            ? await GetCoinSpotPriceAsync("USDT", cancellationToken)
            : 1m;
        var candles = json.RootElement.GetProperty("data").EnumerateArray()
            .Select(x => new Candle(
                DateTimeOffset.FromUnixTimeSeconds(long.Parse(x[0].GetString()!, CultureInfo.InvariantCulture)),
                ReadDecimal(x[1]) * multiplier,
                ReadDecimal(x[3]) * multiplier,
                ReadDecimal(x[4]) * multiplier,
                ReadDecimal(x[2]) * multiplier,
                ReadDecimal(x[6]) * multiplier))
            .Where(x => x.Close > 0)
            .OrderBy(x => x.Time)
            .ToArray();
        if (candles.Length == 0) throw new InvalidOperationException($"KuCoin returned no candles for {market}.");
        return candles;
    }

    private async Task<decimal> GetCoinSpotPriceAsync(string coin, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(
            $"https://www.coinspot.com.au/pubapi/v2/latest/{coin}", cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        return ReadDecimal(json.RootElement.GetProperty("prices").GetProperty("last"));
    }

    private static void ThrowIfKuCoinError(JsonElement root)
    {
        if (root.TryGetProperty("code", out var code) && code.GetString() == "200000") return;
        var message = root.TryGetProperty("msg", out var value) ? value.GetString() : "Unknown provider error.";
        throw new HttpRequestException($"KuCoin error: {message}");
    }

    private static decimal ReadDecimal(JsonElement value) =>
        value.ValueKind == JsonValueKind.String
            ? decimal.Parse(value.GetString()!, CultureInfo.InvariantCulture)
            : value.GetDecimal();

    private static string ResolveId(string coin) =>
        Ids.TryGetValue(CoinSpotClient.NormalizeCoin(coin), out var id)
            ? id
            : throw new ArgumentException(
                $"Historical data mapping is not configured for {coin}. Supported: {string.Join(", ", Ids.Keys)}.");
}
