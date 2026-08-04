const $ = id => document.getElementById(id);
let snapshot = null;
let gainersSnapshot = null;
let walletSnapshot = null;
let priceHover = null;
let entryPrice = null;
let nextRefresh = null;
let timer = null;

const aud = (n, digits = 4) => `A$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const number = (n, digits = 4) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: digits });

$("analyse").addEventListener("click", analyse);
$("coin").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("amount").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
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
  for (const id of ["priceChart", "valueChart"]) {
    const canvas = $(id);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  $("priceRange").textContent = "Unavailable";
  $("valueRange").textContent = "Unavailable";
  $("dailyRows").innerHTML = "";
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
  $("trend").textContent = data.trend.trend;
  $("trendMeta").textContent = `24h ${data.trend.change24HoursPercent >= 0 ? "+" : ""}${Number(data.trend.change24HoursPercent).toFixed(2)}% · RSI ${Number(data.trend.rsi14).toFixed(1)}`;

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

  const yesterdayClose = Number(data.daily.at(-1).close);
  const dailyMove = (Number(data.currentPrice) / yesterdayClose - 1) * 100;
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

  const firstVisibleIndex = Math.max(0, data.daily.length - 30);
  $("dailyRows").innerHTML = data.daily.slice(firstVisibleIndex).map((x, visibleIndex) => {
    const sourceIndex = firstVisibleIndex + visibleIndex;
    const previousClose = sourceIndex > 0 ? Number(data.daily[sourceIndex - 1].close) : Number(x.close);
    const close = Number(x.close);
    const changePercent = previousClose ? (close / previousClose - 1) * 100 : 0;
    const rowDirection = close > previousClose ? "day-up" : close < previousClose ? "day-down" : "day-flat";
    return `<tr class="${rowDirection}">
      <td>${new Date(x.time).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })}</td>
      <td>${number(x.open, 5)}</td><td>${number(x.high, 5)}</td><td>${number(x.low, 5)}</td><td>${number(x.close, 5)}</td>
      <td class="change-cell">${changePercent > 0 ? "+" : ""}${changePercent.toFixed(2)}%</td>
    </tr>`;
  }).reverse().join("");
  $("refreshState").textContent = "Live paper view";
  drawCharts(data);
}

function drawCharts(data) {
  const prices = data.hourly.map(x => Number(x.price));
  const units = data.amount / entryPrice;
  const values = prices.map(x => x * units);
  drawPriceCandles($("priceChart"), data.hourly, priceHover);
  drawLine($("valueChart"), values, "#10201b", "rgba(200,240,108,.26)");
  $("priceRange").textContent = `${aud(Math.min(...prices), 4)} — ${aud(Math.max(...prices), 4)}`;
  $("valueRange").textContent = `${aud(Math.min(...values), 2)} — ${aud(Math.max(...values), 2)}`;
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

function drawPriceCandles(canvas, candles, hover = null) {
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
  const labelEvery = width < 600 ? 24 : 12;
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

function drawLine(canvas, values, stroke, fill) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const pad = 18, min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const point = (v, i) => [pad + i / (values.length - 1) * (width - pad * 2), pad + (max - v) / range * (height - pad * 2)];
  ctx.strokeStyle = "#e4e9e2"; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) { const y = pad + i * (height - pad * 2) / 3; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke(); }
  ctx.beginPath();
  values.forEach((v, i) => { const [x, y] = point(v, i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.lineTo(width - pad, height - pad); ctx.lineTo(pad, height - pad); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath();
  values.forEach((v, i) => { const [x, y] = point(v, i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.strokeStyle = stroke; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
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
