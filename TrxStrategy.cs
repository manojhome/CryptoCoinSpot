namespace CryptoTrader;

public static class TrxStrategy
{
    private static readonly decimal[] Supports = [0.440m, 0.460m, 0.465m, 0.475m, 0.480m];

    public static TrxSignal Evaluate(string coin, IReadOnlyList<Candle> daily)
    {
        if (daily.Count < 24)
            throw new InvalidOperationException("At least 24 completed daily candles are required.");

        var candles = daily.OrderBy(x => x.Time).ToArray();
        var latest = candles[^1];
        var previous = candles[^2];
        var ma20 = candles[^20..].Average(x => x.Close);
        var averageVolume = candles[^21..^1].Average(x => x.Volume);
        var aboveMa = latest.Close > ma20;
        var greenBreakout = latest.Close > latest.Open && latest.Close > previous.High;
        var aboveVolume = latest.Volume > averageVolume;

        var redDays = 0;
        for (var i = candles.Length - 2; i >= 0 && redDays < 4; i--)
        {
            if (candles[i].Close >= candles[i].Open) break;
            redDays++;
        }

        var pullbackLow = candles.Skip(Math.Max(0, candles.Length - redDays - 1))
            .Take(Math.Max(1, redDays))
            .Min(x => x.Low);
        var support = coin.Equals("TRX", StringComparison.OrdinalIgnoreCase)
            ? Supports.Where(x => x <= pullbackLow).DefaultIfEmpty(0).Max()
            : candles[^10..].Min(x => x.Low);
        var heldSupport = support > 0 && pullbackLow >= support;
        var buy = aboveMa && redDays is 2 or 3 && heldSupport && greenBreakout && aboveVolume;

        var explanation = buy
            ? $"All conditions met: above MA20, {redDays} red-day pullback held ${support:N3}, green breakout, and confirming volume."
            : $"Waiting: MA20={(aboveMa ? "yes" : "no")}, red pullback={redDays} (need 2–3), " +
              $"support={(heldSupport ? $"held ${support:N3}" : "not confirmed")}, " +
              $"green breakout={(greenBreakout ? "yes" : "no")}, volume={(aboveVolume ? "above" : "below")} average.";

        return new TrxSignal(
            buy ? "BUY SETUP" : "WAIT", explanation, latest.Close, ma20, averageVolume,
            support, redDays, aboveMa, greenBreakout, aboveVolume);
    }

    public static string EvaluateExit(
        decimal entryPrice, decimal currentPrice, decimal support, IReadOnlyList<Candle> daily)
    {
        var stop = support > 0 ? Math.Max(entryPrice * 0.96m, support) : entryPrice * 0.96m;
        if (currentPrice <= stop) return $"EXIT ALL — stop ${stop:N4} reached";
        if (currentPrice >= entryPrice * 1.10m) return "FINAL TARGET — consider exiting remaining balance";
        if (currentPrice >= entryPrice * 1.07m) return "FIRST TARGET — consider taking 50% profit";

        var ordered = daily.OrderBy(x => x.Time).ToArray();
        var twoRed = ordered.Length >= 2 &&
                     ordered[^1].Close < ordered[^1].Open &&
                     ordered[^2].Close < ordered[^2].Open;
        var ma10 = ordered[^10..].Average(x => x.Close);
        if (twoRed || ordered[^1].Close < ma10)
            return "EXIT SIGNAL — two red days or close below MA10";
        return $"HOLD — stop ${stop:N4}, first target ${entryPrice * 1.07m:N4}";
    }
}
