'use strict';
/* "Add computers": one downloadable file per organization that installs and enrolls a PC. Used from the Overview and Computers pages. */

async function addComputers() {
  let inst, sites;
  try { [inst, sites] = await Promise.all([api('/api/v1/installer'), api('/api/v1/sites')]); } catch (x) { return fail(x); }
  const siteOpts = sites.sites.flatMap(s => [`<option value="site:${esc(s.id)}">${esc(s.name)}</option>`, ...s.departments.map(d => `<option value="department:${esc(d.id)}">${esc(s.name)} / ${esc(d.name)}</option>`)]);
  const v = await dialog('Add computers',
    `${inst.available ? "" : "<p class=\"mute\">The one-file installer has not been published to this server yet, so only a connection code can be created (for a PC that already has Viro installed).</p>"}<ol><li>Download the installer file below.</li>
       <li>On each PC, right-click it and choose <b>Run with PowerShell</b> as administrator. Or deploy it with Intune, Group Policy or your remote-management tool.</li>
       <li>The PC appears in Viro within a minute and starts looking after itself.</li></ol>
     <label>Put these computers in</label><select name="where"><option value="">No site yet (you can move them later)</option>${siteOpts.join('')}</select>
     <label><input type="checkbox" name="code"${inst.available ? "" : " checked"}> Create a short connection code for one PC instead (the person pastes it into the Viro window)</label>
     <p class="mute">The file contains a private enrollment token that works for 14 days. Keep it private and delete it afterwards.</p>`, 'Download installer');
  if (!v) return;
  const body = { serverUrl: location.origin };
  if (v.where) { const [type, id] = v.where.split(':'); body[type === 'site' ? 'siteId' : 'departmentId'] = id; }
  if (v.code) {
    try {
      const r = await post('/api/v1/connection-codes', { ...body, ttlHours: 24, maxUses: 1 });
      await dialog('Connection code', '<p>Give this code to the person at the PC. They open <b>Viro WorkCare</b>, choose <b>Workspace</b>, paste it and press Connect. It joins <b>' + esc(r.organization) + (r.site ? ' / ' + esc(r.site) : '') + '</b>, works once and expires in 24 hours.</p><textarea readonly rows="4" style="width:100%;font-family:monospace" onclick="this.select()">' + esc(r.code) + '</textarea>', 'Done');
    } catch (x) { fail(x); }
    return;
  }
  if (!inst.available) return toast('The installer has not been published yet; create a connection code instead.');
  try {
    const r = await post('/api/v1/installer/script', body);
    const url = URL.createObjectURL(new Blob([r.script], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = r.fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Installer downloaded. Run it on each PC as administrator.');
  } catch (x) { fail(x); }
}
