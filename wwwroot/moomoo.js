(() => {
  const find = selector => document.querySelector(selector);
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const usPrice = value => value == null || value <= 0 ? '—' : usd.format(value);
  const usRange = (low, high) => `${usPrice(low)} – ${usPrice(high)}`;
  let csrfToken = '';
  let liveEnabled = false;
  let review = null;
  let expiryTimer;
  let submitting = false;
  let holdings = [];
  let holdingsRequest = 0;
  const money = (value, currency) => {
    if (value == null) return '—';
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 4 }).format(value); }
    catch { return `${number.format(value)} ${escapeHtml(currency || 'Currency unavailable')}`; }
  };
  const tradable = item => item.side === 'LONG' && item.currency === 'USD' && /^US\.[A-Z]{1,6}(?:[.-][A-Z])?$/.test(item.symbol);
  const gainClass = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';

  async function loadHoldings() {
    const request = ++holdingsRequest;
    holdings = [];
    find('#holdingsRows').innerHTML = '<tr><td colspan="9" class="empty-stock-row">Loading holdings…</td></tr>';
    const accountId = find('#holdingsAccount').value;
    if (!accountId) {
      find('#holdingsRows').innerHTML = '<tr><td colspan="9" class="empty-stock-row">Select an authorized account to view holdings.</td></tr>';
      return;
    }
    find('#holdingsStatus').textContent = 'Loading Moomoo holdings…';
    try {
      const result = await get(`/api/moomoo/holdings?accountId=${encodeURIComponent(accountId)}`);
      if (request !== holdingsRequest) return;
      holdings = result.items;
      find('#holdingsRows').innerHTML = holdings.length ? holdings.map((item, index) => `<tr>
        <td><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.company)} · ${escapeHtml(item.side)} · Account …${escapeHtml(item.accountId.slice(-4))}</small></td>
        <td class="numeric">${item.quantity == null ? '—' : number.format(item.quantity)} / ${item.sellableQuantity == null ? '—' : number.format(item.sellableQuantity)}</td>
        <td class="numeric">${money(item.costPrice, item.currency)}</td><td class="numeric">${money(item.last, item.currency)}</td><td class="numeric">${money(item.marketValue, item.currency)}</td>
        <td class="numeric ${gainClass(item.gain)}">${money(item.gain, item.currency)}</td><td class="numeric ${gainClass(item.gainPercent)}">${item.gainPercent == null ? '—' : `${item.gainPercent > 0 ? '+' : ''}${number.format(item.gainPercent)}%`}</td>
        <td>Not supplied</td><td class="holdings-actions"><button type="button" data-holding="${index}" data-side="BUY" ${!tradable(item) ? 'disabled' : ''}>Buy</button><button type="button" data-holding="${index}" data-side="SELL" ${!tradable(item) || !(item.sellableQuantity >= 1) ? 'disabled' : ''}>Sell</button></td>
      </tr>`).join('') : '<tr><td colspan="9" class="empty-stock-row">No holdings returned by the selected accounts.</td></tr>';
      find('#holdingsStatus').textContent = `${holdings.length} holdings · refreshed ${nyTime.format(new Date(result.retrievedAt))} (New York).`;
      find('#holdingsNote').textContent = result.note;
    } catch (error) {
      if (request !== holdingsRequest) return;
      find('#holdingsStatus').textContent = error.message;
      find('#holdingsRows').innerHTML = '<tr><td colspan="9" class="empty-stock-row">Holdings unavailable. Connect Moomoo and check account permissions.</td></tr>';
    }
  }

  async function get(path) { return readJson(await fetch(path, { cache: 'no-store' })); }
  async function post(path, body) {
    return readJson(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body) }));
  }
  function message(text) { find('#moomooOrderResult').textContent = text; }
  function clearReview() {
    review = null;
    clearTimeout(expiryTimer);
    find('#moomooOrderReview').hidden = true;
  }
  function setOrderControls() {
    const ready = liveEnabled && Boolean(find('#moomooAccount').value) && !submitting;
    document.querySelectorAll('.moomoo-order-form fieldset').forEach(fieldset => { fieldset.disabled = !ready; });
  }
  async function loadAccounts() {
    const result = await get('/api/moomoo/accounts');
    const accounts = result.accounts.filter(account => account.usEnabled);
    find('#moomooAccount').innerHTML = '<option value="">Select an account</option>' + accounts.map(account =>
      `<option value="${escapeHtml(account.accountId)}">Account …${escapeHtml(account.accountId.slice(-4))} · ${escapeHtml(account.type)}</option>`).join('');
    find('#moomooAccount').disabled = !accounts.length;
    find('#holdingsAccount').innerHTML = '<option value="all">All authorized accounts</option>' + result.accounts.map(account => `<option value="${escapeHtml(account.accountId)}">Account …${escapeHtml(account.accountId.slice(-4))} · ${escapeHtml(account.type)}</option>`).join('');
    find('#holdingsAccount').disabled = !result.accounts.length; find('#holdingsAccount').value = 'all';
    if (accounts.length) {
      
      find('#moomooAccount').value = accounts[0].accountId;
    }
    await loadHoldings();
    if (!accounts.length) message('No authorized account supports US securities.');
  }
  async function loadStatus() {
    try {
      const result = await get('/api/moomoo/status');
      csrfToken = result.csrfToken;
      liveEnabled = result.liveEnabled;
      find('#moomooConnection').textContent = result.connection.message;
      find('#enableMoomooTrading').disabled = !result.connection.canTrade;
      find('#enableMoomooTrading').textContent = liveEnabled ? 'Disable live trading' : 'Enable live trading';
      find('#moomooTradingStatus').textContent = liveEnabled ? 'Live trading enabled. Each order requires review and confirmation.' :
        result.connection.canTrade ? 'Live trading is disabled. Select your US account and enable trading to prepare an order.' : 'Live trading locked: authorization, trade permission and production account verification are required.';
      if (result.connection.connected) {
        await loadStocks();
        await loadAccounts();
      }
      setOrderControls();
    } catch (error) { find('#moomooConnection').textContent = error.message; }
  }
  async function loadStocks() {
    find('#refreshUsStocks').disabled = true;
    find('#usStockError').hidden = true;
    try {
      const result = await get(`/api/moomoo/us/stocks?symbols=${encodeURIComponent(find('#usSymbols').value)}`);
      find('#usStockRows').innerHTML = result.items.length ? result.items.map(item => `<tr>
        <td><strong>${escapeHtml(item.symbol)}</strong></td><td>${escapeHtml(item.company)}</td>
        <td class="numeric">${usPrice(item.last)}</td><td class="numeric ${item.changePercent > 0 ? 'positive' : item.changePercent < 0 ? 'negative' : ''}">${item.changePercent == null ? '—' : `${item.changePercent > 0 ? '+' : ''}${number.format(item.changePercent)}%`}</td>
        <td class="numeric">${usPrice(item.bid)}</td><td class="numeric">${usPrice(item.ask)}</td><td class="numeric">${item.volume == null ? '—' : number.format(item.volume)}</td>
        <td class="numeric">${usRange(item.dayLow, item.dayHigh)}</td><td class="numeric">${usRange(item.week52Low, item.week52High)}</td>
        <td class="numeric">${usPrice(item.marketCap)}</td><td class="numeric">${item.pe > 0 ? number.format(item.pe) : '—'}</td>
        <td>${item.quoteTime ? escapeHtml(nyTime.format(new Date(item.quoteTime))) : 'Unavailable'}<small>Trading date: ${escapeHtml(item.tradingDate)} · ${result.productionVerified ? 'Production account verified' : 'Sandbox / production unverified'}</small></td>
      </tr>`).join('') : '<tr><td colspan="12" class="empty-stock-row">Moomoo returned no stock details.</td></tr>';
      find('#usStockNote').textContent = `${result.note} Retrieved ${nyTime.format(new Date(result.retrievedAt))} (New York).${result.missingSymbols.length ? ` Missing: ${result.missingSymbols.join(', ')}.` : ''}`;
    } catch (error) {
      find('#usStockRows').innerHTML = '<tr><td colspan="12" class="empty-stock-row">US stock data unavailable. Connect Moomoo and check quote permissions.</td></tr>';
      find('#usStockError').textContent = error.message;
      find('#usStockError').hidden = false;
    } finally { find('#refreshUsStocks').disabled = false; }
  }
  find('#usStocksForm').addEventListener('submit', event => { event.preventDefault(); loadStocks(); });
  find('#refreshHoldings').addEventListener('click', loadHoldings);
  find('#holdingsAccount').addEventListener('change', () => {
    if (find('#holdingsAccount').value !== 'all') find('#moomooAccount').value = find('#holdingsAccount').value;
    clearReview(); setOrderControls(); loadHoldings();
  });
  find('#holdingsRows').addEventListener('click', event => {
    const button = event.target.closest('button[data-holding]');
    if (!button || button.disabled) return;
    const item = holdings[Number(button.dataset.holding)];
    if (!item || !tradable(item)) return;
    clearReview();
    find('#moomooAccount').value = item.accountId;
    const form = find(`.moomoo-order-form[data-side="${button.dataset.side}"]`);
    form.elements.symbol.value = item.symbol.replace(/^US\./, '');
    form.elements.quantity.value = '1';
    form.elements.limitPrice.value = item.last > 0 ? Number(item.last).toFixed(4) : '';
    setOrderControls();
    message(liveEnabled ? 'Stock selected. Set quantity and limit price, then review the order.' : 'Stock selected. Live trading must be enabled for a verified production account before reviewing an order.');
    form.scrollIntoView({behavior:'smooth', block:'center'});
    if (liveEnabled) form.elements.quantity.focus();
  });
  find('#connectMoomoo').addEventListener('click', async () => {
    find('#connectMoomoo').disabled = true;
    try {
      const result = await post('/api/moomoo/connect', {});
      const url = new URL(result.authorizationUrl);
      if (url.origin !== 'https://webapi.moomoo.com' || url.pathname !== '/oauth2/authorize/confirm') throw new Error('Unexpected authorization destination.');
      window.location.assign(url.href);
    } catch (error) { find('#moomooConnection').textContent = error.message; find('#connectMoomoo').disabled = false; }
  });
  find('#enableMoomooTrading').addEventListener('click', async () => {
    try {
      const result = await post('/api/moomoo/trading/enable', { enabled: !liveEnabled });
      liveEnabled = result.enabled;
      clearReview();
      find('#enableMoomooTrading').textContent = liveEnabled ? 'Disable live trading' : 'Enable live trading';
      find('#moomooTradingStatus').textContent = liveEnabled ? 'Live trading enabled. Review and confirm every real-money order.' : 'Live trading disabled.';
      setOrderControls();
    } catch (error) { message(error.message); }
  });
  find('#moomooAccount').addEventListener('change', () => { clearReview(); setOrderControls(); });
  document.querySelectorAll('.moomoo-order-form').forEach(form => {
    form.addEventListener('input', clearReview);
    form.addEventListener('submit', async event => {
      event.preventDefault(); clearReview(); submitting = true; setOrderControls();
      try {
        review = await post('/api/moomoo/orders/review', {
          accountId: find('#moomooAccount').value, symbol: form.elements.symbol.value,
          side: form.dataset.side, quantity: Number(form.elements.quantity.value), limitPrice: Number(form.elements.limitPrice.value)
        });
        const order = review.order;
        find('#moomooReviewDetails').textContent = `${order.side} ${order.quantity} shares of ${order.symbol} at a limit of ${usd.format(order.limitPrice)} each. Maximum order value ${usd.format(review.maximumValueUsd)}, before fees. Account ending ${order.accountId.slice(-4)}. ${review.message}`;
        find('#moomooReviewExpiry').textContent = 'This review expires in 60 seconds. Sending submits a real order to Moomoo.';
        find('#moomooOrderReview').hidden = false;
        expiryTimer = setTimeout(() => { clearReview(); message('Order review expired. Review again to continue.'); }, 60000);
      } catch (error) { message(error.message); }
      finally { submitting = false; setOrderControls(); }
    });
  });
  find('#cancelMoomooReview').addEventListener('click', clearReview);
  find('#submitMoomooOrder').addEventListener('click', async () => {
    if (!review || submitting) return;
    const token = review.token;
    clearReview(); submitting = true; setOrderControls();
    try { const result = await post('/api/moomoo/orders/submit', { token, confirmed: true }); message(`${result.message} Order ID: ${result.orderId}`); }
    catch (error) { message(error.message); }
    finally { submitting = false; setOrderControls(); }
  });
  if (new URLSearchParams(location.search).get('moomoo') === 'authorization-failed') message('Moomoo authorization was declined, expired or could not be completed. Connect again.');
  loadStatus();
})();
