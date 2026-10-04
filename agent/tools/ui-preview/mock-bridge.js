/* A pretend Viro program for previewing the Windows app's interface in a normal browser.
   It answers the same commands as LocalBridge.cs with realistic sample data, so every page can be seen and photographed without a real PC.
   Used only by tools/ui-preview/preview.mjs; it is never shipped. */
(function () {
  const GB = 1073741824, MB = 1048576, now = Date.now(), ago = m => new Date(now - m * 60000).toISOString();
  const SCENARIO = (window.__scenario || 'attention');

  const findings = [
    { reason: 'The system drive is almost full', recommendation: 'Free up space before Windows runs out of room for updates. Viro found 11.4 GB it can clear safely.', impact: 'high', category: 'storage', remedy: 'safe-fix', fix: { recipe: 'cleanup.safe' } },
    { reason: 'Programs are holding 2.8 GB of memory they are not using', recommendation: 'Viro can ask Windows to take that memory back. Nothing is closed.', impact: 'medium', category: 'performance', remedy: 'safe-fix', fix: { recipe: 'memory.trim-idle' } },
    { reason: '9 programs start with Windows and slow the start-up', recommendation: 'Stop the ones you do not need at start-up. They still open when you start them.', impact: 'medium', category: 'performance', remedy: 'safe-fix', fix: { recipe: 'startup.optimize' } },
    { reason: '2 driver updates are waiting', recommendation: 'Drivers are rolled out by your administrator, one computer first.', impact: 'low', category: 'drivers', remedy: 'review' },
  ];
  const view = SCENARIO === 'healthy' ? null : {
    hostname: 'LAB-PC-02', autopilotLevel: 'BALANCED',
    health: { overall: 74, status: 'attention', findings, categories: { security: 96, performance: 71, storage: 48, updates: 88, drivers: 80, reliability: 92, hardware: 90 }, measured: {} },
    shield: { state: 'protected', engine: 'Microsoft Defender', reasons: ['Real-time protection is on and signatures are current.'] },
    protection: { score: 82, controls: [
      { id: 'ransomware.controlled-folders', group: 'ransomware', title: 'Controlled folder access', why: 'Stops unknown programs from changing your documents.', state: 'off', recipe: 'protection.cfa' },
      { id: 'ransomware.backup', group: 'ransomware', title: 'File History or OneDrive backup', why: 'Lets you get files back after an attack.', state: 'on' },
      { id: 'attacks.smartscreen', group: 'attacks', title: 'SmartScreen', why: 'Warns before running unrecognised programs.', state: 'on' },
      { id: 'attacks.firewall', group: 'attacks', title: 'Windows Firewall', why: 'Blocks unwanted connections from the network.', state: 'on' },
      { id: 'privacy.telemetry', group: 'privacy', title: 'Diagnostic data level', why: 'Limits what Windows sends to Microsoft.', state: 'na' },
    ] },
    securityIncidents: [],
    updates: { pending: 3, critical: 1, driverErrors: 0, rebootRequired: false },
    care: {
      thermal: { level: 'normal', cpuTempC: 52, available: true }, heatEvents30d: 0,
      battery: null, memory: { usedPercent: 52, idleTrimmableMb: 2800 },
      boot: { last: 48, history: [{ seconds: 62 }, { seconds: 55 }, { seconds: 51 }, { seconds: 58 }, { seconds: 48 }], slowest: [{ name: 'OneDrive', seconds: 11 }, { name: 'Teams', seconds: 9 }, { name: 'Adobe Updater', seconds: 7 }] },
    },
    recent: [
      { kind: 'repair', title: 'Cleared 2.1 GB of caches', at: ago(95), detail: 'Checked: free space went from 29.3 GB to 31.4 GB' },
      { kind: 'memory', title: 'Gave back 1.4 GB of idle memory', at: ago(380), detail: 'Nothing was closed' },
      { kind: 'resolved', title: 'Windows Firewall turned back on', at: ago(1500), detail: 'Verified by Windows' },
    ],
    workspace: { organization: 'Riverside Academy', site: 'Science Block', department: 'Computer Lab' },
  };

  const startup = [
    ['OneDrive', true, 'SAFE_TO_DISABLE', 'Syncs files in the background; opens fine when you start it.', '"C:\\Users\\staff\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe" /background'],
    ['Microsoft Teams', true, 'SAFE_TO_DISABLE', 'Chat app. Opens when you start it.', '"C:\\Program Files\\WindowsApps\\MSTeams\\ms-teams.exe" --system-initiated'],
    ['Adobe Updater Startup Utility', true, 'SAFE_TO_DISABLE', 'Checks for Adobe updates. Not needed at start-up.', '"C:\\Program Files (x86)\\Common Files\\Adobe\\ARM\\1.0\\AdobeARM.exe"'],
    ['Realtek HD Audio Manager', true, 'KEEP', 'Needed for sound settings.', '"C:\\Program Files\\Realtek\\Audio\\HDA\\RtkNGUI64.exe" -s'],
    ['Windows Security notification icon', true, 'KEEP', 'Shows protection alerts.', '%windir%\\system32\\SecurityHealthSystray.exe'],
    ['Spotify', true, 'ASK', 'Music player. Your decision.', '"C:\\Users\\staff\\AppData\\Roaming\\Spotify\\Spotify.exe" /minimized'],
    ['Steam Client Bootstrapper', false, 'SAFE_TO_DISABLE', 'Game launcher. Already stopped.', '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent'],
  ].map(([name, enabled, cls, reason, command]) => ({ location: 'HKCU Run', name, command, enabled, cls, reason }));

  const space = [
    ['windows-update-cache', 'Windows Update downloads', 'SAFE', 4.9 * GB, 212, 'Already installed updates. Windows downloads again if needed.'],
    ['browser-cache', 'Browser caches', 'SAFE', 2.6 * GB, 8410, 'Chrome, Edge and Firefox cache folders only (never cookies, history or passwords).'],
    ['thumbnail-cache', 'Thumbnail cache', 'SAFE', 0.8 * GB, 14, 'Windows rebuilds thumbnails when you open a folder.'],
    ['crash-reports', 'Crash reports and error logs', 'SAFE', 1.1 * GB, 903, 'Old diagnostic reports.'],
    ['recent-temp', 'Other temporary files', 'REVIEW', 2.0 * GB, 3120, ''],
    ['recycle-bin', 'Recycle Bin', 'REVIEW', 3.7 * GB, 188, ''],
  ].map(([id, title, cls, bytes, files, note]) => ({ id, title, class: cls, bytesFound: Math.round(bytes), filesFound: files, recentBytes: id === 'recent-temp' ? Math.round(bytes) : 0, recentFiles: 0, note }));

  const apps = [['Microsoft Office 365', '16.0.17928', 'Microsoft', 'msi', 'o365'], ['Google Chrome', '129.0.6668', 'Google LLC', 'msi', 'chrome'], ['Mozilla Firefox', '131.0', 'Mozilla', 'msi', 'ff'], ['7-Zip', '24.08', 'Igor Pavlov', 'exe', '7z'], ['VLC media player', '3.0.21', 'VideoLAN', 'msi', 'vlc'], ['Zoom', '6.2.5', 'Zoom', 'msi', 'zoom'], ['Calculator', '11.2407', 'Microsoft', 'appx', 'calc']].map(([name, version, publisher, kind, id]) => ({ name, version, publisher, kind, id }));

  const data = {
    env: { admin: false, user: 'staff', machine: 'LAB-PC-02', version: '0.1.11' },
    sys: { cpu: 'AMD Ryzen 5 5600 6-Core Processor', cores: 6, ramGb: 15.9, os: 'Windows 11 Pro', uptimeSeconds: 19400, manufacturer: 'HP', model: 'HP 290 G4 Microtower PC' },
    self: { available: !!view, view },
    live: () => ({ cpuPercent: 8 + Math.round(Math.random() * 10), ramPercent: 52, diskFreeBytes: 31.4 * GB, diskTotalBytes: 223.6 * GB, onBattery: false }),
    disk: { drive: 'C:', freeBytes: 31.4 * GB, totalBytes: 223.6 * GB },
    'space.preview': space,
    'startup.list': startup,
    'memory.now': { usedPercent: 52, commitPercent: 61, totalGb: 15.9, top: [
      { name: 'Memory Compression', privateMb: 1536, workingSetMb: 1536, category: 'SYSTEM_CRITICAL' }, { name: 'chrome', privateMb: 1210, workingSetMb: 980, category: 'NEVER_AUTOCLOSE' },
      { name: 'devenv', privateMb: 1100, workingSetMb: 760, category: 'NEVER_AUTOCLOSE' }, { name: 'teams', privateMb: 880, workingSetMb: 340, category: 'x' }, { name: 'firefox', privateMb: 640, workingSetMb: 410, category: 'x' },
    ] },
    'apps.inventory': { admin: false, totalBytes: 41.3 * GB, apps: [
      { id: 'a1', hive: 'HKLM', name: 'Adobe Photoshop 2025', version: '26.1', publisher: 'Adobe', kind: 'other', sizeBytes: 6.8 * GB, hidden: false },
      { id: 'a2', hive: 'HKLM32', name: 'Microsoft Office 365', version: '16.0', publisher: 'Microsoft Corporation', kind: 'other', sizeBytes: 4.9 * GB, hidden: false },
      { id: 'a3', hive: 'HKCU', name: 'Steam', version: '3.4', publisher: 'Valve', kind: 'other', sizeBytes: 3.1 * GB, hidden: false },
      { id: 'a4', hive: 'HKLM', name: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', version: '14.38', publisher: 'Microsoft Corporation', kind: 'msi', sizeBytes: 0.02 * GB, hidden: false, protectedReason: 'other programs and Windows rely on this Microsoft component' },
      { id: 'a5', hive: 'HKLM', name: 'Zoom Workplace', version: '6.2', publisher: 'Zoom', kind: 'msi', sizeBytes: 410 * MB, hidden: false },
      { id: 'a6', hive: 'HKLM', name: 'OldVendor Printer Tools', version: '2.0', publisher: 'OldVendor', kind: 'other', sizeBytes: 220 * MB, hidden: false },
      { id: 'a7', hive: 'HKLM', name: 'Intel(R) Management Engine Components', version: '2312', publisher: 'Intel', kind: 'other', sizeBytes: 90 * MB, hidden: true, hiddenReason: 'Marked as a system component' },
      { id: 'Microsoft.MicrosoftSolitaireCollection', hive: '', name: 'Microsoft Solitaire Collection', version: '4.20', publisher: 'Microsoft Corporation', kind: 'appx', sizeBytes: null, hidden: false },
    ] },
    'apps.uninstall': { verified: true, applied: true, needed: true, summary: 'Repaired and verified', rebootRequired: false, needsAdmin: false, canForce: false, undoable: false },
    'account.status': { signedIn: false, email: null, plan: null, planName: null, active: false, validUntil: null, features: ['scan.full', 'clean.space', 'startup.manage', 'memory.trim', 'apps.list', 'updates.view'], managed: false, stale: false,
      free: ['scan.full', 'clean.space', 'startup.manage', 'memory.trim', 'apps.list', 'updates.view'],
      titles: { 'scan.full': 'Full scan: what is wrong with this PC', 'clean.space': 'Free up space', 'startup.manage': 'Start-up programs', 'memory.trim': 'Memory', 'apps.list': 'Installed programs with sizes, normal uninstall', 'updates.view': 'Windows and program updates',
        'diagnose.cause': 'Why it is slow or crashing: the actual cause', 'repair.programs': 'Repair broken programs, printers and Windows pieces', 'uninstall.forced': 'Remove stubborn and hidden programs, with undo', 'fix.verified': 'Fixes that are re-checked, with before and after and undo', 'health.warnings': 'Early warning for failing drives and batteries', 'advice.replace': 'Repair, upgrade or replace advice with a price', 'backup.check': 'Backup check', 'maintenance.scheduled': 'Scheduled fixes and a weekly report', 'history.machine': 'Machine history', 'move.cloud': 'Viro Move: your apps, files and settings on your next PC', 'help.technician': 'Ask a technician' } },
    'account.manage': { opened: true },
    'fix.all': { before: { freeBytes: 29.3 * GB, memoryPercent: 71, startupItems: 14 }, after: { freeBytes: 41.1 * GB, memoryPercent: 52, startupItems: 8 }, steps: [
      { recipe: 'cleanup.safe', title: 'Clear temporary files and caches', needed: true, applied: true, verified: true, summary: 'Cleared 11.8 GB; Windows reports 11.8 GB more free space', undoId: null },
      { recipe: 'memory.trim-idle', title: 'Give back idle memory', needed: true, applied: true, verified: true, summary: 'Memory in use fell from 71% to 52%. Nothing was closed.', undoId: null },
      { recipe: 'startup.optimize', title: 'Turn off start-up programs that only slow you down', needed: true, applied: true, verified: true, summary: 'Turned off 6 start-up programs; each is still available when you open it', undoId: 'f1d2c3b4-0000-4000-8000-000000000001' } ] },
    'apps.list': { apps, crashes: [{ exe: 'WINWORD.EXE', crashes: 2, hangs: 1, at: ago(600), app: 'Microsoft Office 365' }] },
    'slow.analyze': { readable: true, boots: [{ seconds: 48 }, { seconds: 62 }, { seconds: 55 }], shutdowns: [{ seconds: 14 }, { seconds: 9 }], raised: [{ name: 'WaitToKillServiceTimeout', why: 'Waits longer than normal for services', current: 20000, normal: 5000 }], startupCulprits: [{ name: 'OneDrive', seconds: 11, times: 4 }, { name: 'Teams', seconds: 9, times: 3 }], slowServices: [{ name: 'Windows Search', seconds: 6, times: 2 }], shutdownCulprits: [{ name: 'Adobe Updater', seconds: 5, times: 2 }], pageFileWipe: false },
    'stability.analyze': { blueScreens: 0, lastBlueScreen: null, restarts: 1, freezes: 3, shellCrashes: 0, causes: [{ title: 'Microsoft Word keeps stopping', detail: 'Windows recorded 2 crashes and 1 freeze of WINWORD.EXE this week. A damaged add-in or program file is the usual cause.', confidence: 'medium', recipe: 'office.quick-repair', recipeLabel: 'Repair Office' }], codes: [], hung: [] },
    'updates.apps': { available: true, items: [{ id: 'chrome', name: 'Google Chrome', version: '129.0.6668', available: '130.0.6723' }, { id: 'zoom', name: 'Zoom', version: '6.2.5', available: '6.2.11' }, { id: '7z', name: '7-Zip', version: '24.08', available: '24.09' }] },
    history: [{ id: 'h1', title: 'Cleared 2.1 GB of caches', summary: 'Freed 2.1 GB', at: ago(95) }, { id: 'h2', title: 'Stopped 3 programs starting with Windows', summary: 'Start-up programs', at: ago(1500) }],
  };

  const listeners = [];
  if (SCENARIO === 'free') data['slow.analyze'] = { locked: true, feature: 'diagnose.cause', title: 'Why it is slow or crashing: the actual cause' };
  window.chrome = { webview: {
    addEventListener: (t, f) => { if (t === 'message') listeners.push(f); },
    postMessage: raw => {
      const m = JSON.parse(raw); let out = data[m.cmd];
      if (typeof out === 'function') out = out(m.args);
      const reply = out === undefined ? { id: m.id, ok: false, error: 'Not part of the preview: ' + m.cmd } : { id: m.id, ok: true, data: JSON.parse(JSON.stringify(out)) };
      setTimeout(() => listeners.forEach(f => f({ data: JSON.stringify(reply) })), 60);
    },
  } };
})();
