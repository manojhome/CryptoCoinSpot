const $ = id => document.getElementById(id);
let snapshot = null;
let entryPrice = null;
let nextRefresh = null;
let timer = null;

const aud = (n, digits = 4) => `A$${Number(n).toLocaleString("en-AU", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const number = (n, digits = 4) => Number(n).toLocaleString("en-AU", { maximumFractionDigits: digits });

$("analyse").addEventListener("click", analyse);
$("coin").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
$("amount").addEventListener("keydown", e => { if (e.key === "Enter") analyse(); });
window.addEventListener("resize", () => snapshot && drawCharts(snapshot));

async function analyse(isAutomatic = false) {
  const coin = $("coin").value.trim().toUpperCase();
  const amount = Number($("amount").value);
  if (!coin || !Number.isFinite(amount) || amount <= 0) return showError("Enter a coin ticker and a positive AUD amount.");

  $("analyse").disabled = true;
  $("refreshState").textContent = "Updating";
  hideError();
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
    $("refreshState").textContent = "Update failed";
  } finally {
    $("analyse").disabled = false;
  }
}

function render(data) {
  const units = data.amount / entryPrice;
  const currentValue = units * data.currentPrice;
  const change = (currentValue / data.amount - 1) * 100;
  $("dashboard").hidden = false;
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

  $("dailyRows").innerHTML = data.daily.slice(-7).reverse().map(x => `<tr>
    <td>${new Date(x.time).toLocaleDateString("en-AU", { day: "2-digit", month: "short" })}</td>
    <td>${number(x.open, 5)}</td><td>${number(x.high, 5)}</td><td>${number(x.low, 5)}</td><td>${number(x.close, 5)}</td>
  </tr>`).join("");
  $("refreshState").textContent = "Live paper view";
  drawCharts(data);
}

function drawCharts(data) {
  const prices = data.hourly.map(x => Number(x.price));
  const units = data.amount / entryPrice;
  const values = prices.map(x => x * units);
  drawLine($("priceChart"), prices, "#12a66a", "rgba(18,166,106,.13)");
  drawLine($("valueChart"), values, "#10201b", "rgba(200,240,108,.26)");
  $("priceRange").textContent = `${aud(Math.min(...prices), 4)} — ${aud(Math.max(...prices), 4)}`;
  $("valueRange").textContent = `${aud(Math.min(...values), 2)} — ${aud(Math.max(...values), 2)}`;
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
