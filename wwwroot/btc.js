'use strict';
const $ = id => document.getElementById(id);
let tickers = [], balances = [], csrf = '', trading = false, refreshing = false;
const format = n => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-AU', {maximumFractionDigits:8}) : '—';
const aud = n => n == null ? '—' : Number(n).toLocaleString('en-AU', {style:'currency',currency:'AUD'});
async function api(path, options) {
  const response = await fetch('/api/btc/' + path, {cache:'no-store', ...options});
  if (response.status === 401) { location.href='/access/login'; throw new Error('Sign in to continue.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function cell(row, text) { const td = row.insertCell(); td.textContent = text; return td; }
function action(cell, label, handler) { const b=document.createElement('button'); b.type='button'; b.textContent=label; b.onclick=handler; cell.append(b); }
function quoteAud(t) {
  const quote=t.marketId.split('-')[1];
  const rate=quote==='AUD'?1:Number(tickers.find(x=>x.marketId===quote+'-AUD')?.lastPrice);
  return Number.isFinite(rate) ? Number(t.volumeQte24h)*rate : null;
}
function drawMarkets() {
  $('markets').replaceChildren();
  const filter=$('search').value.toUpperCase();
  [...tickers].sort((a,b)=>(quoteAud(b)??-1)-(quoteAud(a)??-1)).filter(t=>t.marketId.includes(filter)).forEach(t=>{
    const r=$('markets').insertRow(); cell(r,t.marketId); cell(r,format(t.lastPrice));
    const change=cell(r,format(t.pricePct24h)+'%'); change.className=Number(t.pricePct24h)>=0?'positive':'negative';
    cell(r,aud(quoteAud(t))); const a=cell(r,'');
    action(a,'Buy',()=>select('Bid',t)); action(a,'Sell',()=>select('Ask',t));
  });
}
function drawWallet() {
  $('wallet').replaceChildren();
  balances.filter(b=>Number(b.balance)>0).forEach(b=>{
    const r=$('wallet').insertRow(); cell(r,b.assetName); cell(r,format(b.balance)); cell(r,format(b.available)); cell(r,format(b.locked));
    const t=tickers.find(t=>t.marketId===b.assetName+'-AUD');
    cell(r,aud(b.assetName==='AUD'?Number(b.balance):t?Number(b.balance)*Number(t.lastPrice):null));
    const a=cell(r,''); if(t && Number(b.available)>0) action(a,'Sell',()=>select('Ask',t,b.available)); else a.textContent=b.assetName==='AUD'?'Cash':'No AUD sell market';
  });
}
function select(side,t,amount) {
  const form=$(side); form.elements.market.value=t.marketId;
  form.elements.price.value=side==='Bid'?t.bestAsk:t.bestBid;
  form.elements.amount.value=amount ?? '';
  form.scrollIntoView({behavior:'smooth',block:'center'}); form.elements.amount.focus();
}
for(const [side,title] of [['Bid','Buy'],['Ask','Sell']]) {
  const form=document.createElement('form'); form.id=side; form.className='live-trade-card btc-order '+(side==='Bid'?'buy-card':'sell-card');
  form.innerHTML=`<h3>${title} now</h3><label>Market<select name="market" required></select></label><label>Coin quantity<input name="amount" type="number" min="0" step="any" required></label><label>Limit price (market quote currency)<input name="price" type="number" min="0" step="any" required></label><p class="estimate">Enter quantity and price.</p><button type="submit" disabled>${title} immediately</button><output role="status"></output>`;
  $('forms').append(form);
  form.oninput=()=>{form.querySelector('.estimate').textContent='Order value before fees: '+format(Number(form.elements.amount.value)*Number(form.elements.price.value))+' '+(form.elements.market.value.split('-')[1]||'');};
  form.elements.market.onchange=()=>{const t=tickers.find(t=>t.marketId===form.elements.market.value);if(t) form.elements.price.value=side==='Bid'?t.bestAsk:t.bestBid;};
  form.onsubmit=async e=>{
    e.preventDefault(); if(!trading) return;
    const marketId=form.elements.market.value, amount=Number(form.elements.amount.value), price=Number(form.elements.price.value);
    if(!(amount>0 && price>0)) return;
    if(!confirm(`${title} ${amount} ${marketId.split('-')[0]} at limit ${price} ${marketId.split('-')[1]}? This submits a real immediate-or-cancel order.`)) return;
    const button=form.querySelector('button'), output=form.querySelector('output'); button.disabled=true;
    const id=crypto.randomUUID(); output.textContent='Submitting…';
    try {const result=await api('orders',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({marketId,side,amount,price,id})});output.textContent=`Order ${result.orderId}: ${result.status}. Check BTC Markets for final fills.`; await loadWallet();}
    catch(error){output.textContent=error.message+' Client ID: '+id;}
    finally{button.disabled=!trading;}
  };
}
async function loadWallet() {
  try {balances=await api('wallet');drawWallet();$('walletStatus').textContent=balances.some(b=>Number(b.balance)>0)?'Updated '+new Date().toLocaleTimeString():'No holdings.';}
  catch(e){balances=[];drawWallet();$('walletStatus').textContent=e.message;}
}
async function refresh() {
  if(refreshing)return;refreshing=true;$('refresh').disabled=true;
  await Promise.allSettled([
    (async()=>{try{const s=await api('status');csrf=s.csrfToken;trading=s.trading;$('connection').textContent=!s.configured?'Public prices available. Wallet requires BTCMARKETS_API_KEY and BTCMARKETS_API_SECRET on the server.':trading?'Wallet connected. Live trading enabled.':'Wallet configured. Live trading disabled on the server.';document.querySelectorAll('.btc-order button').forEach(b=>b.disabled=!trading);}catch(e){$('connection').textContent=e.message;trading=false;document.querySelectorAll('.btc-order button').forEach(b=>b.disabled=true);}})(),
    (async()=>{try{tickers=await api('markets');drawMarkets();for(const side of ['Bid','Ask']){const select=$(side).elements.market,previous=select.value;select.replaceChildren();for(const t of tickers){const o=document.createElement('option');o.value=t.marketId;o.textContent=t.marketId;select.append(o);}select.value=tickers.some(t=>t.marketId===previous)?previous:tickers.some(t=>t.marketId==='BTC-AUD')?'BTC-AUD':tickers[0]?.marketId;}drawWallet();$('marketStatus').textContent=tickers.length+' markets · Updated '+new Date().toLocaleTimeString();}catch(e){$('marketStatus').textContent=e.message+' Displayed prices may be stale.';}})(),
    loadWallet()
  ]);refreshing=false;$('refresh').disabled=false;
}
$('search').oninput=drawMarkets;$('refresh').onclick=refresh;refresh();setInterval(refresh,30000);
