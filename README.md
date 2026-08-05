# CryptoCoinSpot ASP.NET Dashboard

A .NET 8 ASP.NET Core dashboard for paper-investment tracking, CoinSpot market
data, historical statistics, and hourly trend screening.

## Security first

The API key posted in chat should be considered exposed. Revoke it, create a new
CoinSpot full-access API key/secret pair, restrict its permissions and IPs where
possible, and never commit either value. This project does not contain credentials.

In PowerShell, set credentials only for the current terminal:

```powershell
$env:COINSPOT_API_KEY = "your-new-key"
$env:COINSPOT_API_SECRET = "your-new-secret"
```

Live order execution is disabled by default. Quotes can be requested when the
full-access credentials are configured. Enable execution only when you intend
to trade real funds:

```powershell
$env:COINSPOT_LIVE_TRADING_ENABLED = "true"
```

The equivalent user-secret settings are `CoinSpot:ApiKey`,
`CoinSpot:ApiSecret`, and `CoinSpot:LiveTradingEnabled`. Never store real
credentials in committed `appsettings.json`.

The wallet chart uses a separate CoinSpot **Read Only** API key. Create a
read-only key in CoinSpot and set it for the current terminal before starting
the app:

```powershell
$env:COINSPOT_READ_ONLY_API_KEY = "your-read-only-key"
$env:COINSPOT_READ_ONLY_API_SECRET = "your-read-only-secret"
```

Do not use a full-access key for the wallet chart. Wallet responses are marked
`no-store`, and the browser never receives either credential.

Alternatively, the empty `CoinSpot` section in `appsettings.json` can be filled
for local use. Do not commit real values. Environment variables take precedence
over values in the settings file.

CoinSpot requires both values. The key identifies the account; the secret signs
the exact JSON request body with HMAC-SHA512.

## Run the web app

```powershell
dotnet build
dotnet run
```

Open the local URL shown by ASP.NET. Enter a coin ticker (TRX by default) and
an AUD paper-investment amount. The responsive dashboard refreshes hourly and
shows price and investment-value charts, trend metrics, the five entry gates,
daily candles, stop level, profit targets, and two live CoinSpot trade panels.
Immediately above TimelineData, three refreshable cards show Current Price,
Hourly Trend, and Daily Trend. Current Price automatically requests a CoinSpot
sell quote and can be re-quoted on demand; it turns green when the quote rises
from the previously displayed price and red when it falls. Hourly and daily
refreshes update their own trend calculations without replacing that sell-quote
price. The former Paper Units and Current Value cards are no longer displayed.

The Buy and Sell panels require a fresh 60-second quote followed by an explicit
browser confirmation. Quote tokens are single-use, and execution applies a 1%
rate threshold. Instant orders cannot be cancelled after execution. Start with
very small amounts.

The Sell panel also includes an **AutoSell now** action. It obtains a fresh quote
and immediately submits the real sell order without a confirmation prompt. The
same balance checks, single-use token, live-trading setting, and 1% rate threshold
still apply.

Untouched buy rows in **My buy and sell transactions** also provide a live row
action. **Refresh quote** obtains a 60-second quote for the row's full coin amount
and updates its projected P/L. **Sell whole row** then submits that real sell order
immediately without another confirmation prompt. Partially or fully matched buys
cannot use this row action. Before quoting, the app refreshes the wallet balance,
caps the requested quantity to the amount CoinSpot currently reports as available,
and floors sell quantities to CoinSpot's eight-decimal coin precision. It checks
the wallet again at execution time and automatically refreshes the quote if the
available balance decreased during the quote window.

## Data and analysis

Top 50 gainers are selected from CoinSpot-listed coins. The **Prev day** and
**Day before** columns use the latest three completed KuCoin UTC daily candles
to calculate two close-to-close percentage changes. These values are independent
of the rolling 24H and 1H columns; a missing daily market is displayed as `N/A`
without removing the coin from the ranking.

CoinSpot's public API exposes current prices and only recent completed orders,
not five years of OHLC candles. Five-year daily candles therefore come from the
public Coinbase Exchange API in USD; dashboard hourly and daily candles come from
KuCoin USDT markets and are converted to AUD using CoinSpot's USDT price. Supported mappings
for five-year Coinbase history are BTC, ETH, XRP, USDT, SOL, and USDC. Some assets may have less than five years of history
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

TimelineData includes a 96-hour sell-timing panel. It groups hourly candles by
the browser's local hour to identify the window with the strongest average
intrahour peak, measures consecutive close-to-close green and red runs, and
calculates two descriptive thresholds. The profit target combines recent
positive momentum with the paper-entry break-even price after an estimated 1%
sell fee. The defensive level uses the 75th-percentile hourly decline and the
typical remaining red-streak length. With roughly four observations per hour of
day, this is a limited in-sample pattern, not a profit guarantee or forecast.

Public data providers can rate-limit or change their APIs. Do not automate live
orders without persistence, idempotency, reconciliation against CoinSpot order
history, maximum position limits, and alerting.

## Stored daily prices

Dashboard requests merge completed daily candles into `Data/{COIN}-daily.json`.
Each requested ticker gets its own file. Pullback context uses the latest 365
stored entries, and can fall back to the local file when the daily provider is
temporarily unavailable. Generated JSON history files are local runtime data and
are excluded from Git; `Data/.gitkeep` preserves the directory in the repository.

## Stored live transactions

Every successful live Buy, Sell, or AutoSell submitted by this app is appended
to `Data/live-trades.json`, including prompt-free whole-row sells. The transaction
container uses weighted-average cost
for realized sell P/L and the current wallet rate for unrealized P/L. Sells made
against coins acquired outside this app show `N/A` until a recorded buy cost is
available. Each new entry stores an estimated fee using CoinSpot's current 1%
Instant Buy/Sell rate; older entries calculate the same estimate when displayed.
P/L is based on CoinSpot's returned totals, so the displayed fee is not deducted
again. The ledger is local runtime data and is excluded from Git.
