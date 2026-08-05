using System.Text.Json;

namespace CryptoTrader;

public sealed class TradeTransactionStore
{
    private readonly string _filePath;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public TradeTransactionStore(string dataDirectory)
    {
        Directory.CreateDirectory(dataDirectory);
        _filePath = Path.Combine(dataDirectory, "live-trades.json");
    }

    public async Task<IReadOnlyList<LiveTradeTransaction>> GetAsync(
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var transactions = await ReadUnsafeAsync(cancellationToken);
            var normalized = NormalizeFees(transactions);
            if (normalized.Updated)
                await WriteUnsafeAsync(normalized.Transactions, cancellationToken);
            return normalized.Transactions;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task AddAsync(
        LiveTradeTransaction transaction,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var transactions = NormalizeFees(await ReadUnsafeAsync(cancellationToken))
                .Transactions.ToList();
            transactions.Add(transaction);
            transactions.Sort((left, right) => left.ExecutedAt.CompareTo(right.ExecutedAt));
            await WriteUnsafeAsync(transactions, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static (IReadOnlyList<LiveTradeTransaction> Transactions, bool Updated) NormalizeFees(
        IReadOnlyList<LiveTradeTransaction> transactions)
    {
        var updated = false;
        var normalized = transactions.Select(transaction =>
        {
            if (transaction.FeeAud > 0 || transaction.TotalAud <= 0) return transaction;
            updated = true;
            return transaction with { FeeAud = Math.Round(transaction.TotalAud * 0.01m, 8) };
        }).ToArray();
        return (normalized, updated);
    }

    private async Task<IReadOnlyList<LiveTradeTransaction>> ReadUnsafeAsync(
        CancellationToken cancellationToken)
    {
        if (!File.Exists(_filePath)) return [];
        await using var stream = File.OpenRead(_filePath);
        return await JsonSerializer.DeserializeAsync<List<LiveTradeTransaction>>(
                   stream, JsonOptions, cancellationToken)
               ?? [];
    }

    private async Task WriteUnsafeAsync(
        IReadOnlyList<LiveTradeTransaction> transactions,
        CancellationToken cancellationToken)
    {
        var temporaryPath = _filePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(
                             temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await JsonSerializer.SerializeAsync(
                    stream, transactions, JsonOptions, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, _filePath, true);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }
}
