'use strict';
/* Administration: Team (people, roles, two-step status) and Settings (organization, your sign-in security, compute consent). */

NAV.push(['team', 'Team'], ['settings', 'Settings']);
Object.assign(ICON_PATHS, {
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M17 14.2c2.4.2 4.2 2.2 4.2 4.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
});

const ROLE_HELP = {
  owner: 'Everything, including the team, two-step rule and compute consent.',
  admin: 'Manage computers, policies and people (not owners).',
  technician: 'Run jobs, fixes and remote support.',
  viewer: 'See everything, change nothing.',
};
const roleSelect = (name, cur, max) => `<select name="${name}">${['viewer', 'technician', 'admin', 'owner'].filter(r => roleRank(r) <= roleRank(max)).map(r => `<option value="${r}" ${r === cur ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}: ${esc(ROLE_HELP[r])}</option>`).join('')}</select>`;
const roleRank = r => ({ viewer: 1, technician: 2, admin: 3, owner: 4 }[r] ?? 0);

// ------------------------------------------------------------------------------------------------ Team
VIEWS.team = async main => {
  if (!can('admin')) { main.innerHTML = '<div class="page-head"><h1>Team</h1></div>' + emptyState('team', 'Administrators manage the team.'); return; }
  const { users, requireMfa } = await api('/api/v1/users');
  const live = users.filter(u => !u.disabled_at).length;
  main.innerHTML = `<div class="page-head"><h1>Team</h1><button id="adduser">Add person</button></div>
    <p class="lead">${plural(live, 'operator')} can sign in${users.length > live ? `, ${users.length - live} disabled` : ''}.${requireMfa ? ' Two-step sign-in is required for owners, admins and technicians.' : ''}</p>
    <div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Two-step</th><th class="hide-sm">Last sign-in</th><th></th></tr></thead><tbody>${users.map(u => `<tr>
      <td>${esc(u.email)}${u.id === ME.userId ? ' <span class="tag">you</span>' : ''}${u.disabled_at ? ' <span class="pill unknown">disabled</span>' : ''}</td>
      <td>${esc(u.role)}</td>
      <td>${u.mfa ? '<span class="pill healthy">On</span>' : (requireMfa && ['owner', 'admin', 'technician'].includes(u.role) ? '<span class="pill attention">Not set up</span>' : '<span class="pill unassessed">Off</span>')}</td>
      <td class="hide-sm">${u.last_login_at ? ago(u.last_login_at) : 'never'}</td>
      <td class="nowrap">${u.id === ME.userId || roleRank(u.role) > roleRank(ME.role) ? '' : `<button class="ghost sm" data-edit="${esc(u.id)}">Edit</button> <button class="ghost sm" data-more="${esc(u.id)}">More</button>`}</td></tr>`).join('')}</tbody></table></div>
    <details class="card"><summary>What each role can do</summary><dl style="margin-top:10px">${Object.entries(ROLE_HELP).reverse().map(([r, t]) => `<dt>${r[0].toUpperCase() + r.slice(1)}</dt><dd>${esc(t)}</dd>`).join('')}</dl></details>`;
  const byId = id => users.find(u => u.id === id);

  $('#adduser').onclick = async () => {
    const v = await dialog('Add a person', `<label>Email</label><input name="email" type="email" required autocomplete="off">
      <label>Temporary password (12+ characters, they can change it under Settings)</label><input name="password" type="text" minlength="12" required autocomplete="off">
      <label>Role</label>${roleSelect('role', 'viewer', ME.role)}`, 'Add');
    if (!v) return;
    try { await post('/api/v1/users', { email: v.email.trim(), password: v.password, role: v.role }); toast('Person added. Give them the temporary password in person.'); reroute(); } catch (x) { fail(x); }
  };
  $$('[data-edit]').forEach(b => b.onclick = async () => {
    const u = byId(b.dataset.edit);
    const v = await dialog('Edit ' + u.email, `<label>Role</label>${roleSelect('role', u.role, ME.role)}
      <label class="switch-field" style="margin-top:14px"><span><b>Can sign in</b><small>Turn off to lock this person out right away.</small></span><input type="checkbox" class="switch" name="active" ${u.disabled_at ? '' : 'checked'}></label>`, 'Save');
    if (!v) return;
    const body = {}; if (v.role !== u.role) body.role = v.role; if ((v.active === 'on') === !!u.disabled_at) body.disabled = v.active !== 'on';
    if (!Object.keys(body).length) return;
    try { await patch('/api/v1/users/' + u.id, body); toast('Saved.'); reroute(); } catch (x) { fail(x); }
  });
  $$('[data-more]').forEach(b => b.onclick = async () => {
    const u = byId(b.dataset.more);
    const v = await dialog(u.email, `<label>What do you want to do?</label><select name="act"><option value="password">Set a new password</option>${u.mfa ? '<option value="mfa">Reset two-step sign-in (lost phone)</option>' : ''}<option value="remove">Remove from the team</option></select>`, 'Continue');
    if (!v) return;
    try {
      if (v.act === 'password') {
        const p = await dialog('New password for ' + u.email, '<label>Temporary password (12+ characters)</label><input name="password" type="text" minlength="12" required autocomplete="off">', 'Set password');
        if (p) { await post(`/api/v1/users/${u.id}/password`, { password: p.password }); toast('Password changed.'); }
      } else if (v.act === 'mfa') {
        if (await confirmBox('Reset two-step sign-in?', `${u.email} will sign in with their password only until they set it up again.`, 'Reset', true)) { await post(`/api/v1/users/${u.id}/mfa-reset`); toast('Two-step sign-in reset.'); reroute(); }
      } else if (await confirmBox('Remove ' + u.email + '?', 'They lose access immediately. Their past actions stay in the audit log.', 'Remove', true)) { await del('/api/v1/users/' + u.id); toast('Removed.'); reroute(); }
    } catch (x) { fail(x); }
  });
};

// ------------------------------------------------------------------------------------------------ Settings
const UTC_OFFSETS = [-720, -660, -600, -570, -540, -480, -420, -360, -300, -240, -210, -180, -120, -60, 0, 60, 120, 180, 210, 240, 270, 300, 330, 345, 360, 390, 420, 480, 525, 540, 570, 600, 630, 660, 720, 765, 780, 840];
const offsetLabel = m => 'UTC' + (m < 0 ? '−' : '+') + String(Math.floor(Math.abs(m) / 60)).padStart(2, '0') + ':' + String(Math.abs(m) % 60).padStart(2, '0');
const COUNTRIES = { ZM: 'Zambia', ZA: 'South Africa', KE: 'Kenya', NG: 'Nigeria', GH: 'Ghana', TZ: 'Tanzania', UG: 'Uganda', ZW: 'Zimbabwe', MW: 'Malawi', BW: 'Botswana', NA: 'Namibia', MZ: 'Mozambique', RW: 'Rwanda', GB: 'United Kingdom', US: 'United States', IN: 'India', AE: 'United Arab Emirates', DE: 'Germany', FR: 'France', XX: 'Not set' };

VIEWS.settings = async main => {
  const [acct, org, consent] = await Promise.all([api('/api/v1/account'), api('/api/v1/org/settings').catch(() => null), api('/api/v1/compute/consent').catch(() => null)]);
  const isAdmin = can('admin'), isOwner = can('owner');
  const mfaNote = acct.mfaSetupRequired ? `<div class="card" style="border-color:var(--warn)"><b>Set up two-step sign-in to continue.</b> <span class="mute">Your organization requires it. Everything else unlocks as soon as it is on.</span></div>` : '';
  main.innerHTML = `<div class="page-head"><h1>Settings</h1></div>${mfaNote}
    <div class="card" id="mysec"><h2>Your sign-in</h2>
      <p class="mute" style="margin-top:0">${esc(acct.email)} · ${esc(acct.role)}${acct.lastLoginAt ? ' · last sign-in ' + ago(acct.lastLoginAt) : ''}</p>
      <div class="toggle-row"><span><b>Two-step sign-in</b><br><span class="mute">${acct.mfa.enabled ? `On. ${acct.mfa.recoveryCodesLeft} recovery codes left.` : acct.orgRequiresMfa ? 'Required by your organization.' : 'A code from an authenticator app, as well as your password.'}</span></span>
        <span class="actions" style="margin:0">${acct.mfa.enabled ? `<button class="ghost sm" id="newcodes">New recovery codes</button>${acct.orgRequiresMfa ? '' : '<button class="ghost sm" id="mfaoff">Turn off</button>'}` : '<button id="mfaon">Turn on</button>'}</span></div>
      <div class="actions"><button class="ghost" id="chpw">Change password</button></div></div>
    ${org ? `<div class="card"><h2>Organization</h2>
      <form id="orgform"><div class="form-grid">
        <div><label for="o-name">Name</label><input id="o-name" name="name" value="${esc(org.name)}" required maxlength="120" ${isAdmin ? '' : 'disabled'}></div>
        <div><label for="o-cc">Country</label><select id="o-cc" name="countryCode" ${isAdmin ? '' : 'disabled'}>${Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}" ${k === org.countryCode ? 'selected' : ''}>${esc(v)} (${k})</option>`).join('')}${COUNTRIES[org.countryCode] ? '' : `<option value="${esc(org.countryCode)}" selected>${esc(org.countryCode)}</option>`}</select><small class="mute">Part of each computer's compute worker ID. Existing computers keep theirs.</small></div>
        <div><label for="o-tz">Time zone</label><select id="o-tz" name="utcOffsetMinutes" ${isAdmin ? '' : 'disabled'}>${[...new Set([...UTC_OFFSETS, org.utcOffsetMinutes])].sort((a, b) => a - b).map(m => `<option value="${m}" ${m === org.utcOffsetMinutes ? 'selected' : ''}>${offsetLabel(m)}</option>`).join('')}</select><small class="mute">For schedules such as allowed hours.</small></div>
        <div><label for="o-em">Alert contacts (one email per line)</label><textarea id="o-em" name="emails" rows="3" ${isAdmin ? '' : 'disabled'} spellcheck="false">${esc(org.notificationEmails.join('\n'))}</textarea><small class="mute">Recorded for summaries and alerts. Email sending is not switched on yet.</small></div></div>
        <label class="switch-field"><span><b>Require two-step sign-in</b><small>For owners, admins and technicians.${isOwner ? '' : ' Only an owner can change this.'}</small></span><input type="checkbox" class="switch" name="requireMfa" ${org.requireMfa ? 'checked' : ''} ${isOwner ? '' : 'disabled'}></label>
        ${isAdmin ? '<div class="actions"><button>Save</button></div>' : ''}</form>
      <p class="mute" style="margin-bottom:0">Plan: <b>${org.plan === 'compute_sponsored' ? 'Compute sponsored' : 'Standard'}</b></p></div>` : ''}
    ${consent ? `<div class="card" id="consent"><h2>Compute consent</h2>
      <p class="mute" style="margin-top:0">${consent.accepted ? `Accepted by ${esc(consent.current.user_email)} ${ago(consent.current.accepted_at)} (wording ${esc(consent.wording.version)}). Recorded and signed.` : 'Needed before the mining workload can be switched on.'}</p>
      <details><summary>Read the wording</summary><p style="white-space:pre-line">${esc(consent.wording.text)}</p></details>
      ${consent.accepted ? '' : isOwner ? '<div class="actions"><button id="accept">I accept for my organization</button></div>' : '<p class="mute">An owner must accept.</p>'}</div>` : ''}`;

  const codesDialog = codes => dialog('Save your recovery codes', `<p>Each code works once if you lose your phone. They are shown only now: store them somewhere safe.</p><textarea readonly rows="6" onfocus="this.select()" style="font-family:monospace">${esc(codes.join('\n'))}</textarea>`, 'I saved them');
  $('#mfaon')?.addEventListener('click', async () => {
    const p = await dialog('Turn on two-step sign-in', '<label>Your password</label><input name="password" type="password" required autocomplete="current-password">', 'Continue');
    if (!p) return;
    try {
      const s = await post('/api/v1/account/mfa/setup', { password: p.password });
      const c = await dialog('Add it to your authenticator app', `<p>In your authenticator app choose “enter a setup key” and type this key (spaces do not matter), then enter the 6-digit code it shows.</p>
        <input readonly value="${esc(s.secret.match(/.{1,4}/g).join(' '))}" onfocus="this.select()" style="font-family:monospace;letter-spacing:.08em"><p class="mute"><a href="${esc(s.uri)}">Open in an app on this device</a></p>
        <label>6-digit code</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">`, 'Turn on');
      if (!c) return;
      const r = await post('/api/v1/account/mfa/enable', { code: c.code.trim() });
      token = r.token; sessionStorage.setItem('viro_token', token); ME = null;
      await codesDialog(r.recoveryCodes); toast('Two-step sign-in is on.'); location.hash = '#/settings'; route();
    } catch (x) { fail(x); }
  });
  $('#mfaoff')?.addEventListener('click', async () => {
    const v = await dialog('Turn off two-step sign-in', '<label>Your password</label><input name="password" type="password" required autocomplete="current-password"><label>Code from your app (or a recovery code)</label><input name="code" required autocomplete="one-time-code">', 'Turn off', true);
    if (v) try { await post('/api/v1/account/mfa/disable', v); toast('Two-step sign-in is off.'); reroute(); } catch (x) { fail(x); }
  });
  $('#newcodes')?.addEventListener('click', async () => {
    const v = await dialog('New recovery codes', '<p>The old codes stop working.</p><label>Your password</label><input name="password" type="password" required autocomplete="current-password"><label>Code from your app</label><input name="code" inputmode="numeric" required autocomplete="one-time-code">', 'Make new codes');
    if (v) try { const r = await post('/api/v1/account/mfa/recovery-codes', v); await codesDialog(r.recoveryCodes); reroute(); } catch (x) { fail(x); }
  });
  $('#chpw')?.addEventListener('click', async () => {
    const v = await dialog('Change password', '<label>Current password</label><input name="current" type="password" required autocomplete="current-password"><label>New password (12+ characters)</label><input name="next" type="password" minlength="12" required autocomplete="new-password">', 'Change');
    if (v) try { await post('/api/v1/account/password', v); toast('Password changed.'); } catch (x) { fail(x); }
  });
  $('#orgform')?.addEventListener('submit', async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try {
      await put('/api/v1/org/settings', { name: f.name.trim(), countryCode: f.countryCode, utcOffsetMinutes: +f.utcOffsetMinutes, requireMfa: f.requireMfa === 'on', notificationEmails: f.emails.split(/[\s,;]+/).filter(Boolean) });
      ME = null; toast('Saved.'); route();
    } catch (x) { fail(x); }
  });
  $('#accept')?.addEventListener('click', async () => { try { await post('/api/v1/compute/consent', {}); toast('Consent recorded.'); reroute(); } catch (x) { fail(x); } });
};

/* ---------- plan and payments ---------- */
VIEWS.billing = async main => {
  const v = await api('/api/v1/billing');
  const sub = v.subscription;
  const price = p => `${esc(p.currency)} ${Number(p.price).toLocaleString('en-US')}${p.period === 'once' ? '' : ' / ' + (p.period === 'year' ? 'year' : 'month')}${p.per === 'pc' ? ' per computer' : p.per === 'certificate' ? ' per certificate' : ''}`;
  const STATUS = { pending: ['unknown', 'Waiting for your payment'], submitted: ['attention', 'Waiting for Viro to confirm'], paid: ['healthy', 'Paid'], cancelled: ['unknown', 'Cancelled'], rejected: ['critical', 'Not accepted'] };
  main.innerHTML = `<div class="page-head"><h1>Plan and payments</h1></div>
    <div class="card"><h2>Your plan</h2>${sub ? `<p style="margin:0"><b>${esc(sub.name)}</b> for ${esc(sub.quantity)} computer${sub.quantity === 1 ? '' : 's'}. ${sub.validUntil ? (sub.active ? 'Paid until ' + esc(new Date(sub.validUntil).toLocaleDateString([], { dateStyle: 'medium' })) + '.' : '<span class="pill attention">Expired</span> Renew below to keep it.') : 'Paid once.'}</p>` : '<p style="margin:0">You are on the free plan. Everything in it keeps working.</p>'}</div>
    ${v.plans.length ? `<div class="card"><h2>Choose a plan</h2>${v.plans.map(p => `<div class="issue"><span class="pts">${price(p)}</span><b>${esc(p.name)}</b>${p.description ? `<small>${esc(p.description)}</small>` : ''}${(p.features ?? []).length ? `<small>${p.features.map(esc).join(' · ')}</small>` : ''}${can('admin') ? `<span class="pts"><button class="sm" data-buy="${esc(p.code)}">Buy</button></span>` : ''}</div>`).join('')}</div>` : `<div class="card"><p class="mute" style="margin:0">${esc(v.note ?? '')}</p></div>`}
    ${v.orders.length ? `<div class="card"><h2>Your orders</h2><div class="table-wrap"><table><thead><tr><th>Reference</th><th>Plan</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${v.orders.map(o => { const [k, t] = STATUS[o.status] ?? ['unknown', o.status]; return `<tr><td><b>${esc(o.reference)}</b><br><small class="mute">${esc(new Date(o.created_at).toLocaleDateString([], { dateStyle: 'medium' }))}</small></td><td>${esc(o.plan_code)} × ${esc(o.quantity)}</td><td>${esc(o.currency)} ${Number(o.amount).toLocaleString('en-US')}</td><td><span class="pill ${k}">${esc(t)}</span>${o.reject_reason ? `<br><small class="mute">${esc(o.reject_reason)}</small>` : ''}</td><td>${can('admin') && ['pending', 'submitted'].includes(o.status) ? `<button class="ghost sm" data-paid="${esc(o.id)}">I have paid</button> ${o.status === 'pending' ? `<button class="ghost sm" data-cancel="${esc(o.id)}">Cancel</button>` : ''}` : ''}</td></tr>`; }).join('')}</tbody></table></div></div>` : ''}`;

  const payBox = (o) => `<p>Pay <b>${esc(o.currency)} ${Number(o.amount).toLocaleString('en-US')}</b> by <b>${esc(o.pay.method)}</b>.</p><p>${esc(o.pay.instructions)}</p>
    ${Object.keys(o.pay.details ?? {}).length ? `<div class="kv">${Object.entries(o.pay.details).map(([k, val]) => `<div><span class="mute">${esc(k)}</span> <b>${esc(val)}</b></div>`).join('')}</div>` : ''}
    <p style="font-size:18px;letter-spacing:1px;margin:12px 0"><span class="mute" style="font-size:13px">Your reference</span><br><b>${esc(o.pay.useReference)}</b></p><p class="mute">Quote this reference when you pay, then choose "I have paid" and give us the transaction number. Your plan starts when Viro confirms the money.</p>`;

  $$('[data-buy]').forEach(b => b.onclick = async () => {
    const p = v.plans.find(x => x.code === b.dataset.buy);
    const r = await dialog('Buy ' + p.name, `<label>${p.per === 'pc' ? 'How many computers?' : p.per === 'certificate' ? 'How many certificates?' : 'Quantity'}</label><input name="q" type="number" min="1" max="5000" value="1" ${p.per === 'account' ? 'disabled' : ''}>
      <label>How will you pay?</label><select name="m">${v.methods.filter(m => !m.currency || m.currency === p.currency).map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</select><p class="mute">${esc(price(p).replace(/&amp;/g, '&'))}. You will see the exact amount and how to pay on the next screen.</p>`, 'Continue');
    if (!r) return;
    try { const o = await post('/api/v1/billing/orders', { planCode: p.code, quantity: +r.q || 1, methodId: r.m }); await dialog('Pay to start your plan', payBox(o), 'Done'); reroute(); } catch (e) { fail(e); }
  });
  $$('[data-paid]').forEach(b => b.onclick = async () => {
    const r = await dialog('Tell us you have paid', '<label>Your name (as on the payment)</label><input name="payerName" required><label>Phone number</label><input name="payerPhone"><label>Transaction number, bank reference or cash receipt number</label><input name="transactionId" required>', 'Send');
    if (!r) return;
    try { const x = await post(`/api/v1/billing/orders/${b.dataset.paid}/paid`, { payerName: r.payerName, payerPhone: r.payerPhone || undefined, transactionId: r.transactionId }); toast(x.message); reroute(); } catch (e) { fail(e); }
  });
  $$('[data-cancel]').forEach(b => b.onclick = async () => { if (!(await confirmBox('Cancel this order?', 'Nothing has been paid, so nothing is lost.', 'Cancel order', true))) return; try { await post(`/api/v1/billing/orders/${b.dataset.cancel}/cancel`); reroute(); } catch (e) { fail(e); } });
};
