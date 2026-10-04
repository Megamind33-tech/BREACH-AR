'use strict';
/* Replace and budget: what the fleet will cost to keep going, worked out from each computer's own age and wear and the organization's price list.
   One card for Overview (budgetCardHtml, compact) and a full page with every computer and a CSV export. Every figure is an estimate, and says so. */
NAV.splice(Math.max(0, NAV.findIndex(n => n[0] === 'lifecycle')), 0, ['budget', 'Replace and budget']);
NAV_GROUPS.find(g => g[0] === 'Hardware')?.[1].unshift('budget');
if (typeof NAV_LABEL !== 'undefined') NAV_LABEL.budget = 'Replace and budget';
if (typeof ICON_PATHS !== 'undefined') ICON_PATHS.budget = '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.700 3.100 3 7 3s7-1.300 7-3V6"/><path d="M5 12v6c0 1.700 3.100 3 7 3s7-1.300 7-3v-6"/>';

const kmoney = (cur, n) => n == null ? '—' : (cur === 'ZMW' ? 'K ' : (cur ? cur + ' ' : '')) + Math.round(n).toLocaleString('en-US');
const BAND_TONE = ['#34c98b', '#7ddbb0', '#f5b84a', '#f87171', '#6b7872'];
const BUCKET = { replace: ['Replace now', 'bad'], plan: ['Plan to replace', 'warn'], repair: ['Repair', 'warn'], keep: ['Keep', 'ok'], unpriced: ['Not priced', 'na'] };

window.budgetCardHtml = function (b, compact) {
  const cur = b.currency, many = n => n + (n === 1 ? ' computer' : ' computers');
  const head = compact ? `<div class="toggle-row"><h2 style="margin:0">Replace and budget</h2><a class="btn ghost sm" href="#/budget">See every computer</a></div>` : '';
  if (!b.assessed) return `<div class="card budget">${head}<p class="mute">No hardware readings yet. Each computer sends one about ten minutes after it starts. When they arrive, this shows which computers to repair or replace, and what that is likely to cost.</p></div>`;
  if (!b.priced) return `<div class="card budget">${head}<p class="mute">${can('admin') ? 'Set your prices once' : 'Ask an administrator to set prices'} and this page shows what repairs and replacements will cost. <a href="#/anatomy?prices=1">Prices</a></p></div>`;
  const spend = b.replaceNow.cost + b.plan.cost, n = b.replaceNow.count + b.plan.count;
  const unit = b.computers.filter(c => c.bucket === 'replace' || c.bucket === 'plan').map(c => c.cost).filter(Boolean);
  const range = unit.length ? (Math.min(...unit) === Math.max(...unit) ? kmoney(cur, unit[0]) + ' each' : kmoney(cur, Math.min(...unit)) + ' to ' + kmoney(cur, Math.max(...unit)) + ' each') : '';
  const total = b.ageBands.reduce((s, x) => s + x.count, 0) || 1;
  const bar = b.ageBands.map((x, i) => x.count ? `<i style="flex:${x.count};background:${BAND_TONE[i]}" title="${esc(x.label)}: ${x.count}"></i>` : '').join('');
  const legend = b.ageBands.filter(x => x.count).map(x => `<span><i style="background:${BAND_TONE[b.ageBands.indexOf(x)]}"></i>${esc(x.label)} <b>${x.count}</b></span>`).join('');
  const top = b.computers.filter(c => c.bucket === 'replace' || c.bucket === 'plan').slice(0, compact ? 4 : 8);
  const list = top.length ? `<div class="budget-list">${top.map(c => `<a href="#/computers/${esc(c.id)}"><span><b>${esc(c.hostname)}</b><small>${esc(c.reason)}</small></span><span class="amt">${kmoney(cur, c.cost)}</span></a>`).join('')}</div>` : '<p class="mute" style="margin:0">Nothing needs replacing in the near term.</p>';
  return `<div class="card budget">${head}
    <p class="mute" style="margin:2px 0 18px">Estimates, from each computer's age and wear and ${b.priceSource === 'entered' ? 'your own price list' : 'typical prices (set your own on the Prices page)'}. Not quotes.</p>
    <div class="budget-grid">
      <div class="budget-main">
        <span class="k">${b.replaceNow.count ? 'Replace now and plan ahead' : 'Plan to spend'}</span>
        <b class="fig">${kmoney(cur, spend)}</b>
        <p class="mute" style="margin:6px 0 0">${n ? `to replace ${many(n)}${range ? ' (' + range + ', with moving files and programs)' : ''}` : 'Nothing needs replacing in the near term.'}</p>
        <div class="budget-mini">
          <div><span class="k">Repairs worth doing</span><b>${kmoney(cur, b.repair.cost)}</b><small>${many(b.repair.count)}</small></div>
          <div><span class="k">Fleet worth today</span><b>${kmoney(cur, b.fleetValue)}</b><small>used value, all computers</small></div>
          <div><span class="k">Windows 11 blocked</span><b>${b.windows11Blocked}</b><small>${b.windows11Blocked ? 'no regular security updates on Windows 10' : 'all can'}</small></div>
        </div>
      </div>
      <div class="budget-side">
        <span class="k">How old the fleet is</span>
        <div class="agebar">${bar}</div><div class="agelegend">${legend}</div>
        <span class="k" style="margin-top:18px">${top.length ? 'Replace first' : ''}</span>${list}
      </div>
    </div>
    ${b.unread ? `<p class="mute" style="margin:14px 0 0;font-size:13px">${many(b.unread)} ${b.unread === 1 ? 'has' : 'have'} not sent a hardware reading yet, and ${b.unread === 1 ? 'is' : 'are'} not counted.</p>` : ''}
  </div>`;
};

VIEWS.budget = async main => {
  const b = await api('/api/v1/anatomy/budget');
  const cur = b.currency;
  main.innerHTML = `<h1>Replace and budget</h1><p class="lead">Which computers to repair or replace, and what that is likely to cost.</p>
    ${window.budgetCardHtml(b, false)}
    ${b.computers.length ? `<div class="toggle-row" style="margin:18px 0 8px"><h3 style="margin:0">Every computer</h3><button class="ghost sm" id="csv">Export CSV</button></div>
      <table><thead><tr><th>Computer</th><th>Model</th><th>Age</th><th>Decision</th><th class="nowrap">Estimated cost</th><th class="hide-sm">Why</th></tr></thead><tbody>${b.computers.map(c => `<tr class="row" data-id="${esc(c.id)}"><td class="host">${esc(c.hostname)}</td><td>${esc(c.model)}</td><td class="nowrap">${c.ageYears == null ? '—' : c.ageYears + ' yrs'}</td><td><span class="pill ${BUCKET[c.bucket][1]}">${BUCKET[c.bucket][0]}</span></td><td class="nowrap">${c.cost ? kmoney(cur, c.cost) : '—'}</td><td class="hide-sm mute">${esc(c.reason)}</td></tr>`).join('')}</tbody></table>
      <p class="mute" style="font-size:13px">"Estimated cost" is the price of a comparable new computer plus moving files and programs for those to replace, and the parts and labour for those to repair.</p>` : ''}`;
  $$('tr.row').forEach(tr => tr.onclick = () => location.hash = '#/computers/' + tr.dataset.id);
  $('#csv')?.addEventListener('click', () => {
    const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const rows = [['Computer', 'Model', 'Age (years)', 'Decision', 'Estimated cost (' + (cur || '') + ')', 'Why'], ...b.computers.map(c => [c.hostname, c.model, c.ageYears ?? '', BUCKET[c.bucket][0], c.cost ?? '', c.reason])];
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' })); a.download = 'replace-and-budget.csv'; a.click();
  });
  poll(60000);
};
