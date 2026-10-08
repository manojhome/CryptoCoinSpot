(() => {
  const find = selector => document.querySelector(selector);
  const percent = value => value == null ? 'N/A' : `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
  const currency = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:6});
  const time = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', dateStyle:'medium', timeStyle:'short'});
  let items = [];
  let sort = {key:'dayChange', direction:-1};
  function render() {
    const ordered = [...items].sort((a,b) => {
      const left=a[sort.key], right=b[sort.key];
      if (left == null) return right == null ? a.symbol.localeCompare(b.symbol) : 1;
      if (right == null) return -1;
      return (typeof left === 'string' ? left.localeCompare(right) : left-right) * sort.direction || a.symbol.localeCompare(b.symbol);
    });
    const magnitude = Math.max(1,...items.map(item=>item.dayChange));
    const cell = value => `<td class="numeric ${value > 0 ? 'positive' : value < 0 ? 'negative' : ''}">${percent(value)}</td>`;
    find('#usGainersRows').innerHTML = ordered.length ? ordered.map((item,index)=>`<tr><td>${index+1}</td>
      <td><button class="gainer-symbol" type="button" data-symbol="${escapeHtml(item.symbol)}">${escapeHtml(item.symbol.replace(/^US\./,''))}</button><small>${escapeHtml(item.company)}</small><span class="gainer-bar" style="width:${Math.max(1,item.dayChange/magnitude*100)}%"></span></td>
      ${cell(item.threeDayAverage)}${cell(item.previousDay)}${cell(item.dayBefore)}${cell(item.dayChange)}${cell(item.hourChange)}
      <td class="numeric">${item.price == null ? 'N/A' : currency.format(item.price)}</td><td>${item.quoteTime ? escapeHtml(time.format(new Date(item.quoteTime))) : 'Unavailable'}<small>Session: ${escapeHtml(item.tradingDate)}</small></td></tr>`).join('') : '<tr><td colspan="9" class="empty-stock-row">No positive US stock movers returned.</td></tr>';
    document.querySelectorAll('[data-gainer-sort]').forEach(button=> {
      const selected=button.dataset.gainerSort===sort.key;
      button.closest('th').setAttribute('aria-sort', selected ? sort.direction===1 ? 'ascending' : 'descending' : 'none');
    });
  }
  async function load() {
    find('#refreshUsGainers').disabled=true;
    find('#usGainersStatus').textContent='Loading US ranking and price history…';
    try {
      const response=await fetch('/api/moomoo/us/gainers',{cache:'no-store'});
      const result=await readJson(response);
      items=result.items; render();
      find('#usGainersStatus').textContent=`${items.length} stocks · refreshed ${time.format(new Date(result.retrievedAt))} (New York). Click column headings to sort.`;
      find('#usGainersNote').textContent=result.note;
    } catch(error) {
      items=[];
      find('#usGainersStatus').textContent=error.message;
      find('#usGainersRows').innerHTML='<tr><td colspan="9" class="empty-stock-row">Ranking unavailable. Connect Moomoo and check quote permissions.</td></tr>';
    } finally {find('#refreshUsGainers').disabled=false;}
  }
  find('#refreshUsGainers').addEventListener('click',load);
  document.querySelectorAll('[data-gainer-sort]').forEach(button=>button.addEventListener('click',()=> {
    const key=button.dataset.gainerSort;
    sort={key,direction:sort.key===key ? -sort.direction : key==='symbol' ? 1 : -1}; render();
  }));
  find('#usGainersRows').addEventListener('click',event=> {
    const button=event.target.closest('[data-symbol]'); if(!button)return;
    find('#usSymbols').value=button.dataset.symbol;
    find('#usStocksForm').requestSubmit();
    find('#usStocksHeading').scrollIntoView({behavior:'smooth',block:'start'});
  });
  load();
})();
