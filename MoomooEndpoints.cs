using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.Extensions.Caching.Memory;

namespace CryptoTrader;

public static class MoomooEndpoints
{
    public static void MapMoomoo(this WebApplication app)
    {
        var reviews = new ConcurrentDictionary<string, MoomooReview>();
        var enabled = false;

        app.MapGet("/api/moomoo/status", (HttpContext context, MoomooClient client, IAntiforgery antiforgery) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try { return Results.Ok(new { connection = client.Status(), liveEnabled = enabled,
                csrfToken = antiforgery.GetAndStoreTokens(context).RequestToken }); }
            catch { return Failure("Stored Moomoo credentials cannot be opened. Reconnect Moomoo."); }
        });

        app.MapPost("/api/moomoo/connect", async (HttpContext context, MoomooClient client, IAntiforgery antiforgery) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                await antiforgery.ValidateRequestAsync(context);
                var binding = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                var url = await client.BeginAuthorizationAsync(binding, context.RequestAborted);
                context.Response.Cookies.Append("MoomooOAuthBinding", binding, new CookieOptions
                {
                    HttpOnly = true, Secure = context.Request.IsHttps, SameSite = SameSiteMode.Lax,
                    Path = "/access/moomoo/callback", MaxAge = TimeSpan.FromMinutes(15)
                });
                enabled = false;
                reviews.Clear();
                return Results.Ok(new { authorizationUrl = url });
            }
            catch (AntiforgeryValidationException) { return Failure("Refresh the page before connecting.", 400); }
            catch { return Failure("Unable to start Moomoo authorization. Check connectivity and callback configuration."); }
        });

        // The site's Strict session cookie is not sent on a cross-site OAuth
        // callback. The independently bound, expiring PKCE state validates it.
        app.MapGet("/access/moomoo/callback", async (HttpContext context, MoomooClient client) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            try
            {
                var binding = context.Request.Cookies["MoomooOAuthBinding"] ?? "";
                var state = context.Request.Query["state"].ToString();
                var code = context.Request.Query["code"].ToString();
                if (string.IsNullOrEmpty(code) || string.IsNullOrEmpty(state) || string.IsNullOrEmpty(binding))
                    return Results.Redirect("/stocks.html?moomoo=authorization-failed");
                await client.CompleteAuthorizationAsync(state, code, binding, context.RequestAborted);
                context.Response.Cookies.Delete("MoomooOAuthBinding", new CookieOptions { Path = "/access/moomoo/callback" });
                return Results.Redirect("/stocks.html?moomoo=connected");
            }
            catch { return Results.Redirect("/stocks.html?moomoo=authorization-failed"); }
        });

        app.MapGet("/api/moomoo/us/gainers", async (HttpContext context, MoomooClient client) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try { return Results.Ok(await client.GetGainersAsync(context.RequestAborted)); }
            catch (InvalidOperationException ex) { return Failure(ex.Message); }
            catch { return Failure("US gainers unavailable. Check Moomoo quote permissions and connection."); }
        });

        app.MapGet("/api/moomoo/us/stocks", async (HttpContext context, string? symbols, MoomooClient client) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try { return Results.Ok(await client.GetStocksAsync(symbols ?? "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AVGO,JPM,WMT", context.RequestAborted)); }
            catch (ArgumentException ex) { return Failure(ex.Message, 400); }
            catch (InvalidOperationException ex) { return Failure(ex.Message); }
            catch { return Failure("Moomoo stock data could not be retrieved. Check the connection and quote permissions."); }
        });

        app.MapGet("/api/moomoo/holdings", async (HttpContext context, string? accountId, MoomooClient client) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try { return Results.Ok(await client.GetHoldingsAsync(accountId ?? "all", context.RequestAborted)); }
            catch (ArgumentException ex) { return Failure(ex.Message, 400); }
            catch (InvalidOperationException ex) { return Failure(ex.Message); }
            catch { return Failure("Unable to retrieve holdings. Check Moomoo account permissions."); }
        });

        app.MapGet("/api/moomoo/accounts", async (HttpContext context, MoomooClient client) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var accounts = (await client.GetAccountsAsync(context.RequestAborted)).Select(a => new
                {
                    accountId = a.GetProperty("account_id").ToString(),
                    type = a.GetProperty("acc_type").GetString(),
                    usEnabled = a.GetProperty("enable_market").EnumerateArray().Any(m => m.GetInt32() == 2)
                });
                return Results.Ok(new { accounts });
            }
            catch (InvalidOperationException ex) { return Failure(ex.Message); }
            catch { return Failure("Unable to load authorized Moomoo accounts."); }
        });

        app.MapPost("/api/moomoo/trading/enable", async (HttpContext context, MoomooClient client, IAntiforgery antiforgery) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                await antiforgery.ValidateRequestAsync(context);
                var request = await context.Request.ReadFromJsonAsync<EnableRequest>();
                if (request?.Enabled != true) { enabled = false; reviews.Clear(); return Results.Ok(new { enabled }); }
                var status = client.ReadTokens();
                if (!client.ProductionVerified || status?.Scope.Split(' ').Contains("trade:write") != true)
                    return Failure("Live trading requires a verified production account and trade:write permission.", 409);
                enabled = true;
                return Results.Ok(new { enabled });
            }
            catch (AntiforgeryValidationException) { return Failure("Refresh the page before changing trading settings.", 400); }
            catch { return Failure("Trading settings could not be changed."); }
        });

        app.MapPost("/api/moomoo/orders/review", async (HttpContext context, MoomooClient client, IAntiforgery antiforgery) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                await antiforgery.ValidateRequestAsync(context);
                if (!enabled) return Failure("Enable live trading before reviewing an order.", 409);
                var order = await context.Request.ReadFromJsonAsync<MoomooOrder>() ?? throw new ArgumentException("Enter order details.");
                order = order with { Symbol = MoomooClient.NormalizeSymbol(order.Symbol) };
                await client.ValidateOrderAsync(order, context.RequestAborted);
                foreach (var expired in reviews.Where(pair => pair.Value.ExpiresAt < DateTimeOffset.UtcNow)) reviews.TryRemove(expired.Key, out _);
                var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
                var expiry = DateTimeOffset.UtcNow.AddSeconds(60);
                reviews[token] = new MoomooReview(order, expiry);
                return Results.Ok(new { token, order, expiresAt = expiry, maximumValueUsd = order.Quantity * order.LimitPrice,
                    message = "LIMIT / DAY / regular US session. Review creates no broker order. Fees are additional." });
            }
            catch (AntiforgeryValidationException) { return Failure("Refresh the page before reviewing an order.", 400); }
            catch (ArgumentException ex) { return Failure(ex.Message, 400); }
            catch (InvalidOperationException ex) { return Failure(ex.Message, 409); }
            catch { return Failure("Order review failed. No order was submitted."); }
        });

        app.MapPost("/api/moomoo/orders/submit", async (HttpContext context, MoomooClient client, IAntiforgery antiforgery) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                await antiforgery.ValidateRequestAsync(context);
                var request = await context.Request.ReadFromJsonAsync<SubmitRequest>();
                if (!enabled || request?.Confirmed != true || string.IsNullOrEmpty(request.Token) ||
                    !reviews.TryRemove(request.Token, out var review) || review.ExpiresAt < DateTimeOffset.UtcNow)
                    return Failure("Trading is disabled or the reviewed order has expired/already been used. Review again.", 409);
                // Consume before the outbound request. Never retry automatically:
                // a transport timeout can occur after the broker accepts an order.
                var orderId = await client.PlaceOrderAsync(review.Order, context.RequestAborted);
                return Results.Ok(new { orderId, message = "Order submitted; this is not confirmation of a fill. Check Moomoo order status." });
            }
            catch (AntiforgeryValidationException) { return Failure("Refresh the page before submitting an order.", 400); }
            catch (ArgumentException ex) { return Failure(ex.Message, 400); }
            catch (InvalidOperationException ex) { return Failure(ex.Message, 409); }
            catch { return Failure("Order outcome is unknown. Check Moomoo orders before submitting another order. No retry was attempted."); }
        });
    }

    private static IResult Failure(string message, int status = 503) => Results.Json(new { error = message }, statusCode: status);
    private sealed record EnableRequest(bool Enabled);
    private sealed record SubmitRequest(string Token, bool Confirmed);
}
