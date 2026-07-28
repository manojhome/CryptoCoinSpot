using System.Globalization;
using System.Text.Json;

namespace CryptoTrader;

public sealed class MarketDataClient(HttpClient http)
{
    private const string Root = "https://api.coingecko.com/api/v3";
    private static readonly IReadOnlyDictionary<string, string> Ids =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["BTC"] = "bitcoin", ["ETH"] = "ethereum", ["XRP"] = "ripple",
            ["USDT"] = "tether", ["SOL"] = "solana", ["USDC"] = "usd-coin"
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
        var id = ResolveId(coin);
        var uri = $"{Root}/coins/{id}/market_chart?vs_currency={currency.ToLowerInvariant()}&days={days}";
        using var response = await GetWithRateLimitRetryAsync(uri, cancellationToken);
        return await ParseAndAggregateAsync(response, TimeSpan.FromHours(1), cancellationToken);
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

    private static async Task<IReadOnlyList<Candle>> ParseAndAggregateAsync(
        HttpResponseMessage response, TimeSpan bucket, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Market-data provider returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        var points = json.RootElement.GetProperty("prices").EnumerateArray()
            .Select(p => (Time: DateTimeOffset.FromUnixTimeMilliseconds(p[0].GetInt64()), Price: p[1].GetDecimal()))
            .ToArray();
        if (points.Length == 0) throw new InvalidOperationException("No market data was returned.");

        long ticks = bucket.Ticks;
        return points.GroupBy(p => p.Time.UtcTicks / ticks)
            .Select(g =>
            {
                var ordered = g.OrderBy(p => p.Time).ToArray();
                return new Candle(
                    new DateTimeOffset(ordered[0].Time.UtcTicks / ticks * ticks, TimeSpan.Zero),
                    ordered[0].Price, ordered.Max(x => x.Price), ordered.Min(x => x.Price), ordered[^1].Price);
            })
            .OrderBy(c => c.Time)
            .ToArray();
    }

    private static string ResolveId(string coin) =>
        Ids.TryGetValue(CoinSpotClient.NormalizeCoin(coin), out var id)
            ? id
            : throw new ArgumentException(
                $"Historical data mapping is not configured for {coin}. Supported: {string.Join(", ", Ids.Keys)}.");
}
