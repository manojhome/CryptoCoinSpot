const rows = document.querySelector("#stockRows");
const errorBox = document.querySelector("#stockError");
const state = document.querySelector("#ibkrState");
const dot = document.querySelector("#ibkrDot");
const updated = document.querySelector("#stockUpdated");
const note = document.querySelector("#stockNote");
const refresh = document.querySelector("#refreshStocks");

const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const number = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 });

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);
}

function price(value) { return value == null ? "—" : money.format(value); }
function range(low, high) { return low == null && high == null ? "—" : `${price(low)} – ${price(high)}`; }
function feed(value) {
  const code = String(value || "").charAt(0);
  return ({ R: "Live", D: "Delayed", Z: "Frozen", Y: "Delayed/frozen", N: "Not subscribed" })[code] || "Unknown";
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body;
}

async function loadStocks() {
  refresh.disabled = true;
  errorBox.hidden = true;
  state.textContent = "Loading ASX stocks";
  dot.className = "live-dot waiting";
  rows.innerHTML = '<tr><td colspan="12" class="empty-stock-row">Loading IBKR market data…</td></tr>';
  try {
    const result = await readJson(await fetch("/api/ibkr/asx/top?limit=200", { cache: "no-store" }));
    const items = result.items || [];
    rows.innerHTML = items.length ? items.map(item => {
      const direction = item.changePercent > 0 ? "positive" : item.changePercent < 0 ? "negative" : "";
      const change = item.changePercent == null ? "—" : `${item.changePercent > 0 ? "+" : ""}${number.format(item.changePercent)}%`;
      return `<tr>
        <td>${item.rank}</td>
        <td><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.exchange)}</small></td>
        <td>${escapeHtml(item.company)}</td>
        <td>${escapeHtml(item.industry || item.category)}</td>
        <td class="numeric">${price(item.last)}</td>
        <td class="numeric ${direction}">${change}</td>
        <td class="numeric">${price(item.bid)}</td>
        <td class="numeric">${price(item.ask)}</td>
        <td class="numeric">${escapeHtml(item.volume)}</td>
        <td class="numeric range-cell">${range(item.dayLow, item.dayHigh)}</td>
        <td class="numeric range-cell">${range(item.week52Low, item.week52High)}</td>
        <td><span class="feed-pill">${feed(item.marketDataAvailability)}</span></td>
      </tr>`;
    }).join("") : '<tr><td colspan="12" class="empty-stock-row">No ASX stocks were returned.</td></tr>';
    state.textContent = `IBKR connected · ${items.length} stocks`;
    dot.className = "live-dot";
    updated.textContent = `Updated ${new Date(result.retrievedAt).toLocaleString("en-AU")}`;
    if (result.note) note.textContent = result.note;
  } catch (error) {
    state.textContent = "Gateway unavailable";
    dot.className = "live-dot offline";
    updated.textContent = "Authentication required";
    rows.innerHTML = '<tr><td colspan="12" class="empty-stock-row">IBKR data is not available.</td></tr>';
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", loadStocks);
loadStocks();
