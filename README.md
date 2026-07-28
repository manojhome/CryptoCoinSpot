# CryptoTrader

A .NET 8 command-line app for CoinSpot instant buy/sell operations, historical
daily statistics, and hourly trend screening.

## Security first

The API key posted in chat should be considered exposed. Revoke it, create a new
CoinSpot full-access API key/secret pair, restrict its permissions and IPs where
possible, and never commit either value. This project does not contain credentials.

In PowerShell, set credentials only for the current terminal:

```powershell
$env:COINSPOT_API_KEY = "your-new-key"
$env:COINSPOT_API_SECRET = "your-new-secret"
```

CoinSpot requires both values. The key identifies the account; the secret signs
the exact JSON request body with HMAC-SHA512.

## Run

```powershell
dotnet build
dotnet run -- price BTC
dotnet run -- history BTC --years 5 --currency usd --csv
dotnet run -- trend
```

Review an instant quote before placing a live order:

```powershell
dotnet run -- quote-buy BTC 100 --amount-type aud
dotnet run -- buy BTC 100 --amount-type aud --confirm-live

dotnet run -- quote-sell BTC 0.001 --amount-type coin
dotnet run -- sell BTC 0.001 --amount-type coin --confirm-live
```

Without `--confirm-live`, `buy` and `sell` are blocked. Instant orders cannot be
cancelled after execution. Start with very small amounts.

## Data and analysis

CoinSpot's public API exposes current prices and only recent completed orders,
not five years of OHLC candles. Five-year daily candles therefore come from the
public Coinbase Exchange API in USD; hourly trend candles come from CoinGecko in
the requested quote currency (AUD by default). Supported mappings are BTC, ETH,
XRP, USDT, SOL, and USDC. Some assets may have less than five years of history
because the asset or its Coinbase USD market is newer.

`history` reports the low/high over the retrieved period, rolling 52-week
low/high, and the previous completed daily candle's low/high. `--csv` exports all
retrieved daily candles.

`trend` retrieves four days of hourly data and combines:

- last price versus 24-hour simple moving average
- 24-hour versus 72-hour simple moving average
- 24-hour percentage direction
- 14-period RSI

The result (`STRONG UP`, `UP`, `SIDEWAYS`, `DOWN`, or `STRONG DOWN`) is a
descriptive screen, not a prediction or trading instruction. Stablecoins are
included as requested, but their trend mostly reflects small deviations from
their peg and AUD/USD movement.

Public data providers can rate-limit or change their APIs. Do not automate live
orders without persistence, idempotency, reconciliation against CoinSpot order
history, maximum position limits, and alerting.
