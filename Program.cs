using CryptoTrader;
using Microsoft.Extensions.Caching.Memory;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddUserSecrets<Program>(optional: true);
builder.Services.AddMemoryCache();
builder.Services.AddSingleton(new DailyPriceStore(
    Path.Combine(builder.Environment.ContentRootPath, "Data")));
builder.Services.AddSingleton(new TradeTransactionStore(
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
            source = "CoinSpot website coin selection; 1-hour change from CoinSpot 5-minute chart history with KuCoin 1-minute fallback; direct CoinSpot AUD prices where published; 24-hour change from matching KuCoin USDT markets",
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

app.MapGet("/api/coinspot/trading/status", (
    HttpContext context,
    IConfiguration configuration) =>
{
    context.Response.Headers.CacheControl = "no-store";
    var (apiKey, apiSecret) = GetTradingCredentials(configuration);
    var configured = !string.IsNullOrWhiteSpace(apiKey) && !string.IsNullOrWhiteSpace(apiSecret);
    var enabled = IsLiveTradingEnabled(configuration);
    return Results.Ok(new
    {
        configured,
        enabled,
        ready = configured && enabled,
        quoteOnly = configured && !enabled
    });
});

app.MapPost("/api/coinspot/trading/{side}/quote", async (
    string side,
    CoinSpotTradeRequest request,
    HttpContext context,
    IHttpClientFactory factory,
    IConfiguration configuration,
    IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    side = side.Trim().ToLowerInvariant();
    if (side is not ("buy" or "sell"))
        return Results.BadRequest(new { error = "Trade side must be buy or sell." });

    var (apiKey, apiSecret) = GetTradingCredentials(configuration);
    if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(apiSecret))
        return Results.Problem(
            "Configure the CoinSpot full-access API key and secret before requesting live quotes.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    try
    {
        var coin = CoinSpotClient.NormalizeCoin(request.Coin);
        var amountType = request.AmountType.Trim().ToLowerInvariant();
        var client = new CoinSpotClient(factory.CreateClient(nameof(CoinSpotClient)), apiKey, apiSecret);
        using var quoteJson = side == "buy"
            ? await client.GetBuyQuoteAsync(coin, request.Amount, amountType, cancellationToken)
            : await client.GetSellQuoteAsync(coin, request.Amount, amountType, cancellationToken);
        var rate = ReadJsonDecimal(quoteJson.RootElement.GetProperty("rate"));
        var expiresAt = DateTimeOffset.UtcNow.AddSeconds(60);
        var quoteToken = Guid.NewGuid().ToString("N");
        var quote = new CoinSpotTradeQuote(
            side, coin, request.Amount, amountType, rate, expiresAt);
        cache.Set($"coinspot-live-quote:{quoteToken}", quote, expiresAt);

        return Results.Ok(new
        {
            quoteToken,
            side,
            coin,
            amount = request.Amount,
            amountType,
            rate,
            expiresAt,
            executionEnabled = IsLiveTradingEnabled(configuration)
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

app.MapPost("/api/coinspot/trading/{side}/execute", async (
    string side,
    CoinSpotTradeRequest request,
    HttpContext context,
    IHttpClientFactory factory,
    IConfiguration configuration,
    IMemoryCache cache,
    TradeTransactionStore tradeTransactions,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    side = side.Trim().ToLowerInvariant();
    if (side is not ("buy" or "sell"))
        return Results.BadRequest(new { error = "Trade side must be buy or sell." });
    if (!IsLiveTradingEnabled(configuration))
        return Results.Problem(
            "Live trading is disabled. Set CoinSpot:LiveTradingEnabled to true only when you intend to place real orders.",
            statusCode: StatusCodes.Status403Forbidden);

    var (apiKey, apiSecret) = GetTradingCredentials(configuration);
    if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(apiSecret))
        return Results.Problem(
            "Configure the CoinSpot full-access API key and secret before live trading.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    try
    {
        var coin = CoinSpotClient.NormalizeCoin(request.Coin);
        var amountType = request.AmountType.Trim().ToLowerInvariant();
        var expectedConfirmation = $"LIVE {side.ToUpperInvariant()} {coin}";
        if (!string.Equals(request.Confirmation, expectedConfirmation, StringComparison.Ordinal))
            return Results.BadRequest(new { error = $"Confirmation must exactly match {expectedConfirmation}." });
        if (string.IsNullOrWhiteSpace(request.QuoteToken) ||
            !cache.TryGetValue<CoinSpotTradeQuote>(
                $"coinspot-live-quote:{request.QuoteToken}", out var quote) || quote is null)
            return Results.BadRequest(new { error = "The live quote is missing, expired, or already used. Request a new quote." });
        if (!string.Equals(quote.Side, side, StringComparison.Ordinal) ||
            !string.Equals(quote.Coin, coin, StringComparison.Ordinal) ||
            quote.Amount != request.Amount ||
            !string.Equals(quote.AmountType, amountType, StringComparison.Ordinal))
            return Results.BadRequest(new { error = "The execution request does not match the live quote." });

        // Consume before sending the order so double-clicks and retries cannot reuse it.
        cache.Remove($"coinspot-live-quote:{request.QuoteToken}");
        var client = new CoinSpotClient(factory.CreateClient(nameof(CoinSpotClient)), apiKey, apiSecret);
        using var orderJson = side == "buy"
            ? await client.BuyNowAsync(coin, request.Amount, amountType, quote.Rate, 1m, cancellationToken)
            : await client.SellNowAsync(coin, request.Amount, amountType, quote.Rate, 1m, cancellationToken);

        var orderRoot = orderJson.RootElement;
        var coinAmount = ReadOptionalJsonDecimal(orderRoot, "amount")
            ?? (amountType == "coin" ? request.Amount : request.Amount / quote.Rate);
        var totalAud = ReadOptionalJsonDecimal(orderRoot, "total")
            ?? (amountType == "aud" ? request.Amount : coinAmount * quote.Rate);
        var executionRate = ReadOptionalJsonDecimal(orderRoot, "rate")
            ?? (coinAmount > 0 ? totalAud / coinAmount : quote.Rate);
        var market = orderRoot.TryGetProperty("market", out var marketElement)
            ? marketElement.GetString() ?? $"{coin}/AUD"
            : $"{coin}/AUD";
        var orderId = orderRoot.TryGetProperty("id", out var idElement)
            ? idElement.ToString()
            : Guid.NewGuid().ToString("N");
        var transaction = new LiveTradeTransaction(
            orderId,
            DateTimeOffset.UtcNow,
            side,
            coin,
            market,
            coinAmount,
            totalAud,
            executionRate,
            quote.Rate,
            Math.Round(totalAud * 0.01m, 8));
        var transactionRecorded = true;
        string? persistenceWarning = null;
        try
        {
            // Persist independently of the disconnected request after CoinSpot confirms execution.
            await tradeTransactions.AddAsync(transaction, CancellationToken.None);
        }
        catch (Exception persistenceException)
        {
            transactionRecorded = false;
            persistenceWarning =
                $"The CoinSpot order succeeded, but the local transaction file could not be updated: {persistenceException.Message}";
        }

        return Results.Ok(new
        {
            side,
            coin,
            order = orderJson.RootElement.Clone(),
            executedAt = transaction.ExecutedAt,
            transactionRecorded,
            persistenceWarning
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

app.MapGet("/api/coinspot/trading/transactions", async (
    HttpContext context,
    TradeTransactionStore tradeTransactions,
    CancellationToken cancellationToken) =>
{
    context.Response.Headers.CacheControl = "no-store";
    try
    {
        var transactions = await tradeTransactions.GetAsync(cancellationToken);
        return Results.Ok(new
        {
            file = "Data/live-trades.json",
            items = transactions.OrderByDescending(x => x.ExecutedAt)
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

static (string? ApiKey, string? ApiSecret) GetTradingCredentials(IConfiguration configuration) =>
    (Environment.GetEnvironmentVariable("COINSPOT_API_KEY") ?? configuration["CoinSpot:ApiKey"],
     Environment.GetEnvironmentVariable("COINSPOT_API_SECRET") ?? configuration["CoinSpot:ApiSecret"]);

static bool IsLiveTradingEnabled(IConfiguration configuration)
{
    var environmentValue = Environment.GetEnvironmentVariable("COINSPOT_LIVE_TRADING_ENABLED");
    return bool.TryParse(environmentValue, out var enabled)
        ? enabled
        : configuration.GetValue<bool>("CoinSpot:LiveTradingEnabled");
}

static decimal ReadJsonDecimal(System.Text.Json.JsonElement value) =>
    value.ValueKind == System.Text.Json.JsonValueKind.String
        ? decimal.Parse(value.GetString()!, System.Globalization.CultureInfo.InvariantCulture)
        : value.GetDecimal();

static decimal? ReadOptionalJsonDecimal(System.Text.Json.JsonElement root, string propertyName)
{
    if (!root.TryGetProperty(propertyName, out var value) ||
        value.ValueKind is System.Text.Json.JsonValueKind.Null or System.Text.Json.JsonValueKind.Undefined)
        return null;
    return ReadJsonDecimal(value);
}
