using System.Globalization;
using System.Text.Json;
using CryptoTrader;

var cancellation = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancellation.Cancel(); };

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
http.DefaultRequestHeaders.UserAgent.ParseAdd("CryptoTrader/1.0");
var coinSpot = new CoinSpotClient(
    http,
    Environment.GetEnvironmentVariable("COINSPOT_API_KEY"),
    Environment.GetEnvironmentVariable("COINSPOT_API_SECRET"));
var market = new MarketDataClient(http);

try
{
    if (args.Length == 0) { Help(); return 1; }
    var command = args[0].ToLowerInvariant();
    switch (command)
    {
        case "price":
            Require(2);
            Console.WriteLine($"{args[1].ToUpperInvariant()}/AUD: {await coinSpot.GetPriceAsync(args[1], cancellation.Token):N8}");
            break;
        case "history":
            Require(2);
            var years = IntOption("--years", 5);
            var currency = Option("--currency", "usd");
            var daily = await market.GetDailyAsync(args[1], years, currency, cancellation.Token);
            PrintHistory(Analysis.Summarize(args[1], currency, daily));
            if (Has("--csv")) WriteCsv(args[1], daily);
            break;
        case "trend":
            var coins = args.Length > 1 && !args[1].StartsWith("--", StringComparison.Ordinal)
                ? args[1].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                : ["BTC", "ETH", "XRP", "USDT", "SOL", "USDC"];
            var trendCurrency = Option("--currency", "aud");
            for (var i = 0; i < coins.Length; i++)
            {
                var coin = coins[i];
                var hourly = await market.GetHourlyAsync(coin, 4, trendCurrency, cancellation.Token);
                PrintTrend(Analysis.CalculateTrend(coin, hourly));
                if (i < coins.Length - 1) await Task.Delay(TimeSpan.FromSeconds(3), cancellation.Token);
            }
            break;
        case "quote-buy":
        case "quote-sell":
        case "buy":
        case "sell":
            Require(3);
            var amount = decimal.Parse(args[2], CultureInfo.InvariantCulture);
            var amountType = Option("--amount-type", command.Contains("sell") ? "coin" : "aud");
            var isLive = command is "buy" or "sell";
            if (isLive && !Has("--confirm-live"))
                throw new InvalidOperationException("Live order blocked. Review a quote, then add --confirm-live.");
            using (var result = command switch
            {
                "quote-buy" => await coinSpot.GetBuyQuoteAsync(args[1], amount, amountType, cancellation.Token),
                "quote-sell" => await coinSpot.GetSellQuoteAsync(args[1], amount, amountType, cancellation.Token),
                "buy" => await coinSpot.BuyNowAsync(args[1], amount, amountType, cancellation.Token),
                _ => await coinSpot.SellNowAsync(args[1], amount, amountType, cancellation.Token)
            })
                Console.WriteLine(JsonSerializer.Serialize(result.RootElement, new JsonSerializerOptions { WriteIndented = true }));
            break;
        default:
            Help();
            return 1;
    }
    return 0;
}
catch (OperationCanceledException) { Console.Error.WriteLine("Cancelled."); return 130; }
catch (Exception ex) { Console.Error.WriteLine($"Error: {ex.Message}"); return 2; }

void Require(int count)
{
    if (args.Length < count) throw new ArgumentException("Missing arguments. Run without arguments for help.");
}
bool Has(string name) => args.Contains(name, StringComparer.OrdinalIgnoreCase);
string Option(string name, string fallback)
{
    var i = Array.FindIndex(args, x => x.Equals(name, StringComparison.OrdinalIgnoreCase));
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
}
int IntOption(string name, int fallback) => int.Parse(Option(name, fallback.ToString(CultureInfo.InvariantCulture)), CultureInfo.InvariantCulture);
void PrintHistory(HistorySummary x)
{
    Console.WriteLine($"{x.Coin}/{x.Currency} history {x.From} to {x.To}");
    Console.WriteLine($"Period low/high:      {x.PeriodLow:N8} / {x.PeriodHigh:N8}");
    Console.WriteLine($"52-week low/high:     {x.Week52Low:N8} / {x.Week52High:N8}");
    Console.WriteLine($"Previous day low/high:{x.PreviousDayLow:N8} / {x.PreviousDayHigh:N8}");
}
void PrintTrend(TrendResult x) =>
    Console.WriteLine($"{x.Coin,-5} {x.Trend,-12} score {x.Score,2} | last {x.LastPrice,14:N8} | 24h {x.Change24HoursPercent,7:N2}% | SMA24 {x.Sma24,12:N6} | SMA72 {x.Sma72,12:N6} | RSI14 {x.Rsi14,6:N2}");
void WriteCsv(string coin, IReadOnlyList<Candle> candles)
{
    var path = Path.GetFullPath($"{coin.ToUpperInvariant()}-daily.csv");
    using var writer = new StreamWriter(path);
    writer.WriteLine("utc_date,open,high,low,close");
    foreach (var x in candles)
        writer.WriteLine(string.Join(",", x.Time.ToString("yyyy-MM-dd"), x.Open.ToString(CultureInfo.InvariantCulture),
            x.High.ToString(CultureInfo.InvariantCulture), x.Low.ToString(CultureInfo.InvariantCulture),
            x.Close.ToString(CultureInfo.InvariantCulture)));
    Console.WriteLine($"CSV: {path}");
}
void Help()
{
    Console.WriteLine("""
CryptoTrader
  dotnet run -- price BTC
  dotnet run -- history BTC [--years 5] [--currency usd] [--csv]
  dotnet run -- trend [BTC,ETH,XRP,USDT,SOL,USDC] [--currency aud]
  dotnet run -- quote-buy BTC 100 --amount-type aud
  dotnet run -- buy BTC 100 --amount-type aud --confirm-live
  dotnet run -- quote-sell BTC 0.001 --amount-type coin
  dotnet run -- sell BTC 0.001 --amount-type coin --confirm-live
""");
}
