using CryptoTrader;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Caching.Memory;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

var secret = Convert.ToBase64String(Encoding.UTF8.GetBytes("test-secret-only"));
var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> {
    ["BtcMarkets:ApiKey"]="test-key", ["BtcMarkets:ApiSecret"]=secret }).Build();
var handler = new CaptureHandler();
var client = new BtcMarketsClient(new HttpClient(handler) {BaseAddress=new Uri("https://api.btcmarkets.net")}, config, new MemoryCache(new MemoryCacheOptions()));
if (!client.Configured || client.Trading) throw new Exception("Credential/trading defaults incorrect.");
await client.Send("/v3/accounts/me/balances", default, true);
if (handler.Signature != Sign("GET/v3/accounts/me/balances"+handler.Timestamp)) throw new Exception("GET signature mismatch.");
var body = new JsonObject {["marketId"]="BTC-AUD", ["amount"]="0.01"};
await client.Send("/v3/orders", default, true, body);
if (handler.Signature != Sign("POST/v3/orders"+handler.Timestamp+body.ToJsonString())) throw new Exception("POST signature mismatch.");
await client.Tickers(default); var calls=handler.Calls; await client.Tickers(default);
if(handler.Calls!=calls || handler.LastSigned) throw new Exception("Public data cache or authentication incorrect.");
var missing = new BtcMarketsClient(new HttpClient(handler),new ConfigurationBuilder().Build(),new MemoryCache(new MemoryCacheOptions()));
try { await missing.Send("/v3/accounts/me/balances",default,true); throw new Exception("Missing credentials accepted."); }
catch(InvalidOperationException) { }
Console.WriteLine("PASS: private GET/POST signatures, public authentication/cache, credential and trading defaults.");
string Sign(string message)=>Convert.ToBase64String(HMACSHA512.HashData(Convert.FromBase64String(secret),Encoding.UTF8.GetBytes(message)));
sealed class CaptureHandler : HttpMessageHandler {
 public string Timestamp="",Signature=""; public int Calls; public bool LastSigned;
 protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct) {
  Calls++;LastSigned=request.Headers.Contains("BM-AUTH-APIKEY");
  if(LastSigned){Timestamp=request.Headers.GetValues("BM-AUTH-TIMESTAMP").Single();Signature=request.Headers.GetValues("BM-AUTH-SIGNATURE").Single();}
  var body=request.RequestUri!.AbsolutePath=="/v3/markets"?"[{\"marketId\":\"BTC-AUD\"}]":"[]";
  return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(body)});
 }
}
