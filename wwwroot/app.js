const $ = id => document.getElementById(id);
let snapshot = null;
let gainersSnapshot = null;
let walletSnapshot = null;
let priceHover = null;
let dailyPercentHover = null;
let dailyPercentData = [];
let pullbackHover = null;
let pullbackMarkers = null;
let pullbackCandles = [];
let strategySimulations = null;
let selectedStrategy = null;
let entryPrice = null;
let nextRefresh = null;
let timer = null;

const aud = (n, digits = 4) => `$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const number = (n, digits = 4) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: digits });

$("analyse").addEventListener("click", analyse);
$("coin").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("amount").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("pullbackPeriod").addEventListener("change", () => {
  pullbackHover = null;
  if (snapshot) drawPullbackAnalysis(snapshot.daily);
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
window.addEventListener("resize", () => {
  if (snapshot) drawCharts(snapshot);
  if (gainersSnapshot) drawGainers(gainersSnapshot);
  if (walletSnapshot) drawWallet(walletSnapshot);
});

async function analyse(isAutomatic = false) {
  const coin = $("coin").value.trim().toUpperCase();
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
  $("dailyRows").innerHTML = "";
  $("pullbackChartRange").textContent = "Unavailable";
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

function render(data) {
  const units = data.amount / entryPrice;
  const currentValue = units * data.currentPrice;
  const change = (currentValue / data.amount - 1) * 100;
  $("dashboard").hidden = false;
  if (gainersSnapshot) drawGainers(gainersSnapshot);
  if (walletSnapshot) drawWallet(walletSnapshot);
  $("signal").textContent = data.signal.action;
  $("signal").className = `signal ${data.signal.action.startsWith("BUY") ? "buy" : ""}`;
  $("explanation").textContent = data.signal.explanation;
  $("currentPrice").textContent = aud(data.currentPrice, 6);
  $("units").textContent = number(units, 6);
  $("unitCoin").textContent = `${data.coin} at ${aud(entryPrice, 6)} entry`;
  $("currentValue").textContent = aud(currentValue, 2);
  $("valueChange").textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}% from snapshot`;
  const previousDailyClose = Number(data.daily.at(-1).close);
  const dailyMove = (Number(data.currentPrice) / previousDailyClose - 1) * 100;
  $("trend").textContent = data.trend.trend;
  const trendDirection = data.trend.trend.toUpperCase();
  $("trend").className = trendDirection.includes("UP")
    ? "trend-up"
    : trendDirection.includes("DOWN")
      ? "trend-down"
      : "trend-neutral";
  const hourlyPercentage = document.createElement("span");
  hourlyPercentage.className = "trend-percentage";
  hourlyPercentage.textContent = `${data.trend.change24HoursPercent >= 0 ? "+" : ""}${Number(data.trend.change24HoursPercent).toFixed(2)}%`;
  $("trendMeta").replaceChildren(
    document.createTextNode("24h "),
    hourlyPercentage,
    document.createTextNode(` · RSI ${Number(data.trend.rsi14).toFixed(1)}`));
  const dailyDirection = dailyMove > 0 ? "UP" : dailyMove < 0 ? "DOWN" : "FLAT";
  $("dailyTrend").textContent = dailyDirection;
  $("dailyTrend").className = dailyMove > 0
    ? "trend-up"
    : dailyMove < 0
      ? "trend-down"
      : "trend-neutral";
  const dailyPercentage = document.createElement("span");
  dailyPercentage.className = "trend-percentage";
  dailyPercentage.textContent = `${dailyMove >= 0 ? "+" : ""}${dailyMove.toFixed(2)}%`;
  $("dailyTrendMeta").replaceChildren(
    dailyPercentage,
    document.createTextNode(` today · previous close ${aud(previousDailyClose, 6)}`));

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
  drawDailyPercentageAnalysis(data.daily);
  drawPullbackAnalysis(data.daily);
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
  const requestedDays = Number($("pullbackPeriod").value) || 365;
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
  $("pullbackChartRange").textContent = `${pullbackCandles.length} days · ${aud(Math.min(...dailyLows), 4)} — ${aud(Math.max(...dailyHighs), 4)}`;
  renderStreakMetrics(pullbackCandles);
  const investmentAmount = Number(snapshot?.amount) || 1000;
  strategySimulations = renderStrategySimulation(pullbackCandles, investmentAmount);
  updateSelectedStrategyMarkers();
  drawPriceCandles($("pullbackChart"), pullbackCandles, pullbackHover, pullbackMarkers);
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
    gainersSnapshot = data.items;
    drawGainers(data.items);
    $("gainersStatus").textContent = `${data.items.length} assets · refreshed ${new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    gainersSnapshot = [];
    drawGainers([]);
    $("gainersStatus").textContent = `Unavailable: ${error.message}`;
  }
}

function drawGainers(items) {
  const canvas = $("gainersChart");
  const rowHeight = 29;
  const cssHeight = Math.max(180, items.length * rowHeight + 28);
  canvas.style.height = `${cssHeight}px`;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  canvas.width = width * ratio; canvas.height = cssHeight * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.font = "11px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "middle";
  const labelWidth = 88;
  const valueWidth = 150;
  const barWidth = Math.max(80, width - labelWidth - valueWidth - 18);
  const maxMagnitude = Math.max(1, ...items.map(x => Math.abs(Number(x.change24HoursPercent))));

  items.forEach((item, index) => {
    const y = 14 + index * rowHeight;
    const change = Number(item.change24HoursPercent);
    const colour = change >= 0 ? "#12a66a" : "#d84d4d";
    if (index % 2) { ctx.fillStyle = "rgba(16,32,27,.025)"; ctx.fillRect(0, y - 13, width, rowHeight); }
    ctx.fillStyle = "#64736e"; ctx.textAlign = "right";
    ctx.fillText(`#${item.rank}`, 28, y);
    ctx.fillStyle = "#10201b"; ctx.textAlign = "left"; ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(item.coin, 36, y);
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.fillStyle = colour;
    ctx.fillRect(labelWidth, y - 7, Math.max(2, Math.abs(change) / maxMagnitude * barWidth), 14);
    ctx.textAlign = "right"; ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(`${change >= 0 ? "+" : ""}${change.toFixed(2)}%`, width - 76, y);
    ctx.fillStyle = "#64736e"; ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillText(aud(item.priceAud, item.priceAud < 1 ? 6 : 2), width - 4, y);
  });
}

async function loadWallet() {
  $("walletStatus").textContent = "Connecting…";
  try {
    const response = await fetch("/api/coinspot/wallet", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Wallet update failed.");
    walletSnapshot = data.items;
    drawWallet(data.items);
    $("walletStatus").textContent = `${data.items.length} coins · ${aud(data.totalAud, 2)}`;
  } catch (error) {
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
    if (index % 2) {
      ctx.fillStyle = "rgba(16,32,27,.025)";
      ctx.fillRect(0, y - 16, width, rowHeight);
    }
    ctx.fillStyle = "#10201b";
    ctx.textAlign = "left";
    ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(item.coin, 8, y);
    ctx.fillStyle = "#12a66a";
    ctx.fillRect(labelWidth, y - 8, Math.max(2, value / maxValue * barWidth), 16);
    ctx.textAlign = "right";
    ctx.fillStyle = "#10201b";
    ctx.font = "700 11px ui-monospace, Consolas, monospace";
    ctx.fillText(aud(value, 2), width - 4, y - 5);
    ctx.fillStyle = "#64736e";
    ctx.font = "10px ui-monospace, Consolas, monospace";
    ctx.fillText(`${number(item.balance, 8)} coins`, width - 4, y + 8);
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
    const label = `${time.toLocaleDateString("en-AU", { day: "2-digit", month: "short" })} ${time.toLocaleTimeString("en-AU", { hour: "2-digit", hour12: false })}`;
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

    const time = new Date(candle.time).toLocaleString("en-AU", {
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
function escapeHtml(value) { const node = document.createElement("span"); node.textContent = value; return node.innerHTML; }

analyse();
loadGainers();
loadWallet();
