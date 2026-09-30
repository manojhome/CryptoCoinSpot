using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;

namespace CryptoTrader;

public sealed class IbkrMarketDataClient
{
    private const string SnapshotFields = "31,55,70,71,82,83,84,86,87,6509,7051,7221,7280,7281,7282,7293,7294,7295,7741";
    private readonly HttpClient _http;
    private readonly IConfiguration _configuration;

    public IbkrMarketDataClient(HttpClient http, IConfiguration configuration)
    {
        _http = http;
        _configuration = configuration;
    }

    public async Task<IbkrStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync("iserver/auth/status", cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            return new(false, false, $"IBKR gateway returned {(int)response.StatusCode}.");

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        return new(
            ReadBoolean(root, "authenticated"),
            ReadBoolean(root, "connected"),
            ReadString(root, "message") ?? "IBKR gateway responded.");
    }

    public async Task<IbkrStockResult> GetAsxLeadersAsync(int limit, CancellationToken cancellationToken)
    {
        limit = Math.Clamp(limit, 1, 200);
        var status = await GetStatusAsync(cancellationToken);
        if (!status.Authenticated)
            throw new InvalidOperationException("The IBKR Client Portal Gateway is reachable but is not authenticated. Sign in to the gateway with IBKR and complete MFA, then refresh this page.");

        // IBKR requires this endpoint before any market-data snapshot request.
        using (var accounts = await _http.GetAsync("iserver/accounts", cancellationToken))
            accounts.EnsureSuccessStatusCode();

        var location = _configuration["IBKR:AsxLocation"] ?? "STK.AU";
        var scannerType = _configuration["IBKR:ScannerType"] ?? "HIGH_MKT_CAP";
        using var scanResponse = await _http.PostAsJsonAsync("iserver/scanner/run", new
        {
            instrument = "STK",
            location,
            type = scannerType,
            filter = Array.Empty<object>()
        }, cancellationToken);
        var scanBody = await scanResponse.Content.ReadAsStringAsync(cancellationToken);
        if (!scanResponse.IsSuccessStatusCode)
            throw new InvalidOperationException($"IBKR ASX scanner returned {(int)scanResponse.StatusCode}: {TrimMessage(scanBody)}");

        using var scanJson = JsonDocument.Parse(scanBody);
        if (!scanJson.RootElement.TryGetProperty("contracts", out var contractsElement) ||
            contractsElement.ValueKind != JsonValueKind.Array)
            throw new InvalidOperationException("IBKR returned no ASX scanner contracts.");

        var contracts = contractsElement.EnumerateArray()
            .Select((item, index) => new ScannerContract(
                index + 1,
                ReadLong(item, "con_id"),
                ReadString(item, "symbol") ?? "—",
                ReadString(item, "company_name") ?? "—",
                ReadString(item, "listing_exchange") ?? "ASX",
                ReadString(item, "scan_data")))
            .Where(item => item.Conid > 0)
            .Take(limit)
            .ToList();

        if (contracts.Count == 0)
            return new(Array.Empty<IbkrStock>(), DateTimeOffset.UtcNow, scannerType, location, 50,
                "The authenticated IBKR scanner returned no ASX stocks.");

        var snapshots = new Dictionary<long, JsonElement>();
        foreach (var chunk in contracts.Chunk(100))
        {
            var conids = string.Join(',', chunk.Select(item => item.Conid));
            var path = $"iserver/marketdata/snapshot?conids={Uri.EscapeDataString(conids)}&fields={Uri.EscapeDataString(SnapshotFields)}";

            // The first request starts IBKR's market-data streams; the next reads them.
            using (var preflight = await _http.GetAsync(path, cancellationToken))
                preflight.EnsureSuccessStatusCode();
            await Task.Delay(700, cancellationToken);
            using var snapshotResponse = await _http.GetAsync(path, cancellationToken);
            snapshotResponse.EnsureSuccessStatusCode();
            using var snapshotJson = JsonDocument.Parse(await snapshotResponse.Content.ReadAsStringAsync(cancellationToken));
            if (snapshotJson.RootElement.ValueKind != JsonValueKind.Array) continue;
            foreach (var snapshot in snapshotJson.RootElement.EnumerateArray())
            {
                var conid = ReadLong(snapshot, "conid");
                if (conid > 0) snapshots[conid] = snapshot.Clone();
            }
        }

        var items = contracts.Select(contract =>
        {
            snapshots.TryGetValue(contract.Conid, out var market);
            return new IbkrStock(
                contract.Rank,
                contract.Conid,
                ReadString(market, "55") ?? contract.Symbol,
                ReadString(market, "7051") ?? contract.Company,
                ReadString(market, "7221") ?? contract.Exchange,
                ParseNumber(ReadString(market, "31")),
                ParseNumber(ReadString(market, "84")),
                ParseNumber(ReadString(market, "86")),
                ParseNumber(ReadString(market, "82")),
                ParseNumber(ReadString(market, "83")),
                ReadString(market, "87"),
                ReadString(market, "7280"),
                ReadString(market, "7281"),
                ParseNumber(ReadString(market, "70")),
                ParseNumber(ReadString(market, "71")),
                ParseNumber(ReadString(market, "7293")),
                ParseNumber(ReadString(market, "7294")),
                ReadString(market, "6509"),
                contract.ScanData);
        }).ToList();

        const int scannerLimit = 50;
        var note = limit > scannerLimit
            ? "IBKR limits each market-scanner response to 50 contracts, so this panel shows the first 50 ASX market-cap leaders."
            : null;
        return new(items, DateTimeOffset.UtcNow, scannerType, location, scannerLimit, note);
    }

    private static bool ReadBoolean(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) &&
        value.ValueKind is JsonValueKind.True;

    private static long ReadLong(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(name, out var value)) return 0;
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)
            ? number
            : long.TryParse(value.ToString(), out number) ? number : 0;
    }

    private static string? ReadString(JsonElement root, string name)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(name, out var value) ||
            value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    private static decimal? ParseNumber(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var cleaned = raw.Trim().TrimStart('C', 'H').Replace("%", "").Replace(",", "").Trim();
        return decimal.TryParse(cleaned, NumberStyles.Any, CultureInfo.InvariantCulture, out var value) ? value : null;
    }

    private static string TrimMessage(string value) => value.Length <= 240 ? value : value[..240];

    private sealed record ScannerContract(int Rank, long Conid, string Symbol, string Company, string Exchange, string? ScanData);
}

public sealed record IbkrStatus(bool Authenticated, bool Connected, string Message);

public sealed record IbkrStockResult(
    IReadOnlyList<IbkrStock> Items,
    DateTimeOffset RetrievedAt,
    string ScannerType,
    string Location,
    int ProviderLimit,
    string? Note);

public sealed record IbkrStock(
    int Rank,
    long Conid,
    string Symbol,
    string Company,
    string Exchange,
    decimal? Last,
    decimal? Bid,
    decimal? Ask,
    decimal? Change,
    decimal? ChangePercent,
    string? Volume,
    string? Industry,
    string? Category,
    decimal? DayHigh,
    decimal? DayLow,
    decimal? Week52High,
    decimal? Week52Low,
    string? MarketDataAvailability,
    string? ScannerValue);
