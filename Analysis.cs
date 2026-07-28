namespace CryptoTrader;

public static class Analysis
{
    public static HistorySummary Summarize(string coin, string currency, IReadOnlyList<Candle> daily)
    {
        if (daily.Count < 2) throw new InvalidOperationException("At least two daily candles are required.");
        var ordered = daily.OrderBy(x => x.Time).ToArray();
        var previous = ordered[^2];
        var cutoff = ordered[^1].Time.AddDays(-365);
        var year = ordered.Where(x => x.Time >= cutoff).ToArray();
        return new(
            coin.ToUpperInvariant(), currency.ToUpperInvariant(),
            DateOnly.FromDateTime(ordered[0].Time.UtcDateTime),
            DateOnly.FromDateTime(ordered[^1].Time.UtcDateTime),
            ordered.Min(x => x.Low), ordered.Max(x => x.High),
            year.Min(x => x.Low), year.Max(x => x.High),
            previous.Low, previous.High);
    }

    public static TrendResult CalculateTrend(string coin, IReadOnlyList<Candle> hourly)
    {
        if (hourly.Count < 73) throw new InvalidOperationException("At least 73 hourly candles are required.");
        var closes = hourly.OrderBy(x => x.Time).Select(x => x.Close).ToArray();
        var last = closes[^1];
        var change24 = (last / closes[^25] - 1) * 100;
        var sma24 = closes[^24..].Average();
        var sma72 = closes[^72..].Average();
        var rsi = Rsi(closes, 14);
        var score = 0;
        score += last > sma24 ? 1 : -1;
        score += sma24 > sma72 ? 1 : -1;
        score += change24 > 0 ? 1 : -1;
        score += rsi switch { > 55 and < 75 => 1, < 45 and > 25 => -1, _ => 0 };
        var trend = score switch { >= 3 => "STRONG UP", >= 1 => "UP", <= -3 => "STRONG DOWN", <= -1 => "DOWN", _ => "SIDEWAYS" };
        return new(coin.ToUpperInvariant(), last, change24, sma24, sma72, rsi, trend, score);
    }

    private static decimal Rsi(decimal[] closes, int periods)
    {
        decimal gains = 0, losses = 0;
        for (var i = closes.Length - periods; i < closes.Length; i++)
        {
            var change = closes[i] - closes[i - 1];
            if (change >= 0) gains += change; else losses -= change;
        }
        if (losses == 0) return 100;
        var rs = (gains / periods) / (losses / periods);
        return 100 - 100 / (1 + rs);
    }
}
