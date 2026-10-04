/** Mirrors what the agent can do. The server refuses to issue anything that is not in these tables. */
export type Risk = 'safe' | 'review';

export const CLEAN_CATEGORIES = {
  'windows-temp': { title: 'Windows temporary files', class: 'SAFE' },
  'user-temp': { title: 'User temporary files', class: 'SAFE' },
  'recent-temp': { title: 'Recent temporary files (not in use, older than an hour)', class: 'REVIEW' },
  'crash-dumps': { title: 'Crash dumps and error reports', class: 'SAFE' },
  'update-leftovers': { title: 'Windows Update download cache', class: 'SAFE' },
  'browser-cache': { title: 'Browser caches', class: 'SAFE' },
  'thumbnail-cache': { title: 'Thumbnail cache', class: 'SAFE' },
  'old-logs': { title: 'Old Windows logs', class: 'SAFE' },
  'recycle-bin': { title: 'Recycle Bin', class: 'REVIEW' },
  'windows-old': { title: 'Previous Windows installation', class: 'REVIEW' },
} as const;
export type CleanId = keyof typeof CLEAN_CATEGORIES;
export const CLEAN_IDS = Object.keys(CLEAN_CATEGORIES) as [CleanId, ...CleanId[]];
export const SAFE_CLEAN_IDS = CLEAN_IDS.filter(i => CLEAN_CATEGORIES[i].class === 'SAFE');
export const REVIEW_CLEAN_IDS = CLEAN_IDS.filter(i => CLEAN_CATEGORIES[i].class === 'REVIEW');
/** Personal data is not a category at all: there is no way to request its deletion. */
export const PERSONAL_NEVER_TOUCHED = ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'];

export const REPAIR_RECIPES = {
  'services.restart-failed': { title: 'Restart failed automatic services', risk: 'safe', timeoutSeconds: 600 },
  'cleanup.safe': { title: 'Clean safe temporary files and caches', risk: 'safe', timeoutSeconds: 1800 },
  'printer.spooler': { title: 'Repair the print spooler (clears stuck print jobs)', risk: 'review', timeoutSeconds: 300 },
  'dns.flush': { title: 'Flush the DNS resolver cache', risk: 'safe', timeoutSeconds: 300 },
  'network.reset': { title: 'Reset the network stack (needs a restart)', risk: 'review', timeoutSeconds: 300 },
  'windows.update-reset': { title: 'Reset Windows Update components', risk: 'review', timeoutSeconds: 900 },
  'windows.sfc': { title: 'System File Checker (sfc /scannow)', risk: 'safe', timeoutSeconds: 3600 },
  'windows.dism': { title: 'Repair the Windows component store (DISM)', risk: 'safe', timeoutSeconds: 3600 },
  'startup.disable': { title: 'Disable selected startup programs', risk: 'review', timeoutSeconds: 300 },
  'office.quick-repair': { title: 'Repair Microsoft 365 / Office (Quick Repair)', risk: 'safe', timeoutSeconds: 3000 },
  'protect.ransomware-audit': { title: 'Ransomware shield: watch protected folders (audit mode, blocks nothing)', risk: 'safe', timeoutSeconds: 300 },
  'protect.ransomware-block': { title: 'Ransomware shield: block untrusted programs from changing protected folders', risk: 'review', timeoutSeconds: 300 },
  'protect.asr-ransomware': { title: 'Ransomware shield: advanced cloud protection against ransomware', risk: 'safe', timeoutSeconds: 300 },
  'protect.pua': { title: 'Block potentially unwanted applications', risk: 'safe', timeoutSeconds: 300 },
  'protect.network-protection': { title: 'Block connections to known malicious sites (Network Protection)', risk: 'review', timeoutSeconds: 300 },
  'protect.firewall': { title: 'Turn Windows Firewall on for every network profile', risk: 'safe', timeoutSeconds: 300 },
  'protect.smb1-off': { title: 'Turn off the obsolete SMBv1 file-sharing protocol', risk: 'safe', timeoutSeconds: 300 },
  'protect.rdp-nla': { title: 'Require Network Level Authentication for Remote Desktop', risk: 'review', timeoutSeconds: 300 },
  'protect.llmnr-off': { title: 'Turn off LLMNR name resolution (used in credential-capture attacks)', risk: 'safe', timeoutSeconds: 300 },
  'protect.ps-logging': { title: 'Record PowerShell script activity in the event log', risk: 'safe', timeoutSeconds: 300 },
  'privacy.telemetry-minimum': { title: 'Limit Windows diagnostic data to the required minimum', risk: 'safe', timeoutSeconds: 300 },
  'privacy.advertising-id': { title: 'Turn off the advertising ID used to track people across apps', risk: 'safe', timeoutSeconds: 300 },
  'privacy.activity-history': { title: 'Stop collecting and uploading activity history', risk: 'safe', timeoutSeconds: 300 },
  'privacy.consumer-features': { title: 'Turn off tailored ads, suggestions and consumer content', risk: 'safe', timeoutSeconds: 300 },
  'privacy.location-off': { title: 'Turn off location services for this PC', risk: 'review', timeoutSeconds: 300 },
  'security.restore-proxy': { title: 'Remove an unexpected web proxy setting', risk: 'review', timeoutSeconds: 300 },
  'security.restore-dns': { title: 'Return DNS to automatic on adapters with unexpected fixed servers', risk: 'review', timeoutSeconds: 300 },
  'security.restore-hosts': { title: 'Remove hosts-file entries that redirect or block update and security addresses', risk: 'review', timeoutSeconds: 300 },
  'security.restore-defender-policy': { title: 'Remove a policy that turns Microsoft Defender protection off', risk: 'review', timeoutSeconds: 300 },
  'security.remove-persistence': { title: 'Remove startup entries and scheduled tasks that launch a detected threat', risk: 'review', timeoutSeconds: 300 },
  'memory.trim-idle': { title: 'Free memory held by idle programs (nothing is closed)', risk: 'safe', timeoutSeconds: 300 },
  'startup.optimize': { title: 'Speed up start-up: stop launchers and updaters from starting with Windows', risk: 'safe', timeoutSeconds: 300 },
  'privacy.block-extension': { title: 'Block a browser extension that takes over search or the home page', risk: 'review', timeoutSeconds: 300 },
  'startup.enable': { title: 'Let selected start-up programs start with Windows again', risk: 'review', timeoutSeconds: 300 },
  'shutdown.speed': { title: 'Speed up shut-down: restore the normal waiting times Windows uses', risk: 'safe', timeoutSeconds: 300 },
  'boot.delay-services': { title: 'Speed up start-up: start slow background services after sign-in', risk: 'safe', timeoutSeconds: 300 },
  'app.uninstall': { title: 'Uninstall a program', risk: 'review', timeoutSeconds: 1500 },
  'app.repair': { title: 'Repair a program (restore its damaged or missing files)', risk: 'review', timeoutSeconds: 2100 },
  'apps.end-hung': { title: 'Close programs that have stopped responding', risk: 'review', timeoutSeconds: 120 },
  'shell.repair': { title: 'Repair the Windows desktop (Start menu, search, icons)', risk: 'review', timeoutSeconds: 600 },
  'windows.memory-test': { title: 'Test the memory (RAM) at the next restart', risk: 'review', timeoutSeconds: 120 },
  'power.fast-startup-off': { title: 'Turn off Fast Startup (cleaner restarts, fewer freezes)', risk: 'review', timeoutSeconds: 120 },
  'app.update': { title: 'Update a program to its newest version', risk: 'review', timeoutSeconds: 2100 },
  'power.wol-enable': { title: 'Allow this PC to be woken from the console (Wake-on-LAN)', risk: 'review', timeoutSeconds: 180 },
  'printer.repair': { title: 'Repair printing (clear stuck jobs, restart the spooler, fix or update the printer driver)', risk: 'review', timeoutSeconds: 1500 },
  'disk.check': { title: 'Online disk check (chkdsk /scan)', risk: 'safe', timeoutSeconds: 2700 },
} as const satisfies Record<string, { title: string; risk: Risk; timeoutSeconds: number }>;
export type RecipeId = keyof typeof REPAIR_RECIPES;
export const RECIPE_IDS = Object.keys(REPAIR_RECIPES) as [RecipeId, ...RecipeId[]];

export interface Fix { jobType: string; params: Record<string, unknown>; label: string; confirm?: string }
