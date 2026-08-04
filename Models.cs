namespace CryptoTrader;

public sealed record Candle(
    DateTimeOffset Time,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    decimal Volume = 0);

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

public sealed record TrxSignal(
    string Action,
    string Explanation,
    decimal Price,
    decimal MovingAverage20,
    decimal AverageVolume20,
    decimal Support,
    int PullbackRedDays,
    bool IsAboveMovingAverage,
    bool HasGreenBreakout,
    bool HasAboveAverageVolume);

public sealed record MarketGainer(
    int Rank,
    string Coin,
    string Name,
    decimal PriceAud,
    decimal Change24HoursPercent);

public sealed record WalletHolding(
    string Coin,
    decimal Balance,
    decimal AudBalance,
    decimal RateAud);
