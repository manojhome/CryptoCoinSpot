# CryptoCoinSpot ASP.NET Dashboard

A .NET 8 ASP.NET Core dashboard for paper-investment tracking, CoinSpot market
data, historical statistics, and hourly trend screening.

## Site access

The dashboard and all API routes are protected by a server-side password gate.
The hardcoded password is `TEST1234789!`. A successful login creates an
HttpOnly, SameSite=Strict session cookie; restarting the app invalidates existing
sessions. An incorrect password returns an **Access Denied** page.

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
The Crypto and Stock tabs switch between the existing crypto dashboard and a
separate ASX stock page.
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
not five years of OHLC candles. CLI five-year daily candles therefore come from
the public Coinbase Exchange API in USD; dashboard hourly and daily candles come
from KuCoin USDT markets and are converted to AUD using CoinSpot's USDT price.
Supported mappings for CLI five-year Coinbase history are BTC, ETH, XRP, USDT,
SOL, and USDC. Some assets may have less history because the asset or matching
market is newer.

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

## Moomoo US stock details and order panes

The Stock page includes a USD stock snapshot panel for up to 20 US tickers and
Buy/Sell order panes. **Connect Moomoo** uses the official OAuth 2.1 PKCE flow;
sign-in alone does not supply API credentials. Approve the required permissions
on Moomoo's authorization page yourself. Tokens are encrypted with ASP.NET Data
Protection in `Data/moomoo-tokens.json`, excluded from Git and never sent to the
browser. Data Protection keys are stored under `Data/moomoo-keys/`, excluded
from Git, and encrypted with Windows DPAPI for the current Windows user.
Retain that directory and Windows identity to retain access after restart.
On other hosts, configure an appropriate Data Protection key encryptor before
connecting a brokerage account.

The default callback is `http://localhost:55109/access/moomoo/callback`.
Set `Moomoo:RedirectUri` to the server's actual callback URL when running on
another port or host; remote callbacks require HTTPS.

The inspected browser account was labelled sandbox. Orders therefore remain
locked until a real production account is independently verified and configured
using `Moomoo:ProductionAccountVerified=true` and `Moomoo:ProductionAccountId`.
OAuth must also grant `trade:write` and access to that account. These settings
are not evidence of verification on their own; verify the account in Moomoo first.
Trading must be enabled again after each app restart. Orders are whole-share
LIMIT/DAY/RTH orders capped at US$10,000 before fees. Each review expires after
60 seconds and is consumed once before sending. No automatic retry occurs.
If an order times out or needs additional broker confirmation, reconcile its
status directly in Moomoo before placing another order. No live order was placed
during development. Production quotes and execution need an authorized account
to be verified end to end.

Run the isolated authorization and trading-gate checks with
`dotnet run --project tests/MoomooChecks/MoomooChecks.csproj`.

## ASX providers

The Stock page also has an **ASX 200 / Top 10 risers today** panel. Moomoo's
REST stock-quote and market-snapshot documentation currently excludes AU,
although its plate membership API lists AU. Until an Australian quote provider
and verified ASX 200 membership are connected, this panel reports unavailable
rather than displaying sandbox quotes or rankings from IBKR's 50-stock scanner.
The logged-in Moomoo developer dashboard inspected during setup had no existing
AppKeys and labelled the account as a sandbox. No credentials were created or
stored. See https://open.moomoo.com/api/quote/realtime/stock-quote.

The Stock tab reads ASX market leaders and price details through Interactive
Brokers' Client Portal Gateway. Brokerage credentials are deliberately never
stored in this app. Start the gateway on a private machine, open its login page,
sign in directly with IBKR, and complete MFA. The default local gateway URL is
`https://localhost:5000/v1/api/`.

For a gateway reachable through a private network, set its base URL before
starting the app:

```powershell
$env:IBKR_GATEWAY_BASE_URL = "https://your-private-gateway/v1/api/"
```

The equivalent ASP.NET setting is `IBKR:GatewayBaseUrl`. `IBKR:AsxLocation`
defaults to `STK.AU`, and `IBKR:ScannerType` defaults to `HIGH_MKT_CAP`. The
gateway session must be reauthenticated according to IBKR's session rules, and
Australian live prices require the applicable market-data subscription.

IBKR limits one market-scanner response to 50 contracts. The page accepts a
requested cap of 200 but truthfully displays the contracts returned by IBKR and
shows the provider limit. Azure App Service cannot reach a gateway running only
on a home computer; expose it only through an authenticated private network or
VPN, never by publishing the gateway directly to the internet.

## Stored daily prices

Dashboard requests merge completed daily candles into `Data/{COIN}-daily.json`.
Each requested ticker gets its own file. Pullback context uses the latest 365
stored entries, and can fall back to the local file when the daily provider is
temporarily unavailable. Generated JSON history files are local runtime data and
are excluded from Git; `Data/.gitkeep` preserves the directory in the repository.

TimelineData's **AllTime (up to 5 years)** option backfills as much of the latest
five years as the matching KuCoin market provides into the same permanent coin
file. Later requests reuse that file; if a new UTC day has completed, only recent
daily candles are fetched and merged. Entries older than the rolling five-year
window are removed when AllTime is requested. Daily chart labels use the UTC
candle date and include the year, avoiding the former local-hour suffix.

## Stored live transactions

Immediately above the permanent live-order history, the dashboard shows a
half-width three-hour candlestick chart and a half-width live price tape. The
chart uses CoinSpot five-minute history with a matching KuCoin fallback. The
Live button records CoinSpot's current AUD price once per minute, colours rises
green and falls red, and keeps the newest 15 observations; Stop pauses polling.

Every successful live Buy, Sell, or AutoSell submitted by this app is appended
to `Data/live-trades.json`, including prompt-free whole-row sells. The transaction
container uses weighted-average cost
for realized sell P/L and the current wallet rate for unrealized P/L. Sells made
against coins acquired outside this app show `N/A` until a recorded buy cost is
available. Each new entry stores an estimated fee using CoinSpot's current 1%
Instant Buy/Sell rate; older entries calculate the same estimate when displayed.
P/L is based on CoinSpot's returned totals, so the displayed fee is not deducted
again. The ledger is local runtime data and is excluded from Git.
### US Top 50 gainers

The stock page includes a sortable Top 50 gainers panel with stock, 3D average,
previous day, day before, trading-day change, 1H change and USD price. Moomoo's
US screening query sorts on one-day cumulative percentage change (3102), then
static profiles filter the first 300 results to active stocks; up to 50 are shown.
OTC stocks are included. Snapshot price/previous close supplies the displayed
day change. Daily candles supply the two previous completed sessions; completed
regular-session five-minute candles supply the one-hour change, requiring exact
60-minute separation within the same session. Missing history stays N/A.
Results are cached for two minutes with three concurrent history requests at most.
Clicking a stock loads its detail panel and submits no order.

### Moomoo holdings

The stock page starts with My holdings across all authorized accounts and markets,
with an optional account filter and each position's reported currency. It retrieves
positions through the server and shows shares, available shares, broker cost basis,
current price/value and broker-reported dollar/percentage P/L. Invalid cost or P/L
fields remain unavailable. The positions API does not provide purchase dates;
reported diluted cost may include prior sales, so this is not a date-specific
purchase return. Buy/Sell selects the holding and account in the existing reviewed
order form. It does not submit an order or bypass the production/trading gates.
