using CryptoTrader;
using Microsoft.Extensions.Caching.Memory;
using System.Security.Cryptography;
using System.Text;

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
const string sitePassword = "TEST1234789!";
const string accessCookieName = "CryptoCoinSpotAccess";
var accessSessionToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

app.Use(async (context, next) =>
{
    if (context.Request.Path.StartsWithSegments("/access"))
    {
        context.Response.Headers.CacheControl = "no-store";
        await next();
        return;
    }

    var granted = context.Request.Cookies.TryGetValue(accessCookieName, out var suppliedToken) &&
                  string.Equals(suppliedToken, accessSessionToken, StringComparison.Ordinal);
    if (granted)
    {
        await next();
        return;
    }

    if (context.Request.Path.StartsWithSegments("/api"))
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "Access Denied" });
        return;
    }

    context.Response.Redirect("/access/login");
});

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        if (context.File.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase) ||
            context.File.Name.EndsWith(".js", StringComparison.OrdinalIgnoreCase) ||
            context.File.Name.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
        {
            context.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
            context.Context.Response.Headers.Pragma = "no-cache";
            context.Context.Response.Headers.Expires = "0";
        }
    }
});

app.MapGet("/access/login", (HttpContext context) =>
{
    var alreadyGranted = context.Request.Cookies.TryGetValue(accessCookieName, out var suppliedToken) &&
                         string.Equals(suppliedToken, accessSessionToken, StringComparison.Ordinal);
    return alreadyGranted
        ? Results.Redirect("/")
        : Results.Content(AccessPage(false), "text/html; charset=utf-8", Encoding.UTF8);
});

app.MapPost("/access/login", async (HttpContext context) =>
{
    var form = await context.Request.ReadFormAsync(context.RequestAborted);
    if (!string.Equals(form["password"], sitePassword, StringComparison.Ordinal))
        return Results.Content(
            AccessPage(true),
            "text/html; charset=utf-8",
            Encoding.UTF8,
            StatusCodes.Status401Unauthorized);

    context.Response.Cookies.Append(accessCookieName, accessSessionToken, new CookieOptions
    {
        HttpOnly = true,
        IsEssential = true,
        SameSite = SameSiteMode.Strict,
        Secure = context.Request.IsHttps,
        Path = "/"
    });
    return Results.Redirect("/");
});

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
        var latestCompletedUtcDay = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-1));
        var history = await dailyPrices.GetOrRefreshFiveYearsAsync(
            coin,
            latestCompletedUtcDay,
            token => market.GetFiveYearDailyAsync(coin, "aud", token),
            token => market.GetRecentDailyAsync(coin, 32, "aud", token),
            cancellationToken);
        return Results.Ok(new
        {
            coin,
            source = history.Updated
                ? "KuCoin five-year history + permanent local file"
                : "permanent local five-year file",
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

app.MapGet("/api/intraday/{coin}", async (
    string coin,
    MarketDataClient market,
    CancellationToken cancellationToken) =>
{
    try
    {
        var result = await market.GetThreeHourCandlesAsync(coin, "aud", cancellationToken);
        return Results.Ok(new
        {
            coin = CoinSpotClient.NormalizeCoin(coin),
            periodHours = 3,
            intervalMinutes = 5,
            source = result.Source,
            candles = result.Candles.Select(x => new
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

app.MapGet("/api/market/{coin}/24h", async (
    string coin,
    MarketDataClient market,
    CancellationToken cancellationToken) =>
{
    try
    {
        var result = await market.GetTwentyFourHourCandlesAsync(coin, "aud", cancellationToken);
        return Results.Ok(new
        {
            coin = CoinSpotClient.NormalizeCoin(coin),
            periodHours = 24,
            intervalMinutes = 15,
            source = result.Source,
            candles = result.Candles.Select(x => new
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

app.MapGet("/api/gainers", async (
    MarketDataClient market,
    Microsoft.Extensions.Caching.Memory.IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    try
    {
        var gainers = await cache.GetOrCreateAsync(
            "coinspot-top-50-gainers-v3",
            async entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(15);
                return await market.GetTopCoinSpotGainersAsync(50, cancellationToken);
            });
        return Results.Ok(new
        {
            period = "24h",
            source = "CoinSpot website coin selection; ranked high-to-low by the average of 24-hour, previous-day and day-before percentage changes; completed daily close-to-close changes from KuCoin daily candles; 1-hour change from CoinSpot 5-minute chart history with KuCoin 1-minute fallback; direct CoinSpot AUD prices where published; 24-hour change from matching KuCoin USDT markets",
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
        var normalizedAmount = side == "sell" && amountType == "coin"
            ? decimal.Round(request.Amount, 8, MidpointRounding.ToNegativeInfinity)
            : request.Amount;
        if (normalizedAmount <= 0)
            return Results.BadRequest(new { error = "Trade amount must be positive after coin precision is applied." });
        var client = new CoinSpotClient(factory.CreateClient(nameof(CoinSpotClient)), apiKey, apiSecret);
        using var quoteJson = side == "buy"
            ? await client.GetBuyQuoteAsync(coin, normalizedAmount, amountType, cancellationToken)
            : await client.GetSellQuoteAsync(coin, normalizedAmount, amountType, cancellationToken);
        var rate = ReadJsonDecimal(quoteJson.RootElement.GetProperty("rate"));
        var expiresAt = DateTimeOffset.UtcNow.AddSeconds(60);
        var quoteToken = Guid.NewGuid().ToString("N");
        var quote = new CoinSpotTradeQuote(
            side, coin, normalizedAmount, amountType, rate, expiresAt);
        cache.Set($"coinspot-live-quote:{quoteToken}", quote, expiresAt);

        return Results.Ok(new
        {
            quoteToken,
            side,
            coin,
            amount = normalizedAmount,
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

static string AccessPage(bool denied) => $$"""
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CryptoCoinSpot access</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; color: #10201b; background: radial-gradient(circle at 75% 10%, rgba(200,240,108,.34), transparent 24rem), #f4f5ef; }
    main { width: min(430px, calc(100% - 32px)); padding: 34px; background: white; border: 1px solid #dce2da; border-radius: 18px; box-shadow: 0 18px 45px rgba(16,32,27,.14); }
    p { margin: 0 0 10px; color: #08734a; font: 800 11px/1.2 ui-monospace, Consolas, monospace; letter-spacing: .14em; }
    h1 { margin: 0 0 10px; font-size: 32px; letter-spacing: -.04em; }
    .hint { margin: 0 0 22px; color: #64736e; font: 400 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
    label { display: grid; gap: 8px; color: #64736e; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    input { width: 100%; height: 50px; padding: 0 14px; color: #10201b; background: #f4f5ef; border: 1px solid #bfc9c2; border-radius: 10px; outline: 0; font: 700 18px/1 ui-monospace, Consolas, monospace; }
    input:focus { border-color: #12a66a; box-shadow: 0 0 0 3px rgba(18,166,106,.14); }
    button { width: 100%; height: 50px; margin-top: 14px; border: 0; border-radius: 10px; color: #10201b; background: #c8f06c; font-size: 15px; font-weight: 850; cursor: pointer; }
    .denied { margin: 0 0 16px; padding: 12px 14px; color: #8f2020; background: #ffeded; border: 1px solid #f3c3c3; border-radius: 9px; font: 800 14px/1.2 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: 0; }
  </style>
</head>
<body>
  <main>
    <p>CRYPTOCOINSPOT / PRIVATE ACCESS</p>
    <h1>Enter password</h1>
    <div class="hint">Authentication is required before the dashboard or its APIs can be accessed.</div>
    {{(denied ? "<div class=\"denied\" role=\"alert\">Access Denied</div>" : "")}}
    <form method="post" action="/access/login">
      <label>Password
        <input name="password" type="password" autocomplete="current-password" autofocus required>
      </label>
      <button type="submit">Access site</button>
    </form>
  </main>
</body>
</html>
""";

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
