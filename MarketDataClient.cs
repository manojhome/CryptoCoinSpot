using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace CryptoTrader;

public sealed class MarketDataClient(HttpClient http)
{
    private const string KuCoinRoot = "https://api.kucoin.com/api/v1";
    private static readonly IReadOnlyDictionary<string, string> Ids =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["BTC"] = "bitcoin", ["ETH"] = "ethereum", ["XRP"] = "ripple",
            ["USDT"] = "tether", ["SOL"] = "solana", ["USDC"] = "usd-coin",
            ["TRX"] = "tron"
        };

    public async Task<IReadOnlyList<Candle>> GetDailyAsync(
        string coin, int years, string currency, CancellationToken cancellationToken)
    {
        if (years is < 1 or > 10) throw new ArgumentOutOfRangeException(nameof(years));
        if (!currency.Equals("usd", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Five-year history currently supports --currency usd.");
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        ResolveId(symbol);
        var to = DateTimeOffset.UtcNow;
        var from = to.AddYears(-years);
        var candles = new Dictionary<long, Candle>();

        // Coinbase Exchange returns at most 300 candles, so fetch 290-day windows.
        for (var start = from; start < to; start = start.AddDays(290))
        {
            var end = start.AddDays(290) < to ? start.AddDays(290) : to;
            var uri = "https://api.exchange.coinbase.com/products/" +
                      $"{symbol}-USD/candles?granularity=86400&start={Uri.EscapeDataString(start.ToString("O"))}" +
                      $"&end={Uri.EscapeDataString(end.ToString("O"))}";
            using var response = await http.GetAsync(uri, cancellationToken);
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Coinbase market data returned {(int)response.StatusCode}: {text}");
            using var json = JsonDocument.Parse(text);
            foreach (var row in json.RootElement.EnumerateArray())
            {
                // Coinbase candle order: time, low, high, open, close, volume.
                var time = DateTimeOffset.FromUnixTimeSeconds(row[0].GetInt64());
                candles[time.ToUnixTimeSeconds()] =
                    new Candle(time, row[3].GetDecimal(), row[2].GetDecimal(), row[1].GetDecimal(), row[4].GetDecimal());
            }
        }
        if (candles.Count == 0) throw new InvalidOperationException($"No {symbol}-USD daily candles were returned.");
        return candles.Values.OrderBy(x => x.Time).ToArray();
    }

    public async Task<IReadOnlyList<Candle>> GetHourlyAsync(
        string coin, int days, string currency, CancellationToken cancellationToken)
    {
        if (days is < 4 or > 90) throw new ArgumentOutOfRangeException(nameof(days));
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        return await GetKuCoinCandlesAsync(
            symbol, "1hour", DateTimeOffset.UtcNow.AddDays(-days), currency, cancellationToken);
    }

    public async Task<(IReadOnlyList<Candle> Candles, string Source)> GetThreeHourCandlesAsync(
        string coin, string currency, CancellationToken cancellationToken)
    {
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        var now = DateTimeOffset.UtcNow;
        var from = now.AddHours(-3);
        try
        {
            var candles = await GetCoinSpotChartCandlesAsync(
                symbol, 5, from.AddMinutes(-5), now, cancellationToken);
            var selected = candles.Where(x => x.Time >= from).ToArray();
            if (selected.Length >= 2)
                return (selected, "CoinSpot five-minute chart history");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // Fall through to the matching KuCoin market when CoinSpot has no chart history.
        }

        var fallback = await GetKuCoinCandlesAsync(
            symbol, "5min", from.AddMinutes(-5), currency, cancellationToken);
        return (
            fallback.Where(x => x.Time >= from).ToArray(),
            "CoinSpot-listed KuCoin five-minute market converted to AUD");
    }

    public Task<decimal> GetCoinSpotCurrentPriceAsync(
        string coin,
        CancellationToken cancellationToken) =>
        GetCoinSpotPriceAsync(CoinSpotClient.NormalizeCoin(coin), cancellationToken);

    public async Task<(IReadOnlyList<Candle> Candles, string Source)> GetTwentyFourHourCandlesAsync(
        string coin, string currency, CancellationToken cancellationToken)
    {
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        var now = DateTimeOffset.UtcNow;
        var from = now.AddHours(-24);
        try
        {
            var candles = await GetCoinSpotChartCandlesAsync(
                symbol, 15, from.AddMinutes(-15), now, cancellationToken);
            var selected = candles.Where(x => x.Time >= from).ToArray();
            if (selected.Length >= 2)
                return (selected, "CoinSpot 15-minute chart history");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // Fall through when CoinSpot has no chart history for this market.
        }

        var fallback = await GetKuCoinCandlesAsync(
            symbol, "15min", from.AddMinutes(-15), currency, cancellationToken);
        return (
            fallback.Where(x => x.Time >= from).ToArray(),
            "CoinSpot-listed KuCoin 15-minute market converted to AUD");
    }

    public async Task<IReadOnlyList<Candle>> GetRecentDailyAsync(
        string coin, int days, string currency, CancellationToken cancellationToken)
    {
        if (days is < 21 or > 366) throw new ArgumentOutOfRangeException(nameof(days));
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        var candles = await GetKuCoinCandlesAsync(
            symbol, "1day", DateTimeOffset.UtcNow.AddDays(-days), currency, cancellationToken);
        var todayUtc = DateTimeOffset.UtcNow.Date;
        return candles.Where(x => x.Time.UtcDateTime.Date < todayUtc)
            .ToArray();
    }

    public async Task<IReadOnlyList<Candle>> GetFiveYearDailyAsync(
        string coin, string currency, CancellationToken cancellationToken)
    {
        var symbol = CoinSpotClient.NormalizeCoin(coin);
        var quote = currency.ToUpperInvariant();
        if (quote is not ("AUD" or "USD" or "USDT"))
            throw new ArgumentException("KuCoin dashboard candles support AUD, USD or USDT.");

        var audMultiplier = quote == "AUD"
            ? await GetCoinSpotPriceAsync("USDT", cancellationToken)
            : (decimal?)null;
        var todayUtc = DateTime.UtcNow.Date;
        var windowEnd = new DateTimeOffset(todayUtc, TimeSpan.Zero);
        var earliest = windowEnd.AddYears(-5).AddDays(-1);
        var candles = new Dictionary<DateOnly, Candle>();

        while (windowEnd > earliest)
        {
            var windowStart = windowEnd.AddDays(-1490);
            if (windowStart < earliest) windowStart = earliest;
            var window = await GetKuCoinCandlesAsync(
                symbol, "1day", windowStart, currency, cancellationToken,
                windowEnd, allowEmpty: true, audMultiplier: audMultiplier);
            if (window.Count == 0)
            {
                if (candles.Count > 0) break;
            }
            else
            {
                foreach (var candle in window.Where(x => x.Time.UtcDateTime.Date < todayUtc))
                    candles[DateOnly.FromDateTime(candle.Time.UtcDateTime)] = candle;
            }
            windowEnd = windowStart.AddSeconds(-1);
        }

        if (candles.Count == 0)
            throw new InvalidOperationException($"KuCoin returned no daily history for {symbol}.");
        return candles.Values.OrderBy(x => x.Time).ToArray();
    }

    public async Task<IReadOnlyList<MarketGainer>> GetTopCoinSpotGainersAsync(
        int limit, CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 50) throw new ArgumentOutOfRangeException(nameof(limit));

        using var sitemapResponse = await http.GetAsync(
            "https://www.coinspot.com.au/sitemap.xml", cancellationToken);
        var sitemap = await sitemapResponse.Content.ReadAsStringAsync(cancellationToken);
        if (!sitemapResponse.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot listing returned {(int)sitemapResponse.StatusCode}.");
        var listed = Regex.Matches(
                sitemap,
                @"https://www\.coinspot\.com\.au/chart/([^<]+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            .Select(x => Uri.UnescapeDataString(x.Groups[1].Value).ToUpperInvariant())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        using var coinSpotResponse = await http.GetAsync(
            "https://www.coinspot.com.au/pubapi/v2/latest", cancellationToken);
        var coinSpotText = await coinSpotResponse.Content.ReadAsStringAsync(cancellationToken);
        if (!coinSpotResponse.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot latest prices returned {(int)coinSpotResponse.StatusCode}.");
        using var coinSpotJson = JsonDocument.Parse(coinSpotText);
        var coinSpotPrices = coinSpotJson.RootElement.GetProperty("prices")
            .EnumerateObject()
            .Where(x => !x.Name.Contains('_') && x.Value.TryGetProperty("last", out _))
            .Select(x => (Coin: x.Name.ToUpperInvariant(), Price: ReadDecimal(x.Value.GetProperty("last"))))
            .Where(x => x.Price > 0)
            .ToDictionary(x => x.Coin, x => x.Price, StringComparer.OrdinalIgnoreCase);
        var audPerUsdt = coinSpotPrices.TryGetValue("USDT", out var usdtPrice)
            ? usdtPrice
            : await GetCoinSpotPriceAsync("USDT", cancellationToken);

        using var response = await GetWithRateLimitRetryAsync(
            $"{KuCoinRoot}/market/allTickers", cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"KuCoin market data returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        ThrowIfKuCoinError(json.RootElement);
        var candidates = new List<(string Coin, string Name, decimal Price, decimal Change)>();
        foreach (var item in json.RootElement.GetProperty("data").GetProperty("ticker").EnumerateArray())
        {
            var market = item.GetProperty("symbol").GetString();
            if (market is null || !market.EndsWith("-USDT", StringComparison.OrdinalIgnoreCase)) continue;
            var symbol = market[..^5].ToUpperInvariant();
            if (!listed.Contains(symbol) ||
                !item.TryGetProperty("changeRate", out var changeElement) ||
                !item.TryGetProperty("last", out var lastElement)) continue;
            var change = ReadDecimal(changeElement) * 100m;
            var price = coinSpotPrices.TryGetValue(symbol, out var coinSpotPrice)
                ? coinSpotPrice
                : ReadDecimal(lastElement) * audPerUsdt;
            candidates.Add((symbol, symbol, price, change));
        }

        var topGainers = candidates
            .GroupBy(x => x.Coin, StringComparer.OrdinalIgnoreCase)
            .Select(x => x.First())
            .OrderByDescending(x => x.Change)
            .Take(limit)
            .ToArray();

        using var hourlyConcurrency = new SemaphoreSlim(8);
        var recentChanges = await Task.WhenAll(topGainers.Select(async candidate =>
        {
            await hourlyConcurrency.WaitAsync(cancellationToken);
            try
            {
                var oneHour = await GetCoinSpotOneHourChangeAsync(candidate.Coin, cancellationToken)
                    ?? await GetKuCoinOneHourChangeAsync(candidate.Coin, cancellationToken);
                var daily = await GetKuCoinCompletedDailyChangesAsync(candidate.Coin, cancellationToken);
                return (candidate.Coin, OneHour: oneHour, daily.PreviousDay, daily.DayBefore);
            }
            finally
            {
                hourlyConcurrency.Release();
            }
        }));
        var changesByCoin = recentChanges.ToDictionary(
            x => x.Coin, x => x, StringComparer.OrdinalIgnoreCase);

        return topGainers
            .Select(x => new
            {
                Candidate = x,
                Changes = changesByCoin[x.Coin],
                ThreeDayAverage = changesByCoin[x.Coin].PreviousDay is decimal previousDay &&
                                  changesByCoin[x.Coin].DayBefore is decimal dayBefore
                    ? (x.Change + previousDay + dayBefore) / 3m
                    : (decimal?)null
            })
            .OrderByDescending(x => x.ThreeDayAverage.HasValue)
            .ThenByDescending(x => x.ThreeDayAverage)
            .ThenByDescending(x => x.Candidate.Change)
            .Select((x, index) => new MarketGainer(
                index + 1, x.Candidate.Coin, x.Candidate.Name, x.Candidate.Price,
                x.Changes.PreviousDay,
                x.Changes.DayBefore,
                x.Candidate.Change,
                x.Changes.OneHour))
            .ToArray();
    }

    private async Task<(decimal? PreviousDay, decimal? DayBefore)> GetKuCoinCompletedDailyChangesAsync(
        string coin, CancellationToken cancellationToken)
    {
        try
        {
            var todayUtc = DateTimeOffset.UtcNow.Date;
            var candles = await GetKuCoinCandlesAsync(
                coin, "1day", DateTimeOffset.UtcNow.AddDays(-7), "USDT", cancellationToken);
            var completed = candles
                .Where(x => x.Time.UtcDateTime.Date < todayUtc && x.Close > 0)
                .OrderBy(x => x.Time)
                .TakeLast(3)
                .ToArray();
            if (completed.Length < 3) return (null, null);

            static decimal Change(Candle current, Candle previous) =>
                previous.Close > 0
                    ? (current.Close - previous.Close) / previous.Close * 100m
                    : 0m;

            return (
                Change(completed[2], completed[1]),
                Change(completed[1], completed[0]));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (null, null);
        }
        catch (HttpRequestException)
        {
            return (null, null);
        }
        catch (InvalidOperationException)
        {
            return (null, null);
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    private async Task<decimal?> GetCoinSpotOneHourChangeAsync(
        string coin, CancellationToken cancellationToken)
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            var from = now.AddHours(-2).ToUnixTimeSeconds();
            var to = now.ToUnixTimeSeconds();
            using var response = await GetWithRateLimitRetryAsync(
                $"https://www.coinspot.com.au/charts/history?symbol={Uri.EscapeDataString(coin)}" +
                $"&resolution=5&from={from}&to={to}",
                cancellationToken);
            if (!response.IsSuccessStatusCode) return null;

            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            using var json = JsonDocument.Parse(text);
            if (!json.RootElement.TryGetProperty("s", out var status) ||
                !string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase) ||
                !json.RootElement.TryGetProperty("t", out var timesElement) ||
                !json.RootElement.TryGetProperty("c", out var closesElement) ||
                timesElement.ValueKind != JsonValueKind.Array ||
                closesElement.ValueKind != JsonValueKind.Array)
                return null;

            var times = timesElement.EnumerateArray().Select(x => x.GetInt64()).ToArray();
            var closes = closesElement.EnumerateArray().Select(ReadDecimal).ToArray();
            if (times.Length == 0 || times.Length != closes.Length) return null;

            var points = times.Zip(closes, (time, close) => new { Time = time, Close = close })
                .Where(x => x.Close > 0)
                .OrderBy(x => x.Time)
                .ToArray();
            if (points.Length < 2) return null;

            var target = now.AddHours(-1).ToUnixTimeSeconds();
            var baseline = points
                .Where(x => x.Time <= target)
                .OrderByDescending(x => x.Time)
                .Select(x => x.Close)
                .FirstOrDefault();
            var currentPrice = points[^1].Close;

            return baseline > 0
                ? (currentPrice - baseline) / baseline * 100m
                : null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<IReadOnlyList<Candle>> GetCoinSpotChartCandlesAsync(
        string coin,
        int resolutionMinutes,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        using var response = await GetWithRateLimitRetryAsync(
            $"https://www.coinspot.com.au/charts/history?symbol={Uri.EscapeDataString(coin)}" +
            $"&resolution={resolutionMinutes}&from={from.ToUnixTimeSeconds()}&to={to.ToUnixTimeSeconds()}",
            cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot chart returned {(int)response.StatusCode}: {text}");

        using var json = JsonDocument.Parse(text);
        var root = json.RootElement;
        if (!root.TryGetProperty("s", out var status) ||
            !string.Equals(status.GetString(), "ok", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"CoinSpot returned no chart history for {coin}.");

        var times = root.GetProperty("t").EnumerateArray().Select(x => x.GetInt64()).ToArray();
        var opens = root.GetProperty("o").EnumerateArray().Select(ReadDecimal).ToArray();
        var highs = root.GetProperty("h").EnumerateArray().Select(ReadDecimal).ToArray();
        var lows = root.GetProperty("l").EnumerateArray().Select(ReadDecimal).ToArray();
        var closes = root.GetProperty("c").EnumerateArray().Select(ReadDecimal).ToArray();
        if (times.Length == 0 || opens.Length != times.Length || highs.Length != times.Length ||
            lows.Length != times.Length || closes.Length != times.Length)
            throw new InvalidOperationException($"CoinSpot returned incomplete chart history for {coin}.");

        return Enumerable.Range(0, times.Length)
            .Select(index => new Candle(
                DateTimeOffset.FromUnixTimeSeconds(times[index]),
                opens[index], highs[index], lows[index], closes[index]))
            .Where(x => x.Open > 0 && x.High > 0 && x.Low > 0 && x.Close > 0)
            .OrderBy(x => x.Time)
            .ToArray();
    }

    private async Task<decimal?> GetKuCoinOneHourChangeAsync(
        string coin, CancellationToken cancellationToken)
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            var candles = await GetKuCoinCandlesAsync(
                coin, "1min", now.AddMinutes(-70), "USDT", cancellationToken);
            if (candles.Count < 2) return null;

            var target = now.AddHours(-1);
            var baseline = candles
                .Where(x => x.Time <= target && x.Close > 0)
                .OrderByDescending(x => x.Time)
                .Select(x => x.Close)
                .FirstOrDefault();
            var currentPrice = candles[^1].Close;
            return baseline > 0 && currentPrice > 0
                ? (currentPrice - baseline) / baseline * 100m
                : null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task<HttpResponseMessage> GetWithRateLimitRetryAsync(
        string uri, CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            var response = await http.GetAsync(uri, cancellationToken);
            if ((int)response.StatusCode != 429 || attempt >= 4) return response;
            response.Dispose();
            await Task.Delay(TimeSpan.FromSeconds(5 * (attempt + 1)), cancellationToken);
        }
    }

    private async Task<IReadOnlyList<Candle>> GetKuCoinCandlesAsync(
        string coin, string type, DateTimeOffset start, string currency,
        CancellationToken cancellationToken,
        DateTimeOffset? requestedEnd = null,
        bool allowEmpty = false,
        decimal? audMultiplier = null)
    {
        var quote = currency.ToUpperInvariant();
        if (quote is not ("AUD" or "USD" or "USDT"))
            throw new ArgumentException("KuCoin dashboard candles support AUD, USD or USDT.");
        var market = coin.Equals("USDT", StringComparison.OrdinalIgnoreCase)
            ? "USDT-USDC"
            : $"{coin}-USDT";
        var end = requestedEnd ?? DateTimeOffset.UtcNow;
        var uri = $"{KuCoinRoot}/market/candles?type={type}&symbol={market}" +
                  $"&startAt={start.ToUnixTimeSeconds()}&endAt={end.ToUnixTimeSeconds()}";
        using var response = await GetWithRateLimitRetryAsync(uri, cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"KuCoin returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        ThrowIfKuCoinError(json.RootElement);
        var multiplier = quote == "AUD"
            ? audMultiplier ?? await GetCoinSpotPriceAsync("USDT", cancellationToken)
            : 1m;
        var candles = json.RootElement.GetProperty("data").EnumerateArray()
            .Select(x => new Candle(
                DateTimeOffset.FromUnixTimeSeconds(long.Parse(x[0].GetString()!, CultureInfo.InvariantCulture)),
                ReadDecimal(x[1]) * multiplier,
                ReadDecimal(x[3]) * multiplier,
                ReadDecimal(x[4]) * multiplier,
                ReadDecimal(x[2]) * multiplier,
                ReadDecimal(x[6]) * multiplier))
            .Where(x => x.Close > 0)
            .OrderBy(x => x.Time)
            .ToArray();
        if (candles.Length == 0 && !allowEmpty)
            throw new InvalidOperationException($"KuCoin returned no candles for {market}.");
        return candles;
    }

    private async Task<decimal> GetCoinSpotPriceAsync(string coin, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(
            $"https://www.coinspot.com.au/pubapi/v2/latest/{coin}", cancellationToken);
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"CoinSpot returned {(int)response.StatusCode}: {text}");
        using var json = JsonDocument.Parse(text);
        return ReadDecimal(json.RootElement.GetProperty("prices").GetProperty("last"));
    }

    private static void ThrowIfKuCoinError(JsonElement root)
    {
        if (root.TryGetProperty("code", out var code) && code.GetString() == "200000") return;
        var message = root.TryGetProperty("msg", out var value) ? value.GetString() : "Unknown provider error.";
        throw new HttpRequestException($"KuCoin error: {message}");
    }

    private static decimal ReadDecimal(JsonElement value) =>
        value.ValueKind == JsonValueKind.String
            ? decimal.Parse(value.GetString()!, CultureInfo.InvariantCulture)
            : value.GetDecimal();

    private static string ResolveId(string coin) =>
        Ids.TryGetValue(CoinSpotClient.NormalizeCoin(coin), out var id)
            ? id
            : throw new ArgumentException(
                $"Historical data mapping is not configured for {coin}. Supported: {string.Join(", ", Ids.Keys)}.");
}
