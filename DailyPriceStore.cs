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

            var path = FilePath(coin);
            var temporaryPath = $"{path}.{Guid.NewGuid():N}.tmp";
            try
            {
                await using (var stream = File.Create(temporaryPath))
                    await JsonSerializer.SerializeAsync(stream, merged, JsonOptions, cancellationToken);
                File.Move(temporaryPath, path, true);
            }
            finally
            {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
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

    private static async Task<IReadOnlyList<Candle>> ReadFileAsync(
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path)) return [];
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<Candle[]>(stream, JsonOptions, cancellationToken) ?? [];
    }
}
