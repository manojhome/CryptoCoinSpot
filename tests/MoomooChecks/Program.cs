using System.Net;
using System.Text;
using System.Text.Json;
using CryptoTrader;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;

var directory = Path.Combine(Path.GetTempPath(), "moomoo-checks-" + Guid.NewGuid().ToString("N"));
var sessionTime = DateTimeOffset.Parse("2026-10-08T16:00:00Z");
var dailyCandles = JsonSerializer.SerializeToElement(new[] {
    new { time_key = sessionTime.AddDays(-1).ToUnixTimeMilliseconds(), close = 110m, last_close = 100m },
    new { time_key = sessionTime.AddDays(-2).ToUnixTimeMilliseconds(), close = 90m, last_close = 100m },
    new { time_key = sessionTime.ToUnixTimeMilliseconds(), close = 900m, last_close = 100m }
});
var fiveMinuteCandles = JsonSerializer.SerializeToElement(new[] {
    new { time_key = sessionTime.AddMinutes(-5).ToUnixTimeMilliseconds(), close = 120m },
    new { time_key = sessionTime.AddMinutes(-65).ToUnixTimeMilliseconds(), close = 100m },
    new { time_key = sessionTime.ToUnixTimeMilliseconds(), close = 500m }
});
var history = MoomooClient.GainerHistory(dailyCandles, fiveMinuteCandles, "2026-10-08", sessionTime);
Assert(history.Previous == 10 && history.Before == -10 && history.Hour == 20, "gainers exclude current daily and unfinished intraday candles");
var sparse = MoomooClient.GainerHistory(JsonSerializer.SerializeToElement(Array.Empty<object>()),
    JsonSerializer.SerializeToElement(Array.Empty<object>()), "2026-10-08", sessionTime);
Assert(sparse.Previous == null && sparse.Before == null && sparse.Hour == null, "missing gainer history remains unavailable");
Directory.CreateDirectory(directory);
var handler = new FakeMoomoo();
var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:DataDirectory"] = directory }).Build();
var cache = new MemoryCache(new MemoryCacheOptions());
var protection = new EphemeralDataProtectionProvider();
var client = new MoomooClient(new Factory(handler), protection, cache, config);
Assert(MoomooClient.NormalizeSymbol(" aapl ") == "US.AAPL", "US ticker normalization");
await Reject(() => { MoomooClient.NormalizeSymbol("HK.00700"); return Task.CompletedTask; }, "foreign market prefix rejected before credentials");
await Reject(() => client.GetStocksAsync("HK.00700", default), "non-US symbol rejected");
await Reject(() => client.GetStocksAsync("AAPL", default), "missing credentials rejected");
Assert(handler.RequestCount == 0, "missing credentials never call provider");
var disconnected = JsonSerializer.SerializeToElement(await client.AuthenticateAsync(default));
Assert(!disconnected.GetProperty("connected").GetBoolean() && disconnected.GetProperty("requiresAuthorization").GetBoolean(), "missing authorization requests browser connection");
var url = new Uri(await client.BeginAuthorizationAsync("browser-one", default));
var state = QueryHelpers.ParseQuery(url.Query)["state"].ToString();
Assert(QueryHelpers.ParseQuery(url.Query)["code_challenge_method"] == "S256", "PKCE challenge used");
await Reject(() => client.CompleteAuthorizationAsync(state, "test-code", "browser-two", default), "other browser callback rejected");
await client.CompleteAuthorizationAsync(state, "test-code", "browser-one", default);
await Reject(() => client.CompleteAuthorizationAsync(state, "test-code", "browser-one", default), "OAuth callback single use");
var disk = File.ReadAllText(Path.Combine(directory, "moomoo-tokens.json"));
Assert(!disk.Contains("fake-access") && !disk.Contains("fake-refresh"), "credentials encrypted on disk");
var restored = JsonSerializer.SerializeToElement(await client.AuthenticateAsync(default));
Assert(restored.GetProperty("connected").GetBoolean(), "saved authorization restored when stock tab opens");
var expiredTokens = client.ReadTokens()! with { ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1) };
File.WriteAllText(Path.Combine(directory, "moomoo-tokens.json"),
    protection.CreateProtector("CryptoCoinSpot.Moomoo.Tokens.v1").Protect(JsonSerializer.Serialize(expiredTokens)));
var beforeRefresh = handler.RequestCount;
await client.AuthenticateAsync(default);
Assert(handler.RequestCount == beforeRefresh + 1 && client.ReadTokens()!.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(1),
    "opening stock tab refreshes and persists expired authorization automatically");
var stocks = JsonSerializer.SerializeToElement(await client.GetStocksAsync("AAPL,MSFT", default));
Assert(stocks.GetProperty("items")[0].GetProperty("changePercent").GetDecimal() == 10, "day gain uses previous close");
Assert(stocks.GetProperty("missingSymbols")[0].GetString() == "US.MSFT", "partial quotes report missing symbols");
Assert(stocks.GetProperty("items")[0].GetProperty("quoteTime").ValueKind == JsonValueKind.String, "quote timestamp preserved");
var holdings = JsonSerializer.SerializeToElement(await client.GetHoldingsAsync("123", default));
Assert(holdings.GetProperty("items").GetArrayLength() == 4, "holdings retain all markets and instruments");
var holding = holdings.GetProperty("items")[0];
Assert(holdings.GetProperty("items")[2].GetProperty("Currency").GetString() == "HKD", "foreign currency preserved");
Assert(JsonSerializer.SerializeToElement(await client.GetHoldingsAsync("all", default)).GetProperty("items").GetArrayLength() == 4, "all authorized accounts supported");
Assert(holding.GetProperty("CostPrice").GetDecimal() == 180 && holding.GetProperty("Gain").GetDecimal() == 550,
    "decimal strings and broker P/L preserved");
Assert(holdings.GetProperty("items")[1].GetProperty("CostPrice").ValueKind == JsonValueKind.Null &&
    holdings.GetProperty("items")[1].GetProperty("GainPercent").ValueKind == JsonValueKind.Null, "invalid cost and P/L remain unavailable");
var requestsBeforeInvalidAccount = handler.RequestCount;
await Reject(() => client.GetHoldingsAsync("untrusted/account", default), "unauthorized holdings account rejected");
Assert(handler.RequestCount == requestsBeforeInvalidAccount + 1, "unauthorized account never calls positions API");
await Reject(() => client.PlaceOrderAsync(new("123", "AAPL", "BUY", 1, 100), default), "sandbox live orders blocked");
Assert(handler.OrderCount == 0, "sandbox guard prevents all broker orders");
config["Moomoo:ProductionAccountVerified"] = "true";
config["Moomoo:ProductionAccountId"] = "123";
await Reject(() => client.PlaceOrderAsync(new("123", "AAPL", "BUY", 1, 100), default), "read-only authorization blocks live orders");
Assert(handler.OrderCount == 0, "read-only guard prevents all broker orders");
Console.WriteLine("PASS: authorization binding, PKCE, replay protection, encrypted storage, quote parsing, missing symbols and live-order gates.");
foreach (var file in Directory.GetFiles(directory)) File.Delete(file);
Directory.Delete(directory);

static void Assert(bool condition, string label) { if (!condition) throw new Exception("FAIL: " + label); }
static async Task Reject(Func<Task> action, string label)
{
    try { await action(); } catch (ArgumentException) { return; } catch (InvalidOperationException) { return; }
    throw new Exception("FAIL: " + label);
}
sealed class Factory(FakeMoomoo handler) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(handler) { BaseAddress = new Uri("https://webapi.moomoo.com") };
}
sealed class FakeMoomoo : HttpMessageHandler
{
    public int RequestCount;
    public int OrderCount;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        RequestCount++;
        var path = request.RequestUri!.AbsolutePath;
        if (path.EndsWith("/orders")) OrderCount++;
        var json = path switch
        {
            "/oauth2/register" => """{"client_id":"test-client"}""",
            "/oauth2/token" => """{"access_token":"fake-access","refresh_token":"fake-refresh","scope":"quote:read trade:read","expires_in":7200}""",
            "/api/v1.0/quote/snapshot" => """{"ret_code":0,"data":{"snapshot_list":[{"code":"US.AAPL","name":"Apple","last_price":110,"prev_close_price":100,"update_time":1791450000000,"data_date":"2026-10-08"}]}}""",
            "/api/v1.0/accounts/authorized_trd_accs" => """{"s":"ok","d":{"accounts":[{"account_id":"123","enable_market":[2]}]}}""",
            "/api/v1.0/accounts/123/positions" => """{"s":"ok","d":[{"position_side":"LONG","code":"US.AAPL","stock_name":"Apple","currency":"USD","qty":"100","can_sell_qty":"90","cost_price":"180","cost_price_valid":true,"nominal_price":"185.5","market_val":"18550","pl_val":"550","pl_val_valid":true,"pl_ratio":"3.06","pl_ratio_valid":true},{"position_side":"LONG","code":"US.MSFT","stock_name":"Microsoft","currency":"USD","qty":"1","cost_price":"0","cost_price_valid":false,"pl_ratio":"0","pl_ratio_valid":false},{"code":"HK.00700","stock_name":"Tencent","position_side":"LONG","currency":"HKD","qty":"10"},{"code":"US.AAPL260101C100000","stock_name":"Apple option","position_side":"LONG","currency":"USD"}]}""",
            _ => throw new Exception("Unexpected provider request: " + path)
        };
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
    }
}
