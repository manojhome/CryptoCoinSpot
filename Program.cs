using CryptoTrader;
using Microsoft.Extensions.Caching.Memory;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddUserSecrets<Program>(optional: true);
builder.Services.AddMemoryCache();
builder.Services.AddSingleton(new DailyPriceStore(
    Path.Combine(builder.Environment.ContentRootPath, "Data")));
builder.Services.AddHttpClient<MarketDataClient>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("CryptoCoinSpot/2.0");
});
builder.Services.AddHttpClient(nameof(CoinSpotClient), client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("CryptoCoinSpot/2.0");
});

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/dashboard", async (
    string coin,
    decimal amount,
    MarketDataClient market,
    DailyPriceStore dailyPrices,
    CancellationToken cancellationToken) =>
{
    try
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        if (amount <= 0 || amount > 100_000_000)
            return Results.BadRequest(new { error = "Investment amount must be between $0.01 and $100,000,000." });

        var hourly = await market.GetHourlyAsync(coin, 4, "aud", cancellationToken);
        decimal current;
        string currentPriceSource;
        try
        {
            current = await market.GetCoinSpotCurrentPriceAsync(coin, cancellationToken);
            currentPriceSource = "CoinSpot public AUD last price";
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            current = hourly[^1].Close;
            currentPriceSource = "CoinSpot-listed KuCoin market converted to AUD";
        }
        var currentPriceRetrievedAt = DateTimeOffset.UtcNow;
        IReadOnlyList<Candle> storedDaily;
        var dailySource = "permanent local file";
        try
        {
            var latestCompletedUtcDay = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1));
            var dailyLoad = await dailyPrices.GetOrRefreshAsync(
                coin,
                latestCompletedUtcDay,
                token => market.GetRecentDailyAsync(coin, 366, "aud", token),
                cancellationToken);
            storedDaily = dailyLoad.Candles;
            dailySource = dailyLoad.Updated
                ? "market provider + permanent local file"
                : "permanent local file (already current)";
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            storedDaily = await dailyPrices.GetAsync(coin, cancellationToken);
            dailySource = "permanent local file fallback";
            if (storedDaily.Count < 21) throw;
        }
        var daily = storedDaily.TakeLast(365).ToArray();
        var signal = TrxStrategy.Evaluate(coin, daily);
        var trend = Analysis.CalculateTrend(coin, hourly);
        var units = amount / current;
        var stop = signal.Support > 0 ? Math.Max(current * 0.96m, signal.Support) : current * 0.96m;

        return Results.Ok(new
        {
            coin,
            amount,
            currentPrice = current,
            currentPriceSource,
            currentPriceRetrievedAt,
            units,
            currentValue = amount,
            signal,
            trend,
            plan = new
            {
                stop,
                firstTarget = current * 1.07m,
                finalTarget = current * 1.10m,
                maxRiskAud = amount * 0.01m
            },
            hourly = hourly.Select(x => new
            {
                time = x.Time,
                x.Open,
                x.High,
                x.Low,
                x.Close,
                price = x.Close
            }),
            daily = daily.Select(x => new
            {
                time = x.Time,
                x.Open,
                x.High,
                x.Low,
                x.Close,
                x.Volume
            }),
            dailySource,
            refreshedAt = DateTimeOffset.UtcNow
        });
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/history/{coin}", async (
    string coin,
    MarketDataClient market,
    DailyPriceStore dailyPrices,
    CancellationToken cancellationToken) =>
{
    try
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        var history = await dailyPrices.GetOrBackfillAllTimeAsync(
            coin,
            token => market.GetAllDailyAsync(coin, "aud", token),
            cancellationToken);
        return Results.Ok(new
        {
            coin,
            source = history.Updated
                ? "KuCoin available history + permanent local file"
                : "permanent local all-time file",
            daily = history.Candles.Select(x => new
            {
                time = x.Time,
                x.Open,
                x.High,
                x.Low,
                x.Close,
                x.Volume
            })
        });
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/gainers", async (
    MarketDataClient market,
    Microsoft.Extensions.Caching.Memory.IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    try
    {
        var gainers = await cache.GetOrCreateAsync(
            "coinspot-top-50-gainers",
            async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(15);
                return await market.GetTopCoinSpotGainersAsync(50, cancellationToken);
            });
        return Results.Ok(new
        {
            period = "24h",
            source = "CoinSpot website coin selection and 5-minute chart history for 1-hour change; direct CoinSpot AUD prices where published; 24-hour change from matching KuCoin USDT markets",
            items = gainers ?? []
        });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/coinspot/price/{coin}", async (
    string coin,
    IHttpClientFactory factory,
    CancellationToken cancellationToken) =>
{
    try
    {
        var client = new CoinSpotClient(factory.CreateClient(nameof(CoinSpotClient)), null, null);
        var price = await client.GetPriceAsync(coin, cancellationToken);
        return Results.Ok(new { coin = coin.ToUpperInvariant(), currency = "AUD", price });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/coinspot/wallet", async (
    HttpContext context,
    IHttpClientFactory factory,
    IConfiguration configuration,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var apiKey = Environment.GetEnvironmentVariable("COINSPOT_READ_ONLY_API_KEY")
                 ?? configuration["CoinSpot:ReadOnlyApiKey"];
    var apiSecret = Environment.GetEnvironmentVariable("COINSPOT_READ_ONLY_API_SECRET")
                    ?? configuration["CoinSpot:ReadOnlyApiSecret"];
    if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(apiSecret))
        return Results.Problem(
            "Configure the CoinSpot read-only API key and secret in environment variables or appsettings.json to display your wallet.",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    try
    {
        var client = new CoinSpotClient(
            factory.CreateClient(nameof(CoinSpotClient)), apiKey, apiSecret);
        var holdings = await client.GetBalancesAsync(cancellationToken);
        return Results.Ok(new
        {
            totalAud = holdings.Sum(x => x.AudBalance),
            items = holdings,
            refreshedAt = DateTimeOffset.UtcNow
        });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.Map("/api/{**path}", () => Results.NotFound(new
{
    error = "The requested API endpoint is unavailable. Restart the app after updating it and try again."
}));
app.MapFallbackToFile("index.html");
app.Run();
