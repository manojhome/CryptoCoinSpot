using System.Collections.Concurrent;
using System.Text.Json;

namespace CryptoTrader;

public sealed class DailyPriceStore(string dataDirectory)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks =
        new(StringComparer.OrdinalIgnoreCase);

    public async Task<DailyPriceLoad> GetOrRefreshFiveYearsAsync(
        string coin,
        DateOnly latestCompletedDay,
        Func<CancellationToken, Task<IReadOnlyList<Candle>>> fetchFiveYears,
        Func<CancellationToken, Task<IReadOnlyList<Candle>>> fetchRecentDaily,
        CancellationToken cancellationToken)
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        var gate = _locks.GetOrAdd(coin, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            Directory.CreateDirectory(dataDirectory);
            var path = FilePath(coin);
            var existing = (await ReadFileAsync(path, cancellationToken))
                .OrderBy(x => x.Time)
                .ToArray();
            var cutoffDay = latestCompletedDay.AddYears(-5);
            var retained = existing
                .Where(x =>
                {
                    var day = DateOnly.FromDateTime(x.Time.UtcDateTime);
                    return day >= cutoffDay && day <= latestCompletedDay;
                })
                .ToArray();
            var markerPath = AllTimeMarkerPath(coin);
            var hasFiveYearBackfill = File.Exists(markerPath);
            var lastStoredDay = retained.Length == 0
                ? (DateOnly?)null
                : DateOnly.FromDateTime(retained[^1].Time.UtcDateTime);
            if (hasFiveYearBackfill && lastStoredDay >= latestCompletedDay)
            {
                if (!existing.SequenceEqual(retained))
                    await WriteFileAsync(path, retained, cancellationToken);
                return new DailyPriceLoad(retained, !existing.SequenceEqual(retained));
            }

            IReadOnlyList<Candle> incoming;
            try
            {
                incoming = hasFiveYearBackfill
                    ? await fetchRecentDaily(cancellationToken)
                    : await fetchFiveYears(cancellationToken);
            }
            catch (Exception) when (!cancellationToken.IsCancellationRequested && retained.Length > 0)
            {
                if (!existing.SequenceEqual(retained))
                    await WriteFileAsync(path, retained, cancellationToken);
                return new DailyPriceLoad(retained, !existing.SequenceEqual(retained));
            }

            var merged = retained.Concat(incoming)
                .GroupBy(x => DateOnly.FromDateTime(x.Time.UtcDateTime))
                .Select(x => x.OrderByDescending(c => c.Time).First())
                .Where(x =>
                {
                    var day = DateOnly.FromDateTime(x.Time.UtcDateTime);
                    return day >= cutoffDay && day <= latestCompletedDay;
                })
                .OrderBy(x => x.Time)
                .ToArray();

            var updated = !existing.SequenceEqual(merged);
            if (updated)
                await WriteFileAsync(path, merged, cancellationToken);
            if (!hasFiveYearBackfill)
                await WriteAllTimeMarkerAsync(markerPath, cutoffDay, latestCompletedDay, cancellationToken);
            return new DailyPriceLoad(merged, updated);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<DailyPriceLoad> GetOrRefreshAsync(
        string coin,
        DateOnly latestCompletedDay,
        Func<CancellationToken, Task<IReadOnlyList<Candle>>> fetchDaily,
        CancellationToken cancellationToken)
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        var gate = _locks.GetOrAdd(coin, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            Directory.CreateDirectory(dataDirectory);
            var path = FilePath(coin);
            var existing = (await ReadFileAsync(path, cancellationToken))
                .OrderBy(x => x.Time)
                .ToArray();
            var lastStoredDay = existing.Length == 0
                ? (DateOnly?)null
                : DateOnly.FromDateTime(existing[^1].Time.UtcDateTime);

            if (lastStoredDay >= latestCompletedDay)
                return new DailyPriceLoad(existing, false);

            var incoming = await fetchDaily(cancellationToken);
            var additions = incoming
                .GroupBy(x => DateOnly.FromDateTime(x.Time.UtcDateTime))
                .Select(x => x.OrderByDescending(c => c.Time).First())
                .Where(x => lastStoredDay is null ||
                            DateOnly.FromDateTime(x.Time.UtcDateTime) > lastStoredDay.Value)
                .OrderBy(x => x.Time)
                .ToArray();

            if (additions.Length == 0)
                return new DailyPriceLoad(existing, false);

            var merged = existing.Concat(additions).ToArray();
            await WriteFileAsync(path, merged, cancellationToken);
            return new DailyPriceLoad(merged, true);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<IReadOnlyList<Candle>> MergeAsync(
        string coin,
        IEnumerable<Candle> incoming,
        CancellationToken cancellationToken)
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        var gate = _locks.GetOrAdd(coin, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            Directory.CreateDirectory(dataDirectory);
            var existing = await ReadFileAsync(FilePath(coin), cancellationToken);
            var merged = existing.Concat(incoming)
                .GroupBy(x => DateOnly.FromDateTime(x.Time.UtcDateTime))
                .Select(x => x.OrderByDescending(c => c.Time).First())
                .OrderBy(x => x.Time)
                .ToArray();

            await WriteFileAsync(FilePath(coin), merged, cancellationToken);
            return merged;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<IReadOnlyList<Candle>> GetAsync(
        string coin,
        CancellationToken cancellationToken)
    {
        coin = CoinSpotClient.NormalizeCoin(coin);
        var gate = _locks.GetOrAdd(coin, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            return await ReadFileAsync(FilePath(coin), cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private string FilePath(string coin) => Path.Combine(dataDirectory, $"{coin}-daily.json");
    private string AllTimeMarkerPath(string coin) =>
        Path.Combine(dataDirectory, $"{coin}-daily-alltime.json");

    private static async Task WriteAllTimeMarkerAsync(
        string path,
        DateOnly from,
        DateOnly through,
        CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(
                temporaryPath,
                JsonSerializer.Serialize(new
                {
                    rangeYears = 5,
                    from,
                    through,
                    completedAt = DateTimeOffset.UtcNow
                }),
                cancellationToken);
            File.Move(temporaryPath, path, true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static async Task WriteFileAsync(
        string path,
        IReadOnlyList<Candle> candles,
        CancellationToken cancellationToken)
    {
        var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var stream = File.Create(temporaryPath))
                await JsonSerializer.SerializeAsync(stream, candles, JsonOptions, cancellationToken);
            File.Move(temporaryPath, path, true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static async Task<IReadOnlyList<Candle>> ReadFileAsync(
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return [];
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<Candle[]>(stream, JsonOptions, cancellationToken) ?? [];
    }
}

public sealed record DailyPriceLoad(IReadOnlyList<Candle> Candles, bool Updated);
