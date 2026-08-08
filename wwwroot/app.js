const $ = id => document.getElementById(id);
let snapshot = null;
let gainersSnapshot = null;
let selectedGainerCoin = null;
let gainersSort = { key: "threeDayAverage", direction: "desc" };
let gainersRefreshedAt = null;
let walletSnapshot = null;
let selectedWalletCoin = null;
let priceHover = null;
let dailyPercentHover = null;
let dailyPercentData = [];
let pullbackHover = null;
let pullbackMarkers = null;
let pullbackCandles = [];
let strategySimulations = null;
let selectedStrategy = null;
let entryPrice = null;
let currentMetricPrice = null;
let currentQuoteRefreshInFlight = false;
let nextRefresh = null;
let timer = null;
let liveTradingStatus = { configured: false, enabled: false, ready: false };
const liveTradeQuotes = { buy: null, sell: null };
let liveSellAmountType = "coin";
let liveTransactionsSnapshot = [];
let hideSoldTransactions = true;
const liveRowSellQuotes = new Map();
const liveRowAutoProfitMonitors = new Map();
const liveRowPriceElements = new Map();
let liveRowPriceRefreshInFlight = false;
let intradayCandles = [];
let intradayHover = null;
let rowChartCandles = [];
let rowChartHover = null;
let rowChartRequestId = 0;
let liveTapeSamples = [];
let liveTapeCoin = null;
let liveTapeTimer = null;
let liveTapeRunning = false;
let liveTapeInFlight = false;
let liveTapeSessionId = 0;
const COIN_AMOUNT_EPSILON = 0.00000001;

const aud = (n, digits = 4) => `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const number = (n, digits = 4) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: digits });

$("analyse").addEventListener("click", analyse);
$("coin").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("amount").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("coin").addEventListener("input", syncLiveTradeCoin);
$("liveBuyQuote").addEventListener("click", () => requestLiveTradeQuote("buy"));
$("liveSellQuote").addEventListener("click", () => requestLiveTradeQuote("sell"));
$("liveBuyExecute").addEventListener("click", () => executeLiveTrade("buy"));
$("liveSellExecute").addEventListener("click", () => executeLiveTrade("sell"));
$("liveSellAuto").addEventListener("click", autoSellNow);
$("liveSellAmount").addEventListener("input", () => selectSellAmountType("coin"));
$("liveSellAudAmount").addEventListener("input", () => selectSellAmountType("aud"));
$("refreshCurrentPrice").addEventListener("click", refreshCurrentSellQuotePrice);
$("refreshHourlyTrend").addEventListener("click", () => refreshTrendMetric("hourly"));
$("refreshDailyTrend").addEventListener("click", () => refreshTrendMetric("daily"));
$("liveTapeStart").addEventListener("click", startLiveTape);
$("liveTapeStop").addEventListener("click", () => stopLiveTape());
$("toggleSoldTransactions").addEventListener("click", () => {
  hideSoldTransactions = !hideSoldTransactions;
  const button = $("toggleSoldTransactions");
  button.textContent = hideSoldTransactions ? "Show Sold" : "Hide Sold";
  button.setAttribute("aria-pressed", String(hideSoldTransactions));
  drawLiveTransactions();
});
$("rowChartClose").addEventListener("click", () => $("rowChartModal").close());
$("rowChartModal").addEventListener("click", event => {
  if (event.target === $("rowChartModal")) $("rowChartModal").close();
});
$("pullbackPeriod").addEventListener("change", async () => {
  pullbackHover = null;
  if (!snapshot) return;
  if ($("pullbackPeriod").value === "all") {
    await loadAllTimeHistory();
  } else {
    drawPullbackAnalysis(snapshot.daily);
  }
});
$("dailyPercentPeriod").addEventListener("change", () => {
  dailyPercentHover = null;
  if (snapshot) drawDailyPercentageAnalysis(snapshot.daily);
});
const strategySelectors = {
  threeRed: { id: "strategySummary", buyDays: 3, sellDays: 3 },
  twoRed: { id: "strategyTwoRedSummary", buyDays: 3, sellDays: 2 },
  twoGreen: { id: "strategyTwoGreenSummary", buyDays: 2, sellDays: 3 },
  twoGreenTwoRed: { id: "strategyTwoGreenTwoRedSummary", buyDays: 2, sellDays: 2 },
  optimal: { id: "strategyOptimalSummary", percentageBased: true }
};
Object.entries(strategySelectors).forEach(([key, config]) => {
  const element = $(config.id);
  const select = () => selectStrategy(key);
  element.addEventListener("click", select);
  element.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    select();
  });
});

function syncLiveTradeCoin() {
  const coin = $("coin").value.trim().toUpperCase() || "COIN";
  document.querySelectorAll(".tradeCoin").forEach(element => { element.textContent = coin; });
  for (const side of ["buy", "sell"]) {
    if (liveTradeQuotes[side] && liveTradeQuotes[side].coin !== coin) resetLiveTradeQuote(side);
  }
  updateSellWalletSummary();
}

function selectSellAmountType(amountType) {
  liveSellAmountType = amountType;
  if (amountType === "coin" && $("liveSellAmount").value.trim()) $("liveSellAudAmount").value = "";
  if (amountType === "aud" && $("liveSellAudAmount").value.trim()) $("liveSellAmount").value = "";
  $("liveSellMode").textContent = amountType === "aud"
    ? "Selling the coin amount equivalent to the entered AUD value"
    : "Selling by coin amount";
  resetLiveTradeQuote("sell");
}

function updateSellWalletSummary() {
  const coin = $("coin").value.trim().toUpperCase();
  const holding = walletSnapshot?.find(item => item.coin === coin);
  $("liveSellHoldingAmount").textContent = holding
    ? `${number(holding.balance, 8)} ${coin}`
    : walletSnapshot ? `0 ${coin || "COIN"}` : "Wallet unavailable";
  $("liveSellHoldingAud").textContent = holding
    ? aud(holding.audBalance, 2)
    : walletSnapshot ? aud(0, 2) : "Wallet unavailable";
}

function resetLiveTradeQuote(side) {
  liveTradeQuotes[side] = null;
  const prefix = side === "buy" ? "liveBuy" : "liveSell";
  $(`${prefix}Execute`).disabled = true;
  $(`${prefix}Result`).className = "trade-result";
  $(`${prefix}Result`).textContent = liveTradingStatus.configured
    ? "Request a fresh live quote before execution."
    : "Configure a full-access API key to request a quote.";
}

async function loadLiveTradingStatus() {
  const status = $("liveTradingStatus");
  try {
    const response = await fetch("/api/coinspot/trading/status", { cache: "no-store" });
    const data = await readApiJson(response, "Trading status");
    if (!response.ok) throw new Error(data.detail || data.error || "Trading status failed.");
    liveTradingStatus = data;
    $("liveBuyQuote").disabled = !data.configured;
    $("liveSellQuote").disabled = !data.configured;
    $("liveSellAuto").disabled = !data.ready;
    $("refreshCurrentPrice").disabled = !data.configured;
    status.className = `trade-status ${data.ready ? "ready" : "blocked"}`;
    status.textContent = data.ready
      ? "LIVE EXECUTION ENABLED"
      : data.configured
        ? "QUOTE ONLY · EXECUTION DISABLED"
        : "FULL-ACCESS API NOT CONFIGURED";
    resetLiveTradeQuote("buy");
    resetLiveTradeQuote("sell");
    drawLiveTransactions();
    if (data.configured && snapshot) refreshCurrentSellQuotePrice();
  } catch (error) {
    status.className = "trade-status blocked";
    status.textContent = "TRADING STATUS UNAVAILABLE";
    $("liveBuyResult").textContent = error.message;
    $("liveSellResult").textContent = error.message;
    $("liveSellAuto").disabled = true;
    $("refreshCurrentPrice").disabled = true;
    drawLiveTransactions();
  }
}

async function requestLiveTradeQuote(side, keepAutoSellDisabled = false) {
  const isBuy = side === "buy";
  const prefix = isBuy ? "liveBuy" : "liveSell";
  const coin = $("coin").value.trim().toUpperCase();
  const amountType = isBuy ? "aud" : liveSellAmountType;
  const amountInput = !isBuy && amountType === "aud" ? $("liveSellAudAmount") : $(`${prefix}Amount`);
  const amount = Number(amountInput.value);
  const quoteButton = $(`${prefix}Quote`);
  const executeButton = $(`${prefix}Execute`);
  const result = $(`${prefix}Result`);
  if (!/^[A-Z0-9]{2,10}$/.test(coin)) { showTradeFailure(result, "Enter a valid coin ticker first."); return null; }
  if (!Number.isFinite(amount) || amount <= 0) { showTradeFailure(result, "Enter a positive trade amount."); return null; }
  if (!isBuy && walletSnapshot) {
    const holding = walletSnapshot.find(item => item.coin === coin);
    if (!holding) { showTradeFailure(result, `Your CoinSpot wallet has no ${coin} available to sell.`); return null; }
    if (amountType === "coin" && amount > Number(holding.balance)) {
      showTradeFailure(result, `Coin amount exceeds your ${number(holding.balance, 8)} ${coin} wallet balance.`); return null;
    }
    if (amountType === "aud" && amount > Number(holding.audBalance)) {
      showTradeFailure(result, `AUD amount exceeds the current ${aud(holding.audBalance, 2)} wallet value.`); return null;
    }
  }

  quoteButton.disabled = true;
  executeButton.disabled = true;
  if (!isBuy) $("liveSellAuto").disabled = true;
  result.className = "trade-result";
  result.textContent = "Requesting a live CoinSpot quote…";
  try {
    const response = await fetch(`/api/coinspot/trading/${side}/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coin, amount, amountType })
    });
    const data = await readApiJson(response, `${side} quote`);
    if (!response.ok) throw new Error(data.error || data.detail || `${side} quote failed.`);
    liveTradeQuotes[side] = data;
    const estimate = isBuy
      ? `${number(amount / Number(data.rate), 8)} ${coin}`
      : amountType === "aud"
        ? `${number(amount / Number(data.rate), 8)} ${coin} for ${aud(amount, 2)}`
        : aud(amount * Number(data.rate), 2);
    result.className = "trade-result success";
    result.textContent = `Live rate ${aud(data.rate, Number(data.rate) < 1 ? 8 : 2)} · estimated ${estimate} · expires in 60 seconds.`;
    executeButton.disabled = !liveTradingStatus.ready;
    return data;
  } catch (error) {
    liveTradeQuotes[side] = null;
    showTradeFailure(result, error.message);
    return null;
  } finally {
    quoteButton.disabled = !liveTradingStatus.configured;
    if (!isBuy && !keepAutoSellDisabled) $("liveSellAuto").disabled = !liveTradingStatus.ready;
  }
}

async function executeLiveTrade(side, skipConfirmation = false) {
  const quote = liveTradeQuotes[side];
  if (!quote || !liveTradingStatus.ready) return;
  const isBuy = side === "buy";
  const prefix = isBuy ? "liveBuy" : "liveSell";
  const result = $(`${prefix}Result`);
  const action = side.toUpperCase();
  const amountDescription = isBuy
    ? `${aud(quote.amount, 2)} of ${quote.coin}`
    : quote.amountType === "aud"
      ? `${aud(quote.amount, 2)} worth of ${quote.coin}`
      : `${number(quote.amount, 8)} ${quote.coin}`;
  if (!skipConfirmation && !window.confirm(`REAL COINSPOT ORDER\n\n${action} ${amountDescription}\n\nThis uses real funds and cannot be undone. Continue?`)) return;

  $("liveBuyExecute").disabled = true;
  $("liveSellExecute").disabled = true;
  if (!isBuy) $("liveSellAuto").disabled = true;
  result.className = "trade-result";
  result.textContent = `Submitting LIVE ${action} order…`;
  try {
    const response = await fetch(`/api/coinspot/trading/${side}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coin: quote.coin,
        amount: quote.amount,
        amountType: quote.amountType,
        quoteToken: quote.quoteToken,
        confirmation: `LIVE ${action} ${quote.coin}`
      })
    });
    const data = await readApiJson(response, `${side} execution`);
    if (!response.ok) throw new Error(data.error || data.detail || `${side} execution failed.`);
    const order = data.order || {};
    result.className = "trade-result success";
    result.textContent = `LIVE ${action} completed · ${number(order.amount ?? quote.amount, 8)} ${quote.coin} · total ${aud(order.total ?? 0, 2)}.` +
      (data.persistenceWarning ? ` WARNING: ${data.persistenceWarning}` : "");
    liveTradeQuotes[side] = null;
    await Promise.all([loadWallet(), loadLiveTransactions()]);
  } catch (error) {
    liveTradeQuotes[side] = null;
    showTradeFailure(result, error.message);
  } finally {
    $(`${prefix}Quote`).disabled = !liveTradingStatus.configured;
    if (!isBuy) $("liveSellAuto").disabled = !liveTradingStatus.ready;
  }
}

async function autoSellNow() {
  if (!liveTradingStatus.ready) return;
  $("liveSellAuto").disabled = true;
  const quote = await requestLiveTradeQuote("sell", true);
  if (!quote) {
    $("liveSellAuto").disabled = !liveTradingStatus.ready;
    return;
  }
  await executeLiveTrade("sell", true);
}

function showTradeFailure(element, message) {
  element.className = "trade-result failure";
  element.textContent = message;
}

async function loadLiveTransactions() {
  const status = $("liveTransactionsStatus");
  try {
    const response = await fetch("/api/coinspot/trading/transactions", { cache: "no-store" });
    const data = await readApiJson(response, "Live transactions");
    if (!response.ok) throw new Error(data.error || data.detail || "Transaction history failed.");
    liveTransactionsSnapshot = data.items || [];
    drawLiveTransactions();
    refreshLiveRowPrices();
    status.textContent = `${liveTransactionsSnapshot.length} transactions · Data/live-trades.json`;
  } catch (error) {
    liveTransactionsSnapshot = [];
    drawLiveTransactions();
    status.textContent = `Unavailable: ${error.message}`;
  }
}

function drawLiveTransactions() {
  const body = $("liveTransactionsBody");
  const summaries = $("liveTransactionSummaries");
  body.replaceChildren();
  summaries.replaceChildren();
  liveRowPriceElements.clear();
  if (!liveTransactionsSnapshot.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 11;
    cell.textContent = "No live transactions recorded through this app yet.";
    row.appendChild(cell); body.appendChild(row);
    return;
  }

  const currentRates = new Map((walletSnapshot || []).map(item => [item.coin, Number(item.rateAud)]));
  const states = new Map();
  const rowPnl = new Map();
  const buyLots = new Map();
  const chronological = [...liveTransactionsSnapshot].sort(
    (left, right) => new Date(left.executedAt) - new Date(right.executedAt));

  chronological.forEach((transaction, index) => {
    const coin = transaction.coin;
    const state = states.get(coin) || { quantity: 0, cost: 0, realized: 0, fees: 0, matchedSells: 0, unmatchedSells: 0 };
    const coinAmount = Number(transaction.coinAmount);
    const totalAud = Number(transaction.totalAud);
    state.fees += transactionFeeAud(transaction);
    if (transaction.side === "buy") {
      state.quantity += coinAmount;
      state.cost += totalAud;
      const lots = buyLots.get(coin) || [];
      lots.push({ transaction, original: coinAmount, remaining: coinAmount, totalAud });
      buyLots.set(coin, lots);
      const currentRate = currentRates.get(coin);
      rowPnl.set(index, Number.isFinite(currentRate)
        ? { value: (currentRate - Number(transaction.executionRate)) * coinAmount, label: "vs current rate" }
        : null);
    } else {
      let sellRemaining = coinAmount;
      for (const lot of buyLots.get(coin) || []) {
        if (sellRemaining <= COIN_AMOUNT_EPSILON) break;
        const consumed = Math.min(lot.remaining, sellRemaining);
        lot.remaining -= consumed;
        sellRemaining -= consumed;
        if (lot.remaining <= COIN_AMOUNT_EPSILON) lot.remaining = 0;
      }
      const matched = Math.min(Math.max(state.quantity, 0), coinAmount);
      if (matched > 0 && state.quantity > 0) {
        const averageCost = state.cost / state.quantity;
        const matchedProceeds = totalAud * (matched / coinAmount);
        const realized = matchedProceeds - averageCost * matched;
        state.realized += realized;
        state.matchedSells += 1;
        state.quantity -= matched;
        state.cost = Math.max(0, state.cost - averageCost * matched);
        if (state.quantity <= COIN_AMOUNT_EPSILON) {
          state.quantity = 0;
          state.cost = 0;
        }
        rowPnl.set(index, { value: realized, label: matched < coinAmount ? "partial realized" : "realized" });
      } else {
        state.unmatchedSells += 1;
        rowPnl.set(index, null);
      }
    }
    states.set(coin, state);
  });

  [...states.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([coin, state]) => {
    const currentRate = currentRates.get(coin);
    const hasUnrealized = state.quantity <= 0 || Number.isFinite(currentRate);
    const unrealized = state.quantity > 0 && Number.isFinite(currentRate)
      ? state.quantity * currentRate - state.cost
      : 0;
    const total = hasUnrealized ? state.realized + unrealized : null;
    const card = document.createElement("div");
    card.className = `transaction-summary ${total == null ? "" : total >= 0 ? "profit" : "loss"}`;
    const heading = document.createElement("strong");
    heading.textContent = `${coin} ${total == null ? "P/L unavailable" : formatPnl(total)}`;
    const detail = document.createElement("span");
    detail.textContent = `Realized ${formatPnl(state.realized)} · Unrealized ${hasUnrealized ? formatPnl(unrealized) : "N/A"} · Fees ${aud(state.fees, 2)}` +
      (state.unmatchedSells ? ` · ${state.unmatchedSells} sell(s) lack recorded buy cost` : "");
    card.append(heading, detail); summaries.appendChild(card);
  });

  const pnlByTransaction = new Map();
  chronological.forEach((transaction, index) => pnlByTransaction.set(transaction, rowPnl.get(index)));
  const saleNowByTransaction = new Map();
  for (const [coin, lots] of buyLots) {
    const currentRate = currentRates.get(coin);
    for (const lot of lots) {
      const soldAmount = lot.original - lot.remaining;
      if (soldAmount <= COIN_AMOUNT_EPSILON) {
        saleNowByTransaction.set(lot.transaction, Number.isFinite(currentRate)
          ? {
              sellableAmount: lot.original,
              costAud: lot.totalAud,
              value: lot.original * currentRate * .99 - lot.totalAud,
              label: `at ${aud(currentRate, currentRate < 1 ? 8 : 2)} after est. 1% sell fee`
            }
          : { sellableAmount: lot.original, costAud: lot.totalAud, status: "Current rate unavailable" });
      } else {
        saleNowByTransaction.set(lot.transaction, {
          status: lot.remaining > COIN_AMOUNT_EPSILON ? "Partially sold" : "Sold"
        });
      }
    }
  }
  const displayedTransactions = [...liveTransactionsSnapshot].sort(
    (left, right) => new Date(right.executedAt) - new Date(left.executedAt)).filter(transaction => {
      if (!hideSoldTransactions) return true;
      if (transaction.side === "sell") return false;
      return saleNowByTransaction.get(transaction)?.status !== "Sold";
    });
  if (!displayedTransactions.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 11;
    cell.textContent = "All sold transactions are hidden.";
    row.appendChild(cell); body.appendChild(row);
    return;
  }
  displayedTransactions.forEach(transaction => {
      const row = document.createElement("tr");
      row.className = "transaction-selectable-row";
      row.tabIndex = 0;
      row.setAttribute("aria-label", `Analyse ${transaction.coin} and view transaction actions`);
      row.addEventListener("click", () => analyseTransactionCoin(transaction.coin));
      row.addEventListener("keydown", event => {
        if (event.target !== row) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        analyseTransactionCoin(transaction.coin);
      });
      appendTransactionCell(row, new Date(transaction.executedAt).toLocaleString("en-AU"));
      appendTransactionCell(row, transaction.coin);
      const sideCell = document.createElement("td");
      const side = document.createElement("span");
      side.className = `transaction-side ${transaction.side}`;
      side.textContent = transaction.side.toUpperCase();
      sideCell.appendChild(side); row.appendChild(sideCell);
      appendTransactionCell(row, number(transaction.coinAmount, 8));
      appendTransactionCell(row, aud(transaction.totalAud, 2));
      appendTransactionCell(row, aud(transaction.executionRate, Number(transaction.executionRate) < 1 ? 8 : 2));
      appendTransactionCell(row, aud(transactionFeeAud(transaction), 2));
      const pnlCell = document.createElement("td");
      const pnl = pnlByTransaction.get(transaction);
      pnlCell.className = `transaction-pnl ${pnl == null ? "" : pnl.value >= 0 ? "profit" : "loss"}`;
      pnlCell.textContent = pnl == null ? "N/A" : formatPnl(pnl.value);
      if (pnl) {
        const note = document.createElement("small"); note.textContent = pnl.label; pnlCell.appendChild(note);
      }
      row.appendChild(pnlCell);
      const currentPriceCell = document.createElement("td");
      currentPriceCell.className = "transaction-current-price";
      const currentPrice = document.createElement("small");
      currentPrice.className = "transaction-row-price";
      currentPrice.textContent = "Loading…";
      currentPriceCell.appendChild(currentPrice);
      row.appendChild(currentPriceCell);
      const saleNowCell = document.createElement("td");
      const saleNow = transaction.side === "buy" ? saleNowByTransaction.get(transaction) : null;
      if (saleNow?.value != null) {
        saleNowCell.className = `transaction-pnl ${saleNow.value >= 0 ? "profit" : "loss"}`;
        saleNowCell.textContent = formatPnl(saleNow.value);
        const note = document.createElement("small"); note.textContent = saleNow.label; saleNowCell.appendChild(note);
      } else {
        saleNowCell.textContent = transaction.side === "buy" ? saleNow?.status || "N/A" : "—";
      }
      liveRowPriceElements.set(liveRowTransactionKey(transaction), {
        element: currentPrice,
        transaction,
        saleNow
      });
      row.appendChild(createLiveRowSellCell(transaction, saleNow, saleNowCell));
      row.appendChild(saleNowCell); body.appendChild(row);
    });
}

function analyseTransactionCoin(coin) {
  const normalizedCoin = String(coin || "").trim().toUpperCase();
  if (!normalizedCoin) return;
  $("coin").value = normalizedCoin;
  syncLiveTradeCoin();
  analyse();
}

function liveRowTransactionKey(transaction) {
  return transaction.id || `${transaction.executedAt}|${transaction.coin}|${transaction.coinAmount}`;
}

function createLiveRowSellCell(transaction, saleNow, saleNowCell) {
  const cell = document.createElement("td");
  cell.className = "transaction-row-actions";
  const key = liveRowTransactionKey(transaction);
  const chartButton = document.createElement("button");
  chartButton.type = "button";
  chartButton.className = "row-chart-button";
  chartButton.textContent = "24h chart";
  chartButton.addEventListener("click", () => openLiveRowChart(transaction.coin));
  if (transaction.side !== "buy") {
    cell.appendChild(chartButton);
    return cell;
  }
  if (!saleNow?.sellableAmount) {
    cell.appendChild(chartButton);
    const status = document.createElement("small");
    status.className = "transaction-row-quote";
    status.textContent = saleNow?.status || "Sell unavailable";
    cell.appendChild(status);
    return cell;
  }

  const buttons = document.createElement("div");
  buttons.className = "transaction-row-buttons";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Refresh quote";
  refreshButton.disabled = !liveTradingStatus.configured;
  const sellButton = document.createElement("button");
  sellButton.type = "button";
  sellButton.className = "row-sell-button";
  sellButton.textContent = "Sell whole row";
  sellButton.disabled = true;
  const targetButtons = document.createElement("div");
  targetButtons.className = "auto-profit-buttons";
  for (const target of [2, 3, 4]) {
    const targetButton = document.createElement("button");
    targetButton.type = "button";
    targetButton.className = "auto-profit-button";
    targetButton.textContent = `Sell +${target}%`;
    targetButton.disabled = !liveTradingStatus.ready;
    targetButton.setAttribute("aria-pressed", String(liveRowAutoProfitMonitors.get(key)?.target === target));
    targetButton.addEventListener("click", () => toggleAutoProfitMonitor(transaction, saleNow, target));
    targetButtons.appendChild(targetButton);
  }
  const quoteStatus = document.createElement("small");
  quoteStatus.className = "transaction-row-quote";
  quoteStatus.textContent = liveTradingStatus.configured
    ? ""
    : "Full-access trading API unavailable";
  buttons.append(chartButton, refreshButton, sellButton);
  const monitorStatus = document.createElement("small");
  monitorStatus.className = "auto-profit-status";
  const monitor = liveRowAutoProfitMonitors.get(key);
  monitorStatus.textContent = monitor
    ? `AUTO +${monitor.target}% armed · checked every 5 minutes while this page is open`
    : "";
  cell.append(buttons, targetButtons, monitorStatus, quoteStatus);

  const existing = liveRowSellQuotes.get(key);
  if (existing && new Date(existing.expiresAt).getTime() > Date.now()) {
    showLiveRowQuote(existing, saleNow, saleNowCell, quoteStatus);
    sellButton.disabled = !liveTradingStatus.ready;
  } else {
    liveRowSellQuotes.delete(key);
  }
  refreshButton.addEventListener("click", () => requestLiveRowSellQuote(
    transaction, saleNow, refreshButton, sellButton, quoteStatus, saleNowCell));
  sellButton.addEventListener("click", () => executeLiveRowSell(
    transaction, refreshButton, sellButton, quoteStatus));
  return cell;
}

function toggleAutoProfitMonitor(transaction, saleNow, target) {
  const key = liveRowTransactionKey(transaction);
  const existing = liveRowAutoProfitMonitors.get(key);
  if (existing?.target === target) {
    liveRowAutoProfitMonitors.delete(key);
  } else {
    liveRowAutoProfitMonitors.set(key, {
      transaction,
      saleNow,
      target,
      nextCheckAt: 0,
      busy: false
    });
  }
  drawLiveTransactions();
  refreshLiveRowPrices();
}

async function refreshLiveRowPrices() {
  if (liveRowPriceRefreshInFlight || !liveRowPriceElements.size) return;
  liveRowPriceRefreshInFlight = true;
  const entries = [...liveRowPriceElements.entries()];
  const coins = [...new Set(entries.map(([, item]) => item.transaction.coin))];
  const prices = new Map();
  await Promise.all(coins.map(async coin => {
    try {
      const response = await fetch(`/api/coinspot/price/${encodeURIComponent(coin)}`, { cache: "no-store" });
      const data = await readApiJson(response, `${coin} minute price`);
      if (!response.ok) throw new Error(data.error || data.detail || "Price failed.");
      prices.set(coin, { price: Number(data.price) });
    } catch (error) {
      prices.set(coin, { error: error.message });
    }
  }));

  const missingCoins = coins.filter(coin => !Number.isFinite(prices.get(coin)?.price));
  if (missingCoins.length) {
    try {
      const walletResponse = await fetch("/api/coinspot/wallet", { cache: "no-store" });
      const wallet = await readApiJson(walletResponse, "Minute wallet rates");
      if (!walletResponse.ok) throw new Error(wallet.error || wallet.detail || "Wallet rates failed.");
      const walletRates = new Map((wallet.items || []).map(item => [item.coin, Number(item.rateAud)]));
      for (const coin of missingCoins) {
        const walletRate = walletRates.get(coin);
        if (Number.isFinite(walletRate) && walletRate > 0)
          prices.set(coin, { price: walletRate, source: "wallet rate" });
      }
    } catch {
      // Keep each public-price error when the read-only wallet fallback is unavailable.
    }
  }

  const updatedAt = new Date().toLocaleTimeString("en-AU", {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  for (const [key, item] of entries) {
    if (liveRowPriceElements.get(key)?.element !== item.element) continue;
    const result = prices.get(item.transaction.coin);
    if (!Number.isFinite(result?.price)) {
      item.element.className = "transaction-row-price failure";
      item.element.textContent = `Minute price unavailable · ${result?.error || "unknown error"}`;
      continue;
    }
    const price = result.price;
    const netProfit = item.saleNow?.sellableAmount && item.saleNow?.costAud
      ? price * Number(item.saleNow.sellableAmount) * .99 / Number(item.saleNow.costAud) * 100 - 100
      : null;
    item.element.className = `transaction-row-price ${netProfit == null ? "" : netProfit >= 0 ? "profit" : "loss"}`;
    item.element.textContent = `Minute price ${aud(price, price < 1 ? 8 : 2)}${result.source ? ` (${result.source})` : ""}${netProfit == null ? "" : ` · net ${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}%`} · ${updatedAt}`;
  }

  const now = Date.now();
  const due = [...liveRowAutoProfitMonitors.entries()]
    .filter(([, monitor]) => !monitor.busy && now >= monitor.nextCheckAt);
  await Promise.all(due.map(([key, monitor]) => checkAutoProfitMonitor(key, monitor)));
  liveRowPriceRefreshInFlight = false;
}

async function checkAutoProfitMonitor(key, monitor) {
  monitor.busy = true;
  monitor.nextCheckAt = Date.now() + 5 * 60_000;
  const priceItem = liveRowPriceElements.get(key);
  try {
    if (!liveTradingStatus.ready) throw new Error("Live execution is not enabled.");
    const holding = await fetchCurrentWalletHolding(monitor.transaction.coin);
    const amount = Math.min(Number(monitor.saleNow.sellableAmount), Number(holding.balance));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("No wallet balance is available to sell.");

    const quoteResponse = await fetch("/api/coinspot/trading/sell/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coin: monitor.transaction.coin, amount, amountType: "coin" })
    });
    const quote = await readApiJson(quoteResponse, "Automatic profit sell quote");
    if (!quoteResponse.ok) throw new Error(quote.error || quote.detail || "Automatic sell quote failed.");
    const allocatedCost = Number(monitor.saleNow.costAud) * Number(quote.amount) / Number(monitor.saleNow.sellableAmount);
    const quotedNetProfit = Number(quote.amount) * Number(quote.rate) * .99 / allocatedCost * 100 - 100;
    if (quotedNetProfit + .000001 < monitor.target) {
      if (priceItem?.element) priceItem.element.title = `Latest executable quote net profit ${quotedNetProfit.toFixed(2)}%; target +${monitor.target}%.`;
      return;
    }

    const executeResponse = await fetch("/api/coinspot/trading/sell/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coin: quote.coin,
        amount: quote.amount,
        amountType: "coin",
        quoteToken: quote.quoteToken,
        confirmation: `LIVE SELL ${quote.coin}`
      })
    });
    const result = await readApiJson(executeResponse, "Automatic profit sell");
    if (!executeResponse.ok) throw new Error(result.error || result.detail || "Automatic sell failed.");
    liveRowAutoProfitMonitors.delete(key);
    await Promise.all([loadWallet(), loadLiveTransactions()]);
  } catch (error) {
    if (priceItem?.element) {
      priceItem.element.className = "transaction-row-price failure";
      priceItem.element.title = error.message;
    }
  } finally {
    monitor.busy = false;
  }
}

async function openLiveRowChart(coin) {
  const modal = $("rowChartModal");
  const status = $("rowChartStatus");
  const canvas = $("rowChartCanvas");
  const requestId = ++rowChartRequestId;
  rowChartCandles = [];
  rowChartHover = null;
  $("rowChartTitle").textContent = `${coin} · 24-hour price`;
  canvas.setAttribute("aria-label", `${coin} 24-hour 15-minute candlestick chart`);
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  status.className = "row-chart-status";
  status.textContent = "Loading 15-minute candles…";
  if (!modal.open) modal.showModal();
  try {
    const response = await fetch(`/api/market/${encodeURIComponent(coin)}/24h`, { cache: "no-store" });
    const data = await readApiJson(response, "24-hour row chart");
    if (!response.ok) throw new Error(data.error || data.detail || "24-hour candles failed.");
    if (requestId !== rowChartRequestId || !modal.open) return;
    rowChartCandles = data.candles || [];
    if (!rowChartCandles.length) throw new Error("No 15-minute candles were returned.");
    drawPriceCandles(canvas, rowChartCandles, rowChartHover);
    status.textContent = `${rowChartCandles.length} candles · ${data.source} · updated ${new Date(data.refreshedAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (requestId !== rowChartRequestId) return;
    status.className = "row-chart-status failure";
    status.textContent = `Chart unavailable: ${error.message}`;
  }
}

$("rowChartCanvas").addEventListener("mousemove", event => {
  if (!rowChartCandles.length) return;
  const canvas = $("rowChartCanvas");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const left = 70, right = 16, top = 18, bottom = 38;
  const step = (canvas.clientWidth - left - right) / rowChartCandles.length;
  const index = Math.floor((x - left) / step);
  rowChartHover = index < 0 || index >= rowChartCandles.length || y < top || y > canvas.clientHeight - bottom
    ? null
    : { index, x, y };
  drawPriceCandles(canvas, rowChartCandles, rowChartHover);
});
$("rowChartCanvas").addEventListener("mouseleave", () => {
  rowChartHover = null;
  if (rowChartCandles.length) drawPriceCandles($("rowChartCanvas"), rowChartCandles);
});

function showLiveRowQuote(quote, saleNow, saleNowCell, quoteStatus) {
  const rate = Number(quote.rate);
  const quotedAmount = Number(quote.amount);
  const estimatedProceeds = quotedAmount * rate;
  quoteStatus.className = "transaction-row-quote success";
  quoteStatus.textContent = `${aud(rate, rate < 1 ? 8 : 2)} · selling ${number(quotedAmount, 8)} ${quote.coin} · est. ${aud(estimatedProceeds, 2)} · expires in 60s`;
  const allocatedCost = Number(saleNow.costAud) * quotedAmount / Number(saleNow.sellableAmount);
  const projected = estimatedProceeds * .99 - allocatedCost;
  saleNowCell.className = `transaction-pnl ${projected >= 0 ? "profit" : "loss"}`;
  saleNowCell.replaceChildren(document.createTextNode(formatPnl(projected)));
  const note = document.createElement("small");
  note.textContent = `${quote.rowAmountAdjusted ? "capped to available wallet balance · " : ""}at live quote after est. 1% sell fee`;
  saleNowCell.appendChild(note);
}

async function requestLiveRowSellQuote(transaction, saleNow, refreshButton, sellButton, quoteStatus, saleNowCell) {
  refreshButton.disabled = true;
  sellButton.disabled = true;
  quoteStatus.className = "transaction-row-quote";
  quoteStatus.textContent = "Requesting live CoinSpot sell quote…";
  try {
    const holding = await fetchCurrentWalletHolding(transaction.coin);
    const availableAmount = Number(holding?.balance);
    const sellAmount = Math.min(Number(saleNow.sellableAmount), availableAmount);
    const response = await fetch("/api/coinspot/trading/sell/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coin: transaction.coin, amount: sellAmount, amountType: "coin" })
    });
    const quote = await readApiJson(response, "Row sell quote");
    if (!response.ok) throw new Error(quote.error || quote.detail || "Sell quote failed.");
    quote.rowAmountAdjusted = Number(quote.amount) < Number(saleNow.sellableAmount);
    liveRowSellQuotes.set(liveRowTransactionKey(transaction), quote);
    showLiveRowQuote(quote, saleNow, saleNowCell, quoteStatus);
    sellButton.disabled = !liveTradingStatus.ready;
  } catch (error) {
    liveRowSellQuotes.delete(liveRowTransactionKey(transaction));
    quoteStatus.className = "transaction-row-quote failure";
    quoteStatus.textContent = error.message;
  } finally {
    refreshButton.disabled = !liveTradingStatus.configured;
  }
}

async function executeLiveRowSell(transaction, refreshButton, sellButton, quoteStatus) {
  const key = liveRowTransactionKey(transaction);
  let quote = liveRowSellQuotes.get(key);
  if (!quote || new Date(quote.expiresAt).getTime() <= Date.now()) {
    liveRowSellQuotes.delete(key);
    sellButton.disabled = true;
    quoteStatus.className = "transaction-row-quote failure";
    quoteStatus.textContent = "Quote expired. Refresh it before selling.";
    return;
  }

  refreshButton.disabled = true;
  sellButton.disabled = true;
  quoteStatus.className = "transaction-row-quote";
  quoteStatus.textContent = `Submitting LIVE SELL for ${number(quote.amount, 8)} ${quote.coin}…`;
  try {
    const holding = await fetchCurrentWalletHolding(quote.coin);
    const availableAmount = Number(holding.balance);
    if (availableAmount < Number(quote.amount)) {
      quoteStatus.textContent = "Wallet balance changed · refreshing the quote before LIVE SELL…";
      const refreshResponse = await fetch("/api/coinspot/trading/sell/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coin: quote.coin, amount: availableAmount, amountType: "coin" })
      });
      const refreshedQuote = await readApiJson(refreshResponse, "Adjusted row sell quote");
      if (!refreshResponse.ok) throw new Error(refreshedQuote.error || refreshedQuote.detail || "Adjusted sell quote failed.");
      quote = refreshedQuote;
      liveRowSellQuotes.set(key, quote);
    }
    const response = await fetch("/api/coinspot/trading/sell/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coin: quote.coin,
        amount: quote.amount,
        amountType: "coin",
        quoteToken: quote.quoteToken,
        confirmation: `LIVE SELL ${quote.coin}`
      })
    });
    const data = await readApiJson(response, "Row sell execution");
    if (!response.ok) throw new Error(data.error || data.detail || "Sell execution failed.");
    liveRowSellQuotes.delete(key);
    quoteStatus.className = "transaction-row-quote success";
    quoteStatus.textContent = `LIVE SELL completed${data.persistenceWarning ? ` · ${data.persistenceWarning}` : ""}`;
    await Promise.all([loadWallet(), loadLiveTransactions()]);
  } catch (error) {
    liveRowSellQuotes.delete(key);
    quoteStatus.className = "transaction-row-quote failure";
    quoteStatus.textContent = error.message;
    refreshButton.disabled = !liveTradingStatus.configured;
  }
}

async function fetchCurrentWalletHolding(coin) {
  const walletResponse = await fetch("/api/coinspot/wallet", { cache: "no-store" });
  const wallet = await readApiJson(walletResponse, "Current wallet balance");
  if (!walletResponse.ok) throw new Error(wallet.error || wallet.detail || "Current wallet balance failed.");
  const holding = (wallet.items || []).find(item => item.coin === coin);
  const availableAmount = Number(holding?.balance);
  if (!Number.isFinite(availableAmount) || availableAmount <= 0) {
    throw new Error(`Your CoinSpot wallet has no available ${coin} to sell.`);
  }
  return holding;
}

function appendTransactionCell(row, value) {
  const cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell);
}

function formatPnl(value) {
  return `${value >= 0 ? "+" : "−"}${aud(Math.abs(value), 2)}`;
}

function transactionFeeAud(transaction) {
  const storedFee = Number(transaction.feeAud);
  return Number.isFinite(storedFee) && storedFee > 0
    ? storedFee
    : Number(transaction.totalAud) * .01;
}

async function loadIntradayCandles(coin) {
  const status = $("intradayStatus");
  status.textContent = `Loading ${coin}…`;
  intradayHover = null;
  try {
    const response = await fetch(`/api/intraday/${encodeURIComponent(coin)}`, { cache: "no-store" });
    const data = await readApiJson(response, "Three-hour candles");
    if (!response.ok) throw new Error(data.error || data.detail || "Three-hour candles failed.");
    intradayCandles = data.candles || [];
    if (!intradayCandles.length) throw new Error("No recent candles were returned.");
    drawPriceCandles($("intradayChart"), intradayCandles, intradayHover);
    const provider = data.source.startsWith("CoinSpot") && !data.source.includes("KuCoin")
      ? "CoinSpot"
      : "KuCoin fallback";
    status.textContent = `${coin} · ${intradayCandles.length} candles · ${provider} · ${new Date(data.refreshedAt).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    intradayCandles = [];
    const canvas = $("intradayChart");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    status.textContent = `Unavailable: ${error.message}`;
  }
}

function renderLiveTape() {
  const body = $("liveTapeBody");
  if (!liveTapeSamples.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No live price transactions yet.";
    row.appendChild(cell);
    body.replaceChildren(row);
    return;
  }

  const rows = liveTapeSamples.map(sample => {
    const row = document.createElement("tr");
    row.className = `tape-${sample.direction}`;
    appendTransactionCell(row, new Date(sample.time).toLocaleTimeString("en-AU", {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }));
    appendTransactionCell(row, sample.coin);
    appendTransactionCell(row, aud(sample.price, sample.price < 1 ? 8 : 2));
    const move = sample.changePercent == null
      ? "FIRST"
      : `${sample.changePercent >= 0 ? "↑ +" : "↓ "}${sample.changePercent.toFixed(3)}%`;
    appendTransactionCell(row, move);
    return row;
  });
  body.replaceChildren(...rows);
}

async function refreshLiveTape(sessionId) {
  if (!liveTapeRunning || liveTapeInFlight || sessionId !== liveTapeSessionId) return;
  liveTapeInFlight = true;
  try {
    const response = await fetch(`/api/coinspot/price/${encodeURIComponent(liveTapeCoin)}`, { cache: "no-store" });
    const data = await readApiJson(response, "Live CoinSpot price");
    if (!response.ok) throw new Error(data.error || data.detail || "Live CoinSpot price failed.");
    if (!liveTapeRunning || sessionId !== liveTapeSessionId) return;
    const price = Number(data.price);
    const previous = liveTapeSamples[0]?.price;
    const changePercent = Number.isFinite(previous) && previous > 0 ? (price / previous - 1) * 100 : null;
    const direction = changePercent == null ? "flat" : changePercent > 0 ? "up" : changePercent < 0 ? "down" : "flat";
    liveTapeSamples.unshift({ coin: data.coin, price, time: Date.now(), changePercent, direction });
    liveTapeSamples = liveTapeSamples.slice(0, 15);
    renderLiveTape();
    $("liveTapeStatus").textContent = `Live · ${liveTapeSamples.length}/15 · updated ${new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · next update in 1 minute`;
  } catch (error) {
    if (liveTapeRunning && sessionId === liveTapeSessionId)
      $("liveTapeStatus").textContent = `Live update failed: ${error.message} · retrying in 1 minute`;
  } finally {
    liveTapeInFlight = false;
  }
}

async function startLiveTape() {
  const coin = $("coin").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(coin)) {
    $("liveTapeStatus").textContent = "Enter a valid coin ticker before starting live updates.";
    return;
  }
  stopLiveTape(false);
  liveTapeCoin = coin;
  liveTapeSamples = [];
  liveTapeRunning = true;
  const sessionId = ++liveTapeSessionId;
  renderLiveTape();
  $("liveTapeStart").disabled = true;
  $("liveTapeStop").disabled = false;
  $("liveTapeStatus").textContent = `Starting live ${coin} updates…`;
  await refreshLiveTape(sessionId);
  if (!liveTapeRunning || sessionId !== liveTapeSessionId) return;
  liveTapeTimer = setInterval(() => refreshLiveTape(sessionId), 60_000);
}

function stopLiveTape(updateStatus = true) {
  liveTapeRunning = false;
  liveTapeInFlight = false;
  liveTapeSessionId++;
  if (liveTapeTimer) clearInterval(liveTapeTimer);
  liveTapeTimer = null;
  $("liveTapeStart").disabled = false;
  $("liveTapeStop").disabled = true;
  if (updateStatus)
    $("liveTapeStatus").textContent = `Stopped · ${liveTapeSamples.length} of 15 price transactions retained.`;
}

$("priceChart").addEventListener("mousemove", event => {
  if (!snapshot?.hourly?.length) return;
  const canvas = $("priceChart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const left = 82, right = 12, top = 14, bottom = 34;
  const step = (canvas.clientWidth - left - right) / snapshot.hourly.length;
  const index = Math.floor((x - left) / step);
  if (index < 0 || index >= snapshot.hourly.length || y < top || y > canvas.clientHeight - bottom) {
    priceHover = null;
  } else {
    priceHover = { index, y };
  }
  drawPriceCandles(canvas, snapshot.hourly, priceHover);
});
$("priceChart").addEventListener("mouseleave", () => {
  priceHover = null;
  if (snapshot) drawPriceCandles($("priceChart"), snapshot.hourly);
});
$("intradayChart").addEventListener("mousemove", event => {
  if (!intradayCandles.length) return;
  const canvas = $("intradayChart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const left = 82, right = 12, top = 14, bottom = 34;
  const step = (canvas.clientWidth - left - right) / intradayCandles.length;
  const index = Math.floor((x - left) / step);
  intradayHover = index < 0 || index >= intradayCandles.length || y < top || y > canvas.clientHeight - bottom
    ? null
    : { index, y };
  drawPriceCandles(canvas, intradayCandles, intradayHover);
});
$("intradayChart").addEventListener("mouseleave", () => {
  intradayHover = null;
  if (intradayCandles.length) drawPriceCandles($("intradayChart"), intradayCandles);
});
$("dailyPercentChart").addEventListener("mousemove", event => {
  if (!dailyPercentData.length) return;
  const canvas = $("dailyPercentChart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const left = 54, right = 12, top = 14, bottom = 34;
  const step = (canvas.clientWidth - left - right) / dailyPercentData.length;
  const index = Math.floor((x - left) / step);
  dailyPercentHover = index < 0 || index >= dailyPercentData.length || y < top || y > canvas.clientHeight - bottom
    ? null
    : { index, y };
  drawDailyPercentageBars(canvas, dailyPercentData, dailyPercentHover);
});
$("dailyPercentChart").addEventListener("mouseleave", () => {
  dailyPercentHover = null;
  if (dailyPercentData.length) drawDailyPercentageBars($("dailyPercentChart"), dailyPercentData);
});
$("pullbackChart").addEventListener("mousemove", event => {
  if (!pullbackCandles.length) return;
  const canvas = $("pullbackChart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const left = 82, right = 12, top = 14, bottom = 34;
  const step = (canvas.clientWidth - left - right) / pullbackCandles.length;
  const index = Math.floor((x - left) / step);
  pullbackHover = index < 0 || index >= pullbackCandles.length || y < top || y > canvas.clientHeight - bottom
    ? null
    : { index, y };
  drawPriceCandles(canvas, pullbackCandles, pullbackHover, pullbackMarkers);
});
$("pullbackChart").addEventListener("mouseleave", () => {
  pullbackHover = null;
  if (pullbackCandles.length) drawPriceCandles($("pullbackChart"), pullbackCandles, null, pullbackMarkers);
});
$("gainersChart").addEventListener("click", async event => {
  if (!gainersSnapshot?.length || $("analyse").disabled) return;
  const canvas = $("gainersChart");
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.clientWidth / rect.width;
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  if (y < 26) {
    const sortKey = gainerSortKeyAtPosition(x, canvas.clientWidth);
    if (!sortKey) return;
    gainersSort = {
      key: sortKey,
      direction: gainersSort.key === sortKey && gainersSort.direction === "desc" ? "asc" : "desc"
    };
    gainersSnapshot = sortGainers(gainersSnapshot);
    drawGainers(gainersSnapshot);
    updateGainersStatus();
    return;
  }
  const rowIndex = Math.floor((y - 26) / 29);
  if (rowIndex < 0) return;
  const selectedCoin = gainersSnapshot[rowIndex];
  if (!selectedCoin) return;
  selectedGainerCoin = selectedCoin.coin;
  drawGainers(gainersSnapshot);
  $("coin").value = selectedCoin.coin;
  await analyse();
  const timeline = $("timelineData");
  timeline.scrollIntoView({ behavior: "smooth", block: "start" });
  timeline.focus({ preventScroll: true });
});
$("walletChart").addEventListener("click", async event => {
  if (!walletSnapshot?.length || $("analyse").disabled) return;
  const canvas = $("walletChart");
  const rect = canvas.getBoundingClientRect();
  const y = (event.clientY - rect.top) * canvas.clientHeight / rect.height;
  const rowIndex = Math.floor(y / 34);
  const selectedHolding = walletSnapshot[rowIndex];
  if (!selectedHolding || selectedHolding.coin === "AUD") return;
  selectedWalletCoin = selectedHolding.coin;
  drawWallet(walletSnapshot);
  $("coin").value = selectedHolding.coin;
  syncLiveTradeCoin();
  await analyse();
  const timeline = $("timelineData");
  timeline.scrollIntoView({ behavior: "smooth", block: "start" });
  timeline.focus({ preventScroll: true });
});
window.addEventListener("resize", () => {
  if (snapshot) drawCharts(snapshot);
  if (gainersSnapshot) drawGainers(gainersSnapshot);
  if (walletSnapshot) drawWallet(walletSnapshot);
  if (intradayCandles.length) drawPriceCandles($("intradayChart"), intradayCandles, intradayHover);
  if ($("rowChartModal").open && rowChartCandles.length)
    drawPriceCandles($("rowChartCanvas"), rowChartCandles, rowChartHover);
});

async function analyse(isAutomatic = false) {
  const coin = $("coin").value.trim().toUpperCase();
  syncLiveTradeCoin();
  const amount = Number($("amount").value);
  if (!coin || !Number.isFinite(amount) || amount <= 0) return showError("Enter a coin ticker and a positive AUD amount.");

  $("analyse").disabled = true;
  $("refreshState").textContent = "Updating";
  hideError();
  $("dashboard").hidden = false;
  if (gainersSnapshot) drawGainers(gainersSnapshot);
  if (walletSnapshot) drawWallet(walletSnapshot);
  try {
    const response = await fetch(`/api/dashboard?coin=${encodeURIComponent(coin)}&amount=${encodeURIComponent(amount)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.detail || "Market update failed.");
    if (!isAutomatic || !snapshot || snapshot.coin !== data.coin || snapshot.amount !== data.amount) entryPrice = data.currentPrice;
    snapshot = data;
    render(data);
    loadIntradayCandles(data.coin);
    if (liveTapeRunning && liveTapeCoin !== data.coin) startLiveTape();
    nextRefresh = Date.now() + 60 * 60 * 1000;
    if (!timer) timer = setInterval(tick, 1000);
  } catch (error) {
    showError(error.message);
    clearMarketSections();
    $("refreshState").textContent = "Update failed";
  } finally {
    $("analyse").disabled = false;
  }
}

function clearMarketSections() {
  snapshot = null;
  currentMetricPrice = null;
  pullbackMarkers = null;
  pullbackCandles = [];
  dailyPercentData = [];
  dailyPercentHover = null;
  strategySimulations = null;
  for (const id of ["priceChart", "dailyPercentChart", "pullbackChart"]) {
    const canvas = $(id);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  $("priceRange").textContent = "Unavailable";
  $("dailyPercentRange").textContent = "Unavailable";
  $("dailyRangeAverage").textContent = "Avg —";
  $("dailyTrend").textContent = "—";
  $("dailyTrend").className = "trend-neutral";
  $("dailyTrendMeta").textContent = "Unavailable";
  $("currentPriceRetrieved").textContent = "Price unavailable";
  $("currentPriceSource").textContent = "AUD market price";
  $("currentPrice").className = "trend-neutral";
  $("dailyRows").innerHTML = "";
  $("pullbackChartRange").textContent = "Unavailable";
  $("sellTimingConfidence").textContent = "Hourly data unavailable";
  $("bestSellTime").textContent = "—";
  $("bestSellTimeMeta").textContent = "Waiting for data";
  $("hourlySellStreak").textContent = "—";
  $("hourlySellStreakMeta").textContent = "Waiting for data";
  $("hourlyProfitTarget").textContent = "—";
  $("hourlyProfitTargetMeta").textContent = "Waiting for data";
  $("hourlyDefensivePrice").textContent = "—";
  $("hourlyDefensivePriceMeta").textContent = "Waiting for data";
  $("sellTimingSummary").textContent = "Hourly sell-timing analysis is unavailable.";
  $("hourlyStreakCard").className = "sell-timing-card neutral";
  for (const id of ["greenTripleRuns", "redTripleRuns", "greenDoubleRuns", "redDoubleRuns", "averageGreenRun", "averageRedRun"])
    $(id).textContent = "—";
  $("strategySummary").className = "strategy-summary neutral";
  $("strategyTwoRedSummary").className = "strategy-summary neutral";
  $("strategyTwoGreenSummary").className = "strategy-summary neutral";
  $("strategyTwoGreenTwoRedSummary").className = "strategy-summary neutral";
  $("strategyOptimalSummary").className = "strategy-summary neutral";
  $("strategyEndingValue").textContent = "—";
  $("strategyTwoRedEndingValue").textContent = "—";
  $("strategyTwoGreenEndingValue").textContent = "—";
  $("strategyTwoGreenTwoRedEndingValue").textContent = "—";
  $("strategyOptimalEndingValue").textContent = "—";
  $("strategyPnl").textContent = "Market data unavailable";
  $("strategyTwoRedPnl").textContent = "Market data unavailable";
  $("strategyTwoGreenPnl").textContent = "Market data unavailable";
  $("strategyTwoGreenTwoRedPnl").textContent = "Market data unavailable";
  $("strategyOptimalPnl").textContent = "Market data unavailable";
  for (const id of [
    "strategyEntries", "strategyExits", "strategyPosition",
    "strategyContributed", "strategyTwoRedEntries", "strategyTwoRedExits",
    "strategyTwoRedPosition", "strategyTwoRedContributed",
    "strategyTwoGreenEntries", "strategyTwoGreenExits", "strategyTwoGreenPosition",
    "strategyTwoGreenContributed", "strategyTwoGreenTwoRedEntries",
    "strategyTwoGreenTwoRedExits", "strategyTwoGreenTwoRedPosition",
    "strategyTwoGreenTwoRedContributed", "strategyOptimalEntries",
    "strategyOptimalExits", "strategyOptimalPosition", "strategyOptimalContributed",
    "strategyOptimalBuyThreshold", "strategyOptimalSellThreshold"
  ])
    $(id).textContent = "—";
  $("signal").textContent = "—";
  $("explanation").textContent = "Market data is temporarily unavailable. Wallet and gainers can still refresh independently.";
}

function renderCurrentPriceMetric(price, source, retrievedAt, direction = "neutral") {
  const value = Number(price);
  $("currentPrice").textContent = aud(value, value < 1 ? 8 : 2);
  $("currentPrice").className = direction === "up"
    ? "trend-up"
    : direction === "down"
      ? "trend-down"
      : "trend-neutral";
  $("currentPriceSource").textContent = source;
  const retrieved = new Date(retrievedAt || Date.now()).toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  $("currentPriceRetrieved").textContent = `Retrieved ${retrieved}`;
}

function renderHourlyTrendMetric(trend) {
  $("trend").textContent = trend.trend;
  const direction = trend.trend.toUpperCase();
  $("trend").className = direction.includes("UP")
    ? "trend-up"
    : direction.includes("DOWN")
      ? "trend-down"
      : "trend-neutral";
  const percentage = document.createElement("span");
  percentage.className = "trend-percentage";
  percentage.textContent = `${Number(trend.change24HoursPercent) >= 0 ? "+" : ""}${Number(trend.change24HoursPercent).toFixed(2)}%`;
  $("trendMeta").replaceChildren(
    document.createTextNode("24h "),
    percentage,
    document.createTextNode(` · RSI ${Number(trend.rsi14).toFixed(1)}`));
}

function renderDailyTrendMetric(daily, price) {
  const previousDailyClose = Number(daily.at(-1).close);
  const dailyMove = (Number(price) / previousDailyClose - 1) * 100;
  const direction = dailyMove > 0 ? "UP" : dailyMove < 0 ? "DOWN" : "FLAT";
  $("dailyTrend").textContent = direction;
  $("dailyTrend").className = dailyMove > 0
    ? "trend-up"
    : dailyMove < 0
      ? "trend-down"
      : "trend-neutral";
  const percentage = document.createElement("span");
  percentage.className = "trend-percentage";
  percentage.textContent = `${dailyMove >= 0 ? "+" : ""}${dailyMove.toFixed(2)}%`;
  $("dailyTrendMeta").replaceChildren(
    percentage,
    document.createTextNode(` today · previous close ${aud(previousDailyClose, 6)}`));
  return dailyMove;
}

async function refreshCurrentSellQuotePrice() {
  if (currentQuoteRefreshInFlight) return;
  const button = $("refreshCurrentPrice");
  const coin = $("coin").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(coin)) return;
  const previousPrice = currentMetricPrice;
  const holding = walletSnapshot?.find(item => item.coin === coin);
  const hasHolding = Number(holding?.balance) > 0;
  const amount = hasHolding ? Number(holding.balance) : 10;
  const amountType = hasHolding ? "coin" : "aud";
  currentQuoteRefreshInFlight = true;
  button.disabled = true;
  button.textContent = "Refreshing…";
  $("currentPriceRetrieved").textContent = "Requesting live CoinSpot sell quote…";
  try {
    const response = await fetch("/api/coinspot/trading/sell/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coin, amount, amountType })
    });
    const quote = await readApiJson(response, "Current sell quote");
    if (!response.ok) throw new Error(quote.error || quote.detail || "Current sell quote failed.");
    const quotePrice = Number(quote.rate);
    const direction = Number.isFinite(previousPrice)
      ? quotePrice > previousPrice ? "up" : quotePrice < previousPrice ? "down" : "neutral"
      : "neutral";
    currentMetricPrice = quotePrice;
    const quoteBasis = amountType === "coin"
      ? `${number(quote.amount, 8)} ${coin} wallet quote`
      : `${aud(quote.amount, 2)} reference quote`;
    renderCurrentPriceMetric(quotePrice, `Live CoinSpot sell quote · ${quoteBasis}`, Date.now(), direction);
    if (snapshot?.daily?.length) renderDailyTrendMetric(snapshot.daily, quotePrice);
    if (snapshot?.hourly?.length) renderHourlySellTiming(snapshot.hourly, quotePrice);
  } catch (error) {
    $("currentPriceRetrieved").textContent = `Quote unavailable: ${error.message}`;
  } finally {
    button.textContent = "↻ Refresh";
    button.disabled = !liveTradingStatus.configured;
    currentQuoteRefreshInFlight = false;
  }
}

async function refreshTrendMetric(section) {
  const button = section === "hourly" ? $("refreshHourlyTrend") : $("refreshDailyTrend");
  const targetMeta = section === "hourly" ? $("trendMeta") : $("dailyTrendMeta");
  const coin = $("coin").value.trim().toUpperCase();
  const amount = Number($("amount").value);
  if (!/^[A-Z0-9]{2,10}$/.test(coin) || !Number.isFinite(amount) || amount <= 0) return;
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    const response = await fetch(`/api/dashboard?coin=${encodeURIComponent(coin)}&amount=${encodeURIComponent(amount)}`, { cache: "no-store" });
    const data = await readApiJson(response, `${section} trend refresh`);
    if (!response.ok) throw new Error(data.error || data.detail || `${section} trend refresh failed.`);
    if (section === "hourly") {
      snapshot = { ...snapshot, hourly: data.hourly, trend: data.trend };
      renderHourlyTrendMetric(data.trend);
      const prices = data.hourly.map(item => Number(item.price));
      drawPriceCandles($("priceChart"), data.hourly, priceHover);
      $("priceRange").textContent = `${aud(Math.min(...prices), 4)} — ${aud(Math.max(...prices), 4)}`;
      renderHourlySellTiming(data.hourly, currentMetricPrice ?? Number(data.currentPrice));
    } else {
      snapshot = { ...snapshot, daily: data.daily };
      renderDailyTrendMetric(data.daily, currentMetricPrice ?? Number(data.currentPrice));
    }
  } catch (error) {
    targetMeta.textContent = `Refresh failed: ${error.message}`;
  } finally {
    button.textContent = "↻ Refresh";
    button.disabled = false;
  }
}

function render(data) {
  $("dashboard").hidden = false;
  if (gainersSnapshot) drawGainers(gainersSnapshot);
  if (walletSnapshot) drawWallet(walletSnapshot);
  $("signal").textContent = data.signal.action;
  $("signal").className = `signal ${data.signal.action.startsWith("BUY") ? "buy" : ""}`;
  $("explanation").textContent = data.signal.explanation;
  currentMetricPrice = Number(data.currentPrice);
  renderCurrentPriceMetric(currentMetricPrice, data.currentPriceSource, data.currentPriceRetrievedAt || data.refreshedAt);
  if (liveTradingStatus.configured) refreshCurrentSellQuotePrice();
  renderHourlyTrendMetric(data.trend);
  const dailyMove = renderDailyTrendMetric(data.daily, currentMetricPrice);

  const checks = [
    [data.signal.isAboveMovingAverage, `Above 20-day average (${aud(data.signal.movingAverage20, 6)})`],
    [data.signal.pullbackRedDays >= 2 && data.signal.pullbackRedDays <= 3, `${data.signal.pullbackRedDays} red pullback days (need 2–3)`],
    [data.signal.support > 0, `Support identified near ${aud(data.signal.support, 4)}`],
    [data.signal.hasGreenBreakout, "Green close above previous high"],
    [data.signal.hasAboveAverageVolume, "Confirmation volume above average"]
  ];
  $("rules").innerHTML = checks.map(([pass, text]) => `<li class="${pass ? "pass" : ""}">${escapeHtml(text)}</li>`).join("");
  $("stop").textContent = aud(data.plan.stop, 6);
  $("firstTarget").textContent = aud(data.plan.firstTarget, 6);
  $("finalTarget").textContent = aud(data.plan.finalTarget, 6);
  $("maxRisk").textContent = aud(data.plan.maxRiskAud, 2);

  const week52Low = Math.min(...data.daily.map(x => Number(x.low)));
  const week52High = Math.max(...data.daily.map(x => Number(x.high)));
  $("week52Low").textContent = `52W low ${aud(week52Low, 6)}`;
  $("week52High").textContent = `52W high ${aud(week52High, 6)}`;
  const direction = dailyMove > 0 ? "up" : dailyMove < 0 ? "down" : "neutral";
  const card = $("pullbackCard");
  card.classList.remove("up", "down", "neutral");
  card.classList.add(direction);
  $("dailyDirection").textContent = direction === "up"
    ? `↑ ${dailyMove.toFixed(2)}% vs yesterday`
    : direction === "down"
      ? `↓ ${Math.abs(dailyMove).toFixed(2)}% vs yesterday`
      : "Unchanged vs yesterday";

  const firstVisibleIndex = Math.max(0, data.daily.length - 365);
  $("dailyRows").innerHTML = data.daily.slice(firstVisibleIndex).map((x, visibleIndex) => {
    const sourceIndex = firstVisibleIndex + visibleIndex;
    const previousClose = sourceIndex > 0 ? Number(data.daily[sourceIndex - 1].close) : Number(x.close);
    const close = Number(x.close);
    const high = Number(x.high);
    const low = Number(x.low);
    const dailyRange = high - low;
    const dailyRangePercent = low ? dailyRange / low * 100 : 0;
    const changePercent = previousClose ? (close / previousClose - 1) * 100 : 0;
    const rowDirection = close > previousClose ? "day-up" : close < previousClose ? "day-down" : "day-flat";
    return `<tr class="${rowDirection}">
      <td>${new Date(x.time).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })}</td>
      <td>${number(x.open, 5)}</td><td>${number(high, 5)}</td><td>${number(low, 5)}</td>
      <td class="range-cell">${number(dailyRange, 5)} <small>(${dailyRangePercent.toFixed(2)}%)</small></td><td>${number(close, 5)}</td>
      <td class="change-cell">${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%</td>
    </tr>`;
  }).reverse().join("");
  $("refreshState").textContent = "Live paper view";
  drawCharts(data);
}

function drawCharts(data) {
  const prices = data.hourly.map(x => Number(x.price));
  drawPriceCandles($("priceChart"), data.hourly, priceHover);
  $("priceRange").textContent = `${aud(Math.min(...prices), 4)} — ${aud(Math.max(...prices), 4)}`;
  renderHourlySellTiming(data.hourly, Number(data.currentPrice));
  drawDailyPercentageAnalysis(data.daily);
  drawPullbackAnalysis(data.daily);
}

function renderHourlySellTiming(candles, currentPrice) {
  if (!candles?.length || !Number.isFinite(currentPrice) || currentPrice <= 0) return;
  const ordered = [...candles].sort((left, right) => new Date(left.time) - new Date(right.time));
  const hourlyGroups = new Map();
  const closeMoves = [];
  const ranges = [];
  const directions = [];

  ordered.forEach((candle, index) => {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    if (open > 0) {
      const hour = new Date(candle.time).getHours();
      const group = hourlyGroups.get(hour) || { hour, peakMoves: [], returns: [], green: 0, count: 0 };
      group.peakMoves.push((high / open - 1) * 100);
      group.returns.push((close / open - 1) * 100);
      group.green += close >= open ? 1 : 0;
      group.count += 1;
      hourlyGroups.set(hour, group);
      ranges.push((high - low) / open * 100);
    }
    if (index > 0) {
      const previousClose = Number(ordered[index - 1].close);
      const move = previousClose > 0 ? (close / previousClose - 1) * 100 : 0;
      closeMoves.push(move);
      directions.push(move > 0 ? "up" : move < 0 ? "down" : "flat");
    }
  });

  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const groups = [...hourlyGroups.values()].map(group => ({
    ...group,
    averagePeak: average(group.peakMoves),
    averageReturn: average(group.returns),
    greenRate: group.count ? group.green / group.count * 100 : 0
  }));
  const best = groups.sort((left, right) =>
    (right.averagePeak + Math.max(0, right.averageReturn) * .35) -
    (left.averagePeak + Math.max(0, left.averageReturn) * .35))[0];
  if (!best) return;

  const runs = { up: [], down: [] };
  let activeDirection = null;
  let activeLength = 0;
  for (const direction of directions) {
    if (direction === "flat") {
      if (activeDirection) runs[activeDirection].push(activeLength);
      activeDirection = null;
      activeLength = 0;
    } else if (direction === activeDirection) {
      activeLength += 1;
    } else {
      if (activeDirection) runs[activeDirection].push(activeLength);
      activeDirection = direction;
      activeLength = 1;
    }
  }
  if (activeDirection) runs[activeDirection].push(activeLength);

  const currentDirection = directions.at(-1) || "flat";
  let currentStreak = 0;
  for (let index = directions.length - 1; index >= 0 && directions[index] === currentDirection; index--) currentStreak += 1;
  const averageUpRun = average(runs.up) || 1;
  const averageDownRun = average(runs.down) || 1;
  const expectedUpHours = Math.max(1, Math.min(3,
    Math.round(averageUpRun - (currentDirection === "up" ? currentStreak - 1 : 0))));
  const expectedDownHours = Math.max(1, Math.min(3,
    Math.round(averageDownRun - (currentDirection === "down" ? currentStreak - 1 : 0))));
  const positiveMoves = closeMoves.filter(move => move > 0);
  const negativeMoves = closeMoves.filter(move => move < 0).map(Math.abs);
  const averageRange = average(ranges);
  const profitMovePercent = Math.max(
    hourlyPercentile(positiveMoves, .65) * expectedUpHours,
    averageRange * .5,
    .05);
  const defensiveMovePercent = Math.max(
    hourlyPercentile(negativeMoves, .75) * expectedDownHours,
    averageRange * .5,
    .05);
  const momentumTarget = currentPrice * (1 + profitMovePercent / 100);
  const feeAdjustedEntry = Number(entryPrice) > 0 ? Number(entryPrice) / .99 : currentPrice;
  const profitTarget = Math.max(momentumTarget, feeAdjustedEntry);
  const defensivePrice = currentPrice * (1 - defensiveMovePercent / 100);
  const priceDigits = currentPrice < 1 ? 8 : 2;

  const start = new Date(2020, 0, 1, best.hour);
  const end = new Date(2020, 0, 1, best.hour + 1);
  const timeFormat = { hour: "numeric", minute: "2-digit" };
  $("bestSellTime").textContent = `${start.toLocaleTimeString("en-AU", timeFormat)}–${end.toLocaleTimeString("en-AU", timeFormat)}`;
  $("bestSellTimeMeta").textContent = `Avg intrahour peak +${best.averagePeak.toFixed(2)}% · ${best.greenRate.toFixed(0)}% green · local time`;
  $("sellTimingConfidence").textContent = `${ordered.length} candles · ${best.count} observations in selected hour · limited sample`;

  const streakLabel = currentDirection === "up" ? "GREEN" : currentDirection === "down" ? "RED" : "FLAT";
  $("hourlySellStreak").textContent = currentDirection === "flat" ? streakLabel : `${currentStreak} × ${streakLabel}`;
  $("hourlySellStreakMeta").textContent = `Average green ${averageUpRun.toFixed(1)}h · average red ${averageDownRun.toFixed(1)}h`;
  $("hourlyStreakCard").className = `sell-timing-card ${currentDirection}`;

  $("hourlyProfitTarget").textContent = aud(profitTarget, priceDigits);
  $("hourlyProfitTargetMeta").textContent = `Momentum +${profitMovePercent.toFixed(2)}% · not below paper-entry break-even after est. 1% sell fee`;
  $("hourlyDefensivePrice").textContent = aud(defensivePrice, priceDigits);
  $("hourlyDefensivePriceMeta").textContent = `${defensiveMovePercent.toFixed(2)}% below current · 75th-percentile fall over ${expectedDownHours} expected hour(s)`;

  $("sellTimingSummary").textContent = currentDirection === "down"
    ? `Price has declined for ${currentStreak} consecutive hour(s). The defensive level is active as a modelled loss-control threshold; a break below it suggests the decline is larger than the recent 96-hour pattern.`
    : currentDirection === "up"
      ? `Price has risen for ${currentStreak} consecutive hour(s). The model favours watching the profit target near the observed sell window as the green run approaches its typical length.`
      : "The latest hourly close is flat. Use the target and defensive level as a range until a new consecutive direction develops.";
}

function hourlyPercentile(values, percentile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function drawDailyPercentageAnalysis(allCandles) {
  const requestedDays = Number($("dailyPercentPeriod").value) || 183;
  dailyPercentData = allCandles.slice(-requestedDays).map(candle => {
    const open = Number(candle.open);
    const close = Number(candle.close);
    return {
      time: candle.time,
      change: open ? (close / open - 1) * 100 : 0
    };
  });
  if (!dailyPercentData.length) return;
  const changes = dailyPercentData.map(x => x.change);
  const minimum = Math.min(...changes);
  const maximum = Math.max(...changes);
  const signedPercent = value => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  $("dailyPercentRange").textContent = `${dailyPercentData.length} days · ${signedPercent(minimum)} — ${signedPercent(maximum)}`;
  drawDailyPercentageBars($("dailyPercentChart"), dailyPercentData, dailyPercentHover);
}

function drawPullbackAnalysis(allCandles) {
  const selectedPeriod = $("pullbackPeriod").value;
  const requestedDays = selectedPeriod === "all"
    ? allCandles.length
    : Number(selectedPeriod) || 183;
  pullbackCandles = allCandles.slice(-requestedDays);
  if (!pullbackCandles.length) return;
  const dailyLows = pullbackCandles.map(x => Number(x.low));
  const dailyHighs = pullbackCandles.map(x => Number(x.high));
  const dailyRanges = pullbackCandles.map(x => {
    const low = Number(x.low);
    const difference = Number(x.high) - low;
    return { difference, percentage: low ? difference / low * 100 : 0 };
  });
  const averageRange = dailyRanges.reduce((total, value) => total + value.difference, 0) / dailyRanges.length;
  const averageRangePercent = dailyRanges.reduce((total, value) => total + value.percentage, 0) / dailyRanges.length;
  $("dailyRangeAverage").textContent = `Avg ${number(averageRange, 5)} (${averageRangePercent.toFixed(2)}%)`;
  const periodLabel = selectedPeriod === "all" ? `AllTime · up to 5 years · ${pullbackCandles.length} days` : `${pullbackCandles.length} days`;
  $("pullbackChartRange").textContent = `${periodLabel} · ${aud(Math.min(...dailyLows), 4)} — ${aud(Math.max(...dailyHighs), 4)}`;
  renderStreakMetrics(pullbackCandles);
  const investmentAmount = Number(snapshot?.amount) || 1000;
  strategySimulations = renderStrategySimulation(pullbackCandles, investmentAmount);
  updateSelectedStrategyMarkers();
  drawPriceCandles($("pullbackChart"), pullbackCandles, pullbackHover, pullbackMarkers);
}

async function loadAllTimeHistory() {
  const period = $("pullbackPeriod");
  period.disabled = true;
  $("pullbackChartRange").textContent = "Loading up to five years from the permanent daily file…";
  hideError();
  try {
    const response = await fetch(`/api/history/${encodeURIComponent(snapshot.coin)}`);
    const data = await readApiJson(response, "AllTime history");
    if (!response.ok) throw new Error(data.error || data.detail || "AllTime history update failed.");
    snapshot.daily = data.daily;
    drawPullbackAnalysis(snapshot.daily);
  } catch (error) {
    showError(error.message);
    $("pullbackChartRange").textContent = "AllTime history unavailable";
  } finally {
    period.disabled = false;
  }
}

function selectStrategy(key) {
  selectedStrategy = key;
  updateSelectedStrategyMarkers();
  if (pullbackCandles.length)
    drawPriceCandles($("pullbackChart"), pullbackCandles, pullbackHover, pullbackMarkers);
}

function updateSelectedStrategyMarkers() {
  Object.entries(strategySelectors).forEach(([key, config]) => {
    const selected = key === selectedStrategy;
    $(config.id).classList.toggle("selected", selected);
    $(config.id).setAttribute("aria-pressed", String(selected));
  });
  if (!selectedStrategy) {
    pullbackMarkers = null;
    $("selectedBuyLegend").textContent = "Select a strategy container to show signals";
    $("selectedSellLegend").textContent = "Buy and sell lines are hidden by default";
    return;
  }
  const config = strategySelectors[selectedStrategy];
  if (!strategySimulations) return;
  const result = strategySimulations[selectedStrategy];
  if (config.percentageBased) {
    $("selectedBuyLegend").textContent = `Selected: buy at +${result.buyThreshold.toFixed(2)}% daily`;
    $("selectedSellLegend").textContent = `Sell at −${result.sellThreshold.toFixed(2)}% daily`;
  } else {
    $("selectedBuyLegend").textContent = `Selected: buy after ${config.buyDays} green`;
    $("selectedSellLegend").textContent = `Sell after ${config.sellDays} red`;
  }
  pullbackMarkers = { buys: result.buyIndexes, sells: result.sellIndexes };
}

function renderStreakMetrics(candles) {
  const runs = { green: [], red: [] };
  let direction = null;
  let length = 0;
  const finishRun = () => {
    if (direction && length) runs[direction].push(length);
    direction = null;
    length = 0;
  };

  candles.forEach(candle => {
    const open = Number(candle.open), close = Number(candle.close);
    const nextDirection = close > open ? "green" : close < open ? "red" : null;
    if (!nextDirection) return finishRun();
    if (nextDirection === direction) {
      length++;
    } else {
      finishRun();
      direction = nextDirection;
      length = 1;
    }
  });
  finishRun();

  const average = values => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
  $("greenTripleRuns").textContent = runs.green.filter(value => value >= 3).length;
  $("redTripleRuns").textContent = runs.red.filter(value => value >= 3).length;
  $("greenDoubleRuns").textContent = runs.green.filter(value => value >= 2).length;
  $("redDoubleRuns").textContent = runs.red.filter(value => value >= 2).length;
  $("averageGreenRun").textContent = average(runs.green).toFixed(2);
  $("averageRedRun").textContent = average(runs.red).toFixed(2);
}

function renderStrategySimulation(candles, investmentAmount) {
  const amountLabel = aud(investmentAmount, 2);
  $("strategyThreeRedTitle").textContent = `${amountLabel} per signal — 3 consecutive green / 3 consecutive red`;
  $("strategyTwoRedTitle").textContent = `${amountLabel} per signal — 3 consecutive green / 2 consecutive red`;
  $("strategyTwoGreenTitle").textContent = `${amountLabel} per signal — 2 consecutive green / 3 consecutive red`;
  $("strategyTwoGreenTwoRedTitle").textContent = `${amountLabel} per signal — 2 consecutive green / 2 consecutive red`;
  $("strategyOptimalTitle").textContent = `${amountLabel} per signal — historical daily-percentage optimiser`;
  $("simulationNote").textContent = `Each qualifying buy contributes ${amountLabel}. Each qualifying sell converts ${amountLabel} only—not the full accumulated holding. Profit/loss is measured against total contributions. Fees, spreads, slippage and tax are excluded.`;
  const threeRed = simulateStrategy(candles, 3, 3, investmentAmount);
  const twoRed = simulateStrategy(candles, 3, 2, investmentAmount);
  const twoGreen = simulateStrategy(candles, 2, 3, investmentAmount);
  const twoGreenTwoRed = simulateStrategy(candles, 2, 2, investmentAmount);
  const optimal = findOptimalPercentageStrategy(candles, investmentAmount);
  renderStrategyResult(threeRed, {
    summary: "strategySummary",
    endingValue: "strategyEndingValue",
    pnl: "strategyPnl",
    entries: "strategyEntries",
    contributed: "strategyContributed",
    exits: "strategyExits",
    position: "strategyPosition"
  });
  renderStrategyResult(twoRed, {
    summary: "strategyTwoRedSummary",
    endingValue: "strategyTwoRedEndingValue",
    pnl: "strategyTwoRedPnl",
    entries: "strategyTwoRedEntries",
    contributed: "strategyTwoRedContributed",
    exits: "strategyTwoRedExits",
    position: "strategyTwoRedPosition"
  });
  renderStrategyResult(twoGreen, {
    summary: "strategyTwoGreenSummary",
    endingValue: "strategyTwoGreenEndingValue",
    pnl: "strategyTwoGreenPnl",
    entries: "strategyTwoGreenEntries",
    contributed: "strategyTwoGreenContributed",
    exits: "strategyTwoGreenExits",
    position: "strategyTwoGreenPosition"
  });
  renderStrategyResult(twoGreenTwoRed, {
    summary: "strategyTwoGreenTwoRedSummary",
    endingValue: "strategyTwoGreenTwoRedEndingValue",
    pnl: "strategyTwoGreenTwoRedPnl",
    entries: "strategyTwoGreenTwoRedEntries",
    contributed: "strategyTwoGreenTwoRedContributed",
    exits: "strategyTwoGreenTwoRedExits",
    position: "strategyTwoGreenTwoRedPosition"
  });
  renderStrategyResult(optimal, {
    summary: "strategyOptimalSummary",
    endingValue: "strategyOptimalEndingValue",
    pnl: "strategyOptimalPnl",
    entries: "strategyOptimalEntries",
    contributed: "strategyOptimalContributed",
    exits: "strategyOptimalExits",
    position: "strategyOptimalPosition"
  });
  $("strategyOptimalBuyThreshold").textContent = `+${optimal.buyThreshold.toFixed(2)}%`;
  $("strategyOptimalSellThreshold").textContent = `−${optimal.sellThreshold.toFixed(2)}%`;
  return { threeRed, twoRed, twoGreen, twoGreenTwoRed, optimal };
}

function findOptimalPercentageStrategy(candles, investmentAmount) {
  const thresholds = [];
  for (let value = .1; value <= 5.0001; value += .1) thresholds.push(Number(value.toFixed(1)));
  for (let value = 5.5; value <= 10; value += .5) thresholds.push(value);
  let best = null;
  thresholds.forEach(buyThreshold => {
    thresholds.forEach(sellThreshold => {
      const result = simulatePercentageStrategy(candles, buyThreshold, sellThreshold, investmentAmount);
      if (!result.entries || !result.exits) return;
      if (!best || result.profitPercent > best.profitPercent ||
          (result.profitPercent === best.profitPercent && result.profit > best.profit)) best = result;
    });
  });
  if (best) return best;

  thresholds.forEach(buyThreshold => {
    thresholds.forEach(sellThreshold => {
      const result = simulatePercentageStrategy(candles, buyThreshold, sellThreshold, investmentAmount);
      if (!result.entries) return;
      if (!best || result.profitPercent > best.profitPercent) best = result;
    });
  });
  return best ?? simulatePercentageStrategy(candles, .1, .1, investmentAmount);
}

function simulatePercentageStrategy(candles, buyThreshold, sellThreshold, investmentAmount) {
  let cash = 0;
  let units = 0;
  let totalContributed = 0;
  let entries = 0;
  let exits = 0;
  const buyIndexes = [];
  const sellIndexes = [];

  candles.forEach((candle, index) => {
    const open = Number(candle.open), close = Number(candle.close);
    const dailyChange = open ? (close / open - 1) * 100 : 0;
    if (dailyChange >= buyThreshold) {
      totalContributed += investmentAmount;
      units += investmentAmount / close;
      entries++;
      buyIndexes.push(index);
    } else if (units && dailyChange <= -sellThreshold) {
      const holdingValue = units * close;
      const saleValue = Math.min(investmentAmount, holdingValue);
      units -= saleValue / close;
      if (units < 1e-12) units = 0;
      cash += saleValue;
      exits++;
      sellIndexes.push(index);
    }
  });

  const latestClose = Number(candles.at(-1).close);
  const endingValue = cash + units * latestClose;
  const profit = endingValue - totalContributed;
  const profitPercent = totalContributed ? profit / totalContributed * 100 : 0;
  return {
    endingValue, profit, profitPercent, entries, exits, totalContributed,
    invested: Boolean(units), buyIndexes, sellIndexes, buyThreshold, sellThreshold
  };
}

function simulateStrategy(candles, buyAfterGreenDays, sellAfterRedDays, contributionPerSignal) {
  let cash = 0;
  let units = 0;
  let totalContributed = 0;
  let greenDays = 0;
  let redDays = 0;
  let entries = 0;
  let exits = 0;
  const buyIndexes = [];
  const sellIndexes = [];

  candles.forEach((candle, index) => {
    const open = Number(candle.open), close = Number(candle.close);
    if (close > open) {
      greenDays++;
      redDays = 0;
    } else if (close < open) {
      redDays++;
      greenDays = 0;
    } else {
      greenDays = 0;
      redDays = 0;
    }

    if (greenDays === buyAfterGreenDays) {
      totalContributed += contributionPerSignal;
      units += contributionPerSignal / close;
      entries++;
      buyIndexes.push(index);
    } else if (units && redDays === sellAfterRedDays) {
      const holdingValue = units * close;
      const saleValue = Math.min(contributionPerSignal, holdingValue);
      units -= saleValue / close;
      if (units < 1e-12) units = 0;
      cash += saleValue;
      exits++;
      sellIndexes.push(index);
    }
  });

  const latestClose = Number(candles.at(-1).close);
  const endingValue = cash + units * latestClose;
  const profit = endingValue - totalContributed;
  const profitPercent = totalContributed ? profit / totalContributed * 100 : 0;
  return {
    endingValue, profit, profitPercent, entries, exits, totalContributed,
    invested: Boolean(units), buyIndexes, sellIndexes
  };
}

function renderStrategyResult(result, ids) {
  const summary = $(ids.summary);
  summary.className = `strategy-summary ${result.profit > 0 ? "profit" : result.profit < 0 ? "loss" : "neutral"}`;
  $(ids.endingValue).textContent = aud(result.endingValue, 2);
  const pnl = $(ids.pnl);
  const percentage = document.createElement("span");
  percentage.className = "strategy-return-percent";
  percentage.textContent = `(${result.profit >= 0 ? "+" : ""}${result.profitPercent.toFixed(2)}%)`;
  pnl.replaceChildren(
    document.createTextNode(`${result.profit >= 0 ? "+" : "−"}${aud(Math.abs(result.profit), 2)} `),
    percentage);
  $(ids.entries).textContent = result.entries;
  $(ids.contributed).textContent = aud(result.totalContributed, 0);
  $(ids.exits).textContent = result.exits;
  $(ids.position).textContent = result.invested ? "Invested" : "Cash";
}

async function loadGainers() {
  $("gainersStatus").textContent = "Loading ranking…";
  try {
    const response = await fetch("/api/gainers");
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Gainers update failed.");
    gainersSnapshot = sortGainers(data.items);
    gainersRefreshedAt = new Date();
    drawGainers(gainersSnapshot);
    updateGainersStatus();
  } catch (error) {
    gainersSnapshot = [];
    drawGainers([]);
    $("gainersStatus").textContent = `Unavailable: ${error.message}`;
  }
}

function gainerThreeDayAverage(item) {
  if (item.previousDayChangePercent == null || item.dayBeforeChangePercent == null) return null;
  return (Number(item.change24HoursPercent) + Number(item.previousDayChangePercent) + Number(item.dayBeforeChangePercent)) / 3;
}

function gainerSortValue(item, key) {
  if (key === "coin") return item.coin;
  if (key === "threeDayAverage") return gainerThreeDayAverage(item);
  return item[key] == null ? null : Number(item[key]);
}

function sortGainers(items) {
  const direction = gainersSort.direction === "asc" ? 1 : -1;
  return [...items].sort((left, right) => {
    const leftValue = gainerSortValue(left, gainersSort.key);
    const rightValue = gainerSortValue(right, gainersSort.key);
    if (leftValue == null && rightValue == null) return left.coin.localeCompare(right.coin);
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    const comparison = typeof leftValue === "string"
      ? leftValue.localeCompare(rightValue)
      : leftValue - rightValue;
    return comparison === 0 ? left.coin.localeCompare(right.coin) : comparison * direction;
  });
}

function gainerSortLabel() {
  const labels = {
    coin: "Coin",
    threeDayAverage: "3D Avg",
    previousDayChangePercent: "Prev day",
    dayBeforeChangePercent: "Day before",
    change24HoursPercent: "24H",
    change1HourPercent: "1H",
    priceAud: "Price"
  };
  return `${labels[gainersSort.key]} ${gainersSort.direction === "asc" ? "↑" : "↓"}`;
}

function updateGainersStatus() {
  if (!gainersSnapshot) return;
  const refreshed = gainersRefreshedAt
    ? ` · refreshed ${gainersRefreshedAt.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  $("gainersStatus").textContent = `${gainersSnapshot.length} assets · sorted ${gainerSortLabel()}${refreshed}`;
}

function gainerSortKeyAtPosition(x, width) {
  if (width < 620) {
    if (x < width - 155) return "coin";
    if (x < width - 95) return "threeDayAverage";
    if (x < width - 35) return "change24HoursPercent";
    return "priceAud";
  }
  if (x < 150) return "coin";
  if (x < width - 297 && x >= width - 390) return "previousDayChangePercent";
  if (x < width - 208 && x >= width - 297) return "dayBeforeChangePercent";
  if (x < width - 123 && x >= width - 208) return "change24HoursPercent";
  if (x < width - 43 && x >= width - 123) return "change1HourPercent";
  if (x >= width - 43) return "priceAud";
  return null;
}

function gainerHeaderLabel(label, key) {
  if (gainersSort.key !== key) return label;
  return `${label} ${gainersSort.direction === "asc" ? "↑" : "↓"}`;
}

function drawGainers(items) {
  const canvas = $("gainersChart");
  const rowHeight = 29;
  const headerHeight = 26;
  const cssHeight = Math.max(180, items.length * rowHeight + headerHeight);
  canvas.style.height = `${cssHeight}px`;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  canvas.width = width * ratio; canvas.height = cssHeight * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "middle";
  const compact = width < 620;
  const labelWidth = compact ? 78 : 88;
  const valueWidth = compact ? 210 : 425;
  const barWidth = Math.max(80, width - labelWidth - valueWidth - 18);
  const maxMagnitude = Math.max(1, ...items.map(x => Math.abs(Number(x.change24HoursPercent))));

  ctx.fillStyle = "#64736e";
  ctx.font = "700 9px ui-monospace, Consolas, monospace";
  ctx.textAlign = "left";
  ctx.fillText(gainerHeaderLabel("COIN", "coin"), 36, 12);
  ctx.textAlign = "right";
  if (compact) {
    ctx.fillText(gainerHeaderLabel("3D AVG", "threeDayAverage"), width - 125, 12);
    ctx.fillText(gainerHeaderLabel("24H", "change24HoursPercent"), width - 65, 12);
    ctx.fillText(gainerHeaderLabel("PRICE", "priceAud"), width - 4, 12);
  } else {
    ctx.fillText(gainerHeaderLabel("PREV DAY", "previousDayChangePercent"), width - 342, 12);
    ctx.fillText(gainerHeaderLabel("DAY BEFORE", "dayBeforeChangePercent"), width - 252, 12);
    ctx.fillText(gainerHeaderLabel("24H", "change24HoursPercent"), width - 164, 12);
    ctx.fillText(gainerHeaderLabel("1H", "change1HourPercent"), width - 83, 12);
    ctx.fillText(gainerHeaderLabel("PRICE", "priceAud"), width - 4, 12);
  }
  ctx.strokeStyle = "rgba(100,115,110,.2)";
  ctx.beginPath(); ctx.moveTo(0, headerHeight - 1); ctx.lineTo(width, headerHeight - 1); ctx.stroke();

  items.forEach((item, index) => {
    const y = headerHeight + rowHeight / 2 + index * rowHeight;
    const change = Number(item.change24HoursPercent);
    const previousDay = item.previousDayChangePercent == null ? null : Number(item.previousDayChangePercent);
    const dayBefore = item.dayBeforeChangePercent == null ? null : Number(item.dayBeforeChangePercent);
    const threeDayAverage = previousDay == null || dayBefore == null
      ? null
      : (change + previousDay + dayBefore) / 3;
    const hourly = item.change1HourPercent == null ? null : Number(item.change1HourPercent);
    const colour = change >= 0 ? "#12a66a" : "#d84d4d";
    if (item.coin === selectedGainerCoin) {
      ctx.fillStyle = "rgba(216,136,24,.28)";
      ctx.fillRect(0, y - 13, width, rowHeight);
    } else if (index % 2) {
      ctx.fillStyle = "rgba(16,32,27,.025)";
      ctx.fillRect(0, y - 13, width, rowHeight);
    }
    ctx.fillStyle = "#64736e"; ctx.textAlign = "right";
    ctx.fillText(`#${index + 1}`, 28, y);
    ctx.fillStyle = "#10201b"; ctx.textAlign = "left"; ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(item.coin, 36, y);
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.fillStyle = colour;
    ctx.fillRect(labelWidth, y - 7, Math.max(2, Math.abs(change) / maxMagnitude * barWidth), 14);
    ctx.textAlign = "right";
    ctx.font = `700 ${compact ? 9 : 11}px ui-monospace, Consolas, monospace`;
    if (compact) {
      ctx.fillStyle = threeDayAverage == null ? "#89938f" : (threeDayAverage >= 0 ? "#12a66a" : "#d84d4d");
      ctx.fillText(threeDayAverage == null ? "N/A" : `${threeDayAverage >= 0 ? "+" : ""}${threeDayAverage.toFixed(2)}%`, width - 125, y);
      ctx.fillStyle = colour;
      ctx.fillText(`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, width - 65, y);
    } else {
      ctx.fillStyle = previousDay == null ? "#89938f" : (previousDay >= 0 ? "#12a66a" : "#d84d4d");
      ctx.fillText(previousDay == null ? "N/A" : `${previousDay >= 0 ? "+" : ""}${previousDay.toFixed(2)}%`, width - 342, y);
      ctx.fillStyle = dayBefore == null ? "#89938f" : (dayBefore >= 0 ? "#12a66a" : "#d84d4d");
      ctx.fillText(dayBefore == null ? "N/A" : `${dayBefore >= 0 ? "+" : ""}${dayBefore.toFixed(2)}%`, width - 252, y);
      ctx.fillStyle = colour;
      ctx.fillText(`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, width - 164, y);
      ctx.fillStyle = hourly == null ? "#89938f" : (hourly >= 0 ? "#12a66a" : "#d84d4d");
      ctx.fillText(hourly == null ? "N/A" : `${hourly >= 0 ? "+" : ""}${hourly.toFixed(2)}%`, width - 83, y);
    }
    ctx.fillStyle = "#64736e"; ctx.font = `${compact ? 9 : 10}px ui-monospace, Consolas, monospace`;
    ctx.fillText(aud(item.priceAud, item.priceAud < 1 ? 6 : 2), width - 4, y);
  });
}

async function loadWallet() {
  $("walletStatus").textContent = "Connecting…";
  try {
    const response = await fetch("/api/coinspot/wallet", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Wallet update failed.");
    const walletItems = [...data.items].sort((left, right) => {
      if (left.coin === "AUD") return -1;
      if (right.coin === "AUD") return 1;
      return Number(right.audBalance) - Number(left.audBalance);
    });
    walletSnapshot = walletItems;
    drawWallet(walletItems);
    updateSellWalletSummary();
    drawLiveTransactions();
    const investedCoinCount = walletItems.filter(item => item.coin !== "AUD").length;
    $("walletStatus").textContent = `${investedCoinCount} coins · ${aud(data.totalAud, 2)}`;
  } catch (error) {
    walletSnapshot = null;
    updateSellWalletSummary();
    drawLiveTransactions();
    $("walletStatus").textContent = error.message.includes("COINSPOT_READ_ONLY")
      ? "Read-only API not configured"
      : `Unavailable: ${error.message}`;
  }
}

function drawWallet(items) {
  const canvas = $("walletChart");
  const rowHeight = 34;
  const cssHeight = Math.max(180, items.length * rowHeight + 28);
  canvas.style.height = `${cssHeight}px`;
  const width = canvas.clientWidth;
  if (!width) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio; canvas.height = cssHeight * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.textBaseline = "middle";
  const labelWidth = 82;
  const valueWidth = 190;
  const barWidth = Math.max(80, width - labelWidth - valueWidth - 18);
  const maxValue = Math.max(1, ...items.map(x => Number(x.audBalance)));

  items.forEach((item, index) => {
    const y = 16 + index * rowHeight;
    const value = Number(item.audBalance);
    const isAvailableAud = item.coin === "AUD";
    if (item.coin === selectedWalletCoin) {
      ctx.fillStyle = "rgba(216,136,24,.28)";
      ctx.fillRect(0, y - 16, width, rowHeight);
    } else if (index % 2) {
      ctx.fillStyle = "rgba(16,32,27,.025)";
      ctx.fillRect(0, y - 16, width, rowHeight);
    }
    ctx.fillStyle = "#10201b";
    ctx.textAlign = "left";
    ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(isAvailableAud ? "AUD CASH" : item.coin, 8, y);
    ctx.fillStyle = isAvailableAud ? "#d97706" : "#12a66a";
    ctx.fillRect(labelWidth, y - 8, Math.max(2, value / maxValue * barWidth), 16);
    ctx.textAlign = "right";
    ctx.fillStyle = "#10201b";
    ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(aud(value, 2), width - 4, y - 5);
    ctx.fillStyle = "#64736e";
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillText(isAvailableAud ? "available cash" : `${number(item.balance, 8)} coins`, width - 4, y + 8);
  });
}

function drawPriceCandles(canvas, candles, hover = null, markers = null) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);

  const left = 82, right = 12, top = 14, bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const lows = candles.map(x => Number(x.low));
  const highs = candles.map(x => Number(x.high));
  const rawMin = Math.min(...lows), rawMax = Math.max(...highs);
  const rawRange = rawMax - rawMin || Math.max(rawMax * .01, .000001);
  const min = rawMin - rawRange * .04, max = rawMax + rawRange * .04;
  const range = max - min;
  const y = value => top + (max - value) / range * plotHeight;
  const step = plotWidth / candles.length;
  const bodyWidth = Math.max(2, Math.min(8, step * .7));
  const priceDigits = max < 1 ? 6 : max < 100 ? 4 : 2;
  const gaps = candles.slice(1).map((candle, index) =>
    Math.abs(new Date(candle.time) - new Date(candles[index].time)));
  const sortedGaps = [...gaps].sort((leftGap, rightGap) => leftGap - rightGap);
  const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;
  const isDailySeries = medianGap >= 20 * 60 * 60 * 1000;
  const isMinuteSeries = medianGap > 0 && medianGap <= 10 * 60 * 1000;

  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "middle";
  for (let i = 0; i < 5; i++) {
    const gridY = top + i * plotHeight / 4;
    const gridPrice = max - i * range / 4;
    ctx.strokeStyle = "#e4e9e2";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, gridY); ctx.lineTo(width - right, gridY); ctx.stroke();
    ctx.fillStyle = "#64736e";
    ctx.textAlign = "right";
    ctx.fillText(aud(gridPrice, priceDigits), left - 8, gridY);
  }

  if (markers) {
    const drawMarkerLines = (indexes, colour, dash = []) => {
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      indexes.forEach(index => {
        const x = left + (index + .5) * step;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotHeight); ctx.stroke();
      });
      ctx.restore();
    };
    drawMarkerLines(markers.buys, "rgba(8,115,74,.62)");
    drawMarkerLines(markers.sells, "rgba(216,77,77,.62)");
  }

  candles.forEach((candle, index) => {
    const open = Number(candle.open), close = Number(candle.close);
    const high = Number(candle.high), low = Number(candle.low);
    const x = left + (index + .5) * step;
    const colour = close >= open ? "#12a66a" : "#d84d4d";
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y(high)); ctx.lineTo(x, y(low)); ctx.stroke();
    const bodyTop = y(Math.max(open, close));
    const bodyHeight = Math.max(1.5, Math.abs(y(open) - y(close)));
    ctx.fillStyle = colour;
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  ctx.fillStyle = "#64736e";
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const labelEvery = Math.max(1, Math.ceil(candles.length / (width < 600 ? 5 : 9)));
  candles.forEach((candle, index) => {
    if (index % labelEvery !== 0 && index !== candles.length - 1) return;
    const time = new Date(candle.time);
    const label = isDailySeries
      ? time.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })
      : isMinuteSeries
        ? time.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false })
        : `${time.toLocaleDateString("en-AU", { day: "2-digit", month: "short" })} ${time.toLocaleTimeString("en-AU", { hour: "2-digit", hour12: false })}`;
    const x = left + (index + .5) * step;
    ctx.fillText(label, Math.max(left + 34, Math.min(width - 34, x)), height - 3);
  });

  if (hover) {
    const candle = candles[hover.index];
    const hoverY = Math.max(top, Math.min(top + plotHeight, hover.y));
    const hoverPrice = max - (hoverY - top) / plotHeight * range;
    const candleX = left + (hover.index + .5) * step;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "rgba(16,32,27,.65)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, hoverY); ctx.lineTo(width - right, hoverY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(candleX, top); ctx.lineTo(candleX, top + plotHeight); ctx.stroke();
    ctx.restore();

    const priceLabel = aud(hoverPrice, priceDigits);
    ctx.font = "700 10px ui-monospace, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#10201b";
    ctx.fillRect(0, hoverY - 10, left - 5, 20);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(priceLabel, left - 10, hoverY);

    const time = isDailySeries
      ? new Date(candle.time).toLocaleDateString("en-AU", {
          day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"
        })
      : new Date(candle.time).toLocaleString("en-AU", {
          day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false
        });
    const details = `${time}  O ${aud(candle.open, priceDigits)}  H ${aud(candle.high, priceDigits)}  L ${aud(candle.low, priceDigits)}  C ${aud(candle.close, priceDigits)}`;
    ctx.font = "700 10px ui-monospace, Consolas, monospace";
    const tooltipWidth = Math.min(plotWidth, ctx.measureText(details).width + 18);
    const tooltipX = Math.max(left, Math.min(width - right - tooltipWidth, candleX - tooltipWidth / 2));
    ctx.fillStyle = "rgba(16,32,27,.94)";
    ctx.fillRect(tooltipX, top, tooltipWidth, 24);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(details, tooltipX + 9, top + 12, tooltipWidth - 18);
  }
}

function drawDailyPercentageBars(canvas, items, hover = null) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const left = 54, right = 12, top = 14, bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxMagnitude = Math.max(.1, ...items.map(x => Math.abs(x.change))) * 1.08;
  const y = value => top + (maxMagnitude - value) / (maxMagnitude * 2) * plotHeight;
  const zeroY = y(0);
  const step = plotWidth / items.length;
  const barWidth = Math.max(1, Math.min(8, step * .72));

  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "middle";
  for (let index = 0; index < 5; index++) {
    const value = maxMagnitude - index * maxMagnitude / 2;
    const gridY = y(value);
    ctx.strokeStyle = Math.abs(value) < .000001 ? "#aeb9b3" : "#e4e9e2";
    ctx.lineWidth = Math.abs(value) < .000001 ? 1.4 : 1;
    ctx.beginPath(); ctx.moveTo(left, gridY); ctx.lineTo(width - right, gridY); ctx.stroke();
    ctx.fillStyle = "#64736e";
    ctx.textAlign = "right";
    ctx.fillText(`${value > 0 ? "+" : ""}${value.toFixed(1)}%`, left - 7, gridY);
  }

  items.forEach((item, index) => {
    const x = left + (index + .5) * step;
    const barY = y(item.change);
    ctx.fillStyle = item.change >= 0 ? "#12a66a" : "#d84d4d";
    ctx.fillRect(x - barWidth / 2, Math.min(barY, zeroY), barWidth, Math.max(1.5, Math.abs(zeroY - barY)));
  });

  ctx.fillStyle = "#64736e";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const labelEvery = Math.max(1, Math.ceil(items.length / (width < 600 ? 5 : 8)));
  items.forEach((item, index) => {
    if (index % labelEvery !== 0 && index !== items.length - 1) return;
    const label = new Date(item.time).toLocaleDateString("en-AU", { day: "2-digit", month: "short" });
    const x = left + (index + .5) * step;
    ctx.fillText(label, Math.max(left + 25, Math.min(width - 25, x)), height - 3);
  });

  if (!hover) return;
  const item = items[hover.index];
  const candleX = left + (hover.index + .5) * step;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "rgba(16,32,27,.6)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(candleX, top); ctx.lineTo(candleX, top + plotHeight); ctx.stroke();
  ctx.restore();

  const date = new Date(item.time).toLocaleDateString("en-AU", {
    day: "2-digit", month: "short", year: "numeric"
  });
  const details = `${date}  ${item.change >= 0 ? "+" : ""}${item.change.toFixed(2)}%`;
  ctx.font = "700 11px ui-monospace, Consolas, monospace";
  const tooltipWidth = ctx.measureText(details).width + 18;
  const tooltipX = Math.max(left, Math.min(width - right - tooltipWidth, candleX - tooltipWidth / 2));
  ctx.fillStyle = "rgba(16,32,27,.94)";
  ctx.fillRect(tooltipX, top, tooltipWidth, 24);
  ctx.fillStyle = item.change >= 0 ? "#7ce7b6" : "#ff9c9c";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(details, tooltipX + 9, top + 12);
}

function tick() {
  const remaining = nextRefresh - Date.now();
  if (remaining <= 0) { nextRefresh = Date.now() + 60 * 60 * 1000; analyse(true); return; }
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  $("countdown").textContent = `Next update in ${minutes}:${String(seconds).padStart(2, "0")}`;
}
function showError(message) { $("error").textContent = message; $("error").hidden = false; }
function hideError() { $("error").hidden = true; }
async function readApiJson(response, operation) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const receivedHtml = text.trimStart().startsWith("<");
    throw new Error(receivedHtml
      ? `${operation} received the app page instead of API data. Restart the updated app and try again.`
      : `${operation} returned an invalid response.`);
  }
}
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }

analyse();
loadGainers();
loadWallet();
syncLiveTradeCoin();
loadLiveTradingStatus();
loadLiveTransactions();
setInterval(refreshLiveRowPrices, 60_000);
