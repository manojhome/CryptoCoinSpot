namespace CryptoTrader;

public sealed record Candle(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close);

public sealed record HistorySummary(
    string Coin,
    string Currency,
    DateOnly From,
    DateOnly To,
    decimal PeriodLow,
    decimal PeriodHigh,
    decimal Week52Low,
    decimal Week52High,
    decimal PreviousDayLow,
    decimal PreviousDayHigh);

public sealed record TrendResult(
    string Coin,
    decimal LastPrice,
    decimal Change24HoursPercent,
    decimal Sma24,
    decimal Sma72,
    decimal Rsi14,
    string Trend,
    int Score);
