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
    state.textContent = "IBKR unavailable";
    dot.className = "live-dot offline";
    updated.textContent = "See connection details below";
    rows.innerHTML = '<tr><td colspan="12" class="empty-stock-row">IBKR data is not available.</td></tr>';
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener("click", loadStocks);

const risersRefresh = document.querySelector("#refreshAsxRisers");
const risersRows = document.querySelector("#asxRisersRows");
const risersStatus = document.querySelector("#asxRisersStatus");
const risersError = document.querySelector("#asxRisersError");
const sydneyTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short"
});

async function loadAsxRisers() {
  if (risersRefresh.disabled) return;
  risersRefresh.disabled = true;
  risersError.hidden = true;
  risersStatus.textContent = "Checking ASX 200 daily risers…";
  try {
    const result = await readJson(await fetch("/api/stocks/asx200/risers", { cache: "no-store" }));
    if (!result.available) {
      risersStatus.textContent = "Moomoo · Australian quotes unavailable";
      risersRows.innerHTML = '<tr><td colspan="7" class="empty-stock-row">Current ASX 200 rankings are unavailable.</td></tr>';
      risersError.textContent = result.message;
      risersError.hidden = false;
      return;
    }
    // The server must supply a verified ASX 200 universe and current-session quotes.
    const items = (result.items || []).filter(item => Number.isFinite(item.changePercent) && item.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent).slice(0, 10);
    risersRows.innerHTML = items.length ? items.map((item, index) => `<tr>
      <td>${index + 1}</td><td><strong>${escapeHtml(item.symbol)}</strong></td>
      <td>${escapeHtml(item.company)}</td><td class="numeric">${price(item.last)}</td>
      <td class="numeric positive">+${number.format(item.changePercent)}%</td>
      <td class="numeric">${item.volume == null ? "—" : number.format(item.volume)}</td>
      <td>${item.quoteTime ? escapeHtml(sydneyTime.format(new Date(item.quoteTime))) : "—"}<small>${escapeHtml(item.feed || "Feed unverified")}</small></td>
    </tr>`).join("") : '<tr><td colspan="7" class="empty-stock-row">No positive daily gainers were returned.</td></tr>';
    risersStatus.textContent = `${result.source} · ${items.length} risers · Retrieved ${sydneyTime.format(new Date(result.retrievedAt))}`;
  } catch (error) {
    risersStatus.textContent = "ASX 200 data unavailable";
    risersRows.innerHTML = '<tr><td colspan="7" class="empty-stock-row">Unable to load current rankings.</td></tr>';
    risersError.textContent = error.message;
    risersError.hidden = false;
  } finally {
    risersRefresh.disabled = false;
  }
}

risersRefresh.addEventListener("click", loadAsxRisers);
loadAsxRisers();
