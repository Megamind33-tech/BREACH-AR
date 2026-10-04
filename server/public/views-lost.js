'use strict';
/* Lost or stolen: a card on the computer's own page to mark it, cancel it, and see the trail of networks it has connected from.
   Reporting it sets a passphrase the person who finds it, or you, enters on the PC to unlock it; the passphrase itself never leaves this dialog unhashed. */

EXTRA_DEVICE_HOOKS.push((main, d, { again }) => {
  if (!can('admin') || !d?.id) return;
  const lost = !!d.lost_mode;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'lost-card';
  card.innerHTML = lost
    ? `<h2>Reported lost or stolen</h2><p class="mute" style="margin:0 0 12px">Reported ${esc(ago(d.lost_at))}.${d.lost_note ? ' ' + esc(d.lost_note) : ''} It will lock on its own screen until the passphrase is entered there, or you cancel this below. This does not survive a Windows reinstall, and does not stop someone with full administrator rights on the PC from removing it.</p>
      <div class="actions"><button class="ghost" id="lost-cancel">Cancel lost mode</button></div>
      <div id="lost-locations" class="mute" style="margin-top:14px">Loading where it has connected from…</div>`
    : `<h2>Lost or stolen</h2><p class="mute" style="margin:0 0 12px">If this computer goes missing, lock it with a passphrase you choose. It locks the next time it is online, and again at every sign-in, until the passphrase is entered on the PC or you cancel it here. A buyer who checks its serial the way a Viro certificate is checked will see it was reported.</p>
      <div class="actions"><button id="lost-report">Report lost or stolen</button></div>`;
  const anchor = main.querySelector('.remote-bar') ?? main.querySelector(':scope > .readout') ?? main.querySelector(':scope > .dossier');
  anchor ? anchor.insertAdjacentElement('afterend', card) : main.insertBefore(card, main.firstChild);

  $('#lost-report', card)?.addEventListener('click', async () => {
    const r = await dialog('Report lost or stolen', `<p class="mute">Choose a passphrase. Whoever has this PC must enter it, on the PC, before it can be used again. Keep it somewhere you will find it.</p>
      <label>Passphrase (6 or more characters)</label><input name="passphrase" type="password" required minlength="6" autocomplete="off">
      <label>Note (optional, for your own records)</label><input name="note" maxlength="300" placeholder="e.g. taken from the staff room on...">`, 'Lock it', true);
    if (!r) return;
    try { const x = await post(`/api/v1/devices/${d.id}/lost`, { passphrase: r.passphrase, note: r.note || undefined }); toast(x.message); again(); } catch (e) { fail(e); }
  });
  $('#lost-cancel', card)?.addEventListener('click', async () => {
    if (!(await confirmBox('Cancel lost mode?', 'The computer will unlock the next time it is online. Only do this once you have it back, or you know the report was a mistake.'))) return;
    try { const x = await post(`/api/v1/devices/${d.id}/lost/cancel`); toast(x.message); again(); } catch (e) { fail(e); }
  });
  if (lost) {
    api(`/api/v1/devices/${d.id}/locations`).then(r => {
      const box = $('#lost-locations', card); if (!box) return;
      box.innerHTML = !r.locations.length ? 'No network seen since this was reported.' :
        `<b style="color:var(--ink)">Networks seen, most recent first</b><div class="list" style="margin-top:8px">${r.locations.slice(0, 20).map(l => `<div class="item"><div class="main"><b>${esc(l.public_ip ?? 'unknown address')}</b><small>${esc(ago(l.at))}</small></div></div>`).join('')}</div>`;
    }).catch(() => { const box = $('#lost-locations', card); if (box) box.textContent = 'Could not load the location history.'; });
  }
});
