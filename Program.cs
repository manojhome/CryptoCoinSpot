using CryptoTrader;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient<MarketDataClient>(client =>
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
    CancellationToken cancellationToken) =>
{
    try
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        if (amount <= 0 || amount > 100_000_000)
            return Results.BadRequest(new { error = "Investment amount must be between A$0.01 and A$100,000,000." });

        var hourly = await market.GetHourlyAsync(coin, 4, "aud", cancellationToken);
        await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        var daily = await market.GetRecentDailyAsync(coin, 45, "aud", cancellationToken);
        var signal = TrxStrategy.Evaluate(coin, daily);
        var trend = Analysis.CalculateTrend(coin, hourly);
        var current = hourly[^1].Close;
        var units = amount / current;
        var stop = signal.Support > 0 ? Math.Max(current * 0.96m, signal.Support) : current * 0.96m;

        return Results.Ok(new
        {
            coin,
            amount,
            currentPrice = current,
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
            hourly = hourly.Select(x => new { time = x.Time, price = x.Close }),
            daily = daily.Select(x => new
            {
                time = x.Time,
                x.Open,
                x.High,
                x.Low,
                x.Close,
                x.Volume
            }),
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

app.MapFallbackToFile("index.html");
app.Run();
