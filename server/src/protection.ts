import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { JobCtx } from './jobs.js';
import { createSystemJob } from './jobs.js';
import type { JobSigner } from './jobs.js';
import { REPAIR_RECIPES, type RecipeId } from './catalog.js';

/**
 * Protection and privacy controls. Every control is something Windows or Microsoft Defender already supports, applied by a normal verified,
 * reversible repair recipe. Viro reports a control as ON only when Windows itself reported it, and never claims more than it can see.
 * What this is not: antivirus, an intrusion-detection system or a web-tracker blocker. It switches on and monitors the protection that
 * Windows ships with, and limits what Windows itself collects about people.
 */
export type Group = 'ransomware' | 'attacks' | 'privacy';
export type State = 'on' | 'off' | 'unknown' | 'na';

interface Sec {
  hijackingExtensions?: { browser: string; id: string; reason: string }[] | null; engineIsDefender?: boolean; controlledFolderAccess?: 'on' | 'off' | 'audit' | null; rdp?: { enabled: boolean | null; networkLevelAuth?: boolean | null } | null;
  hardening?: { pua?: string | null; networkProtection?: string | null; asrRansomware?: string | null; smb1Enabled?: boolean | null; llmnrDisabled?: boolean; scriptBlockLogging?: boolean;
    telemetryLevel?: number | null; advertisingIdDisabled?: boolean; activityHistoryDisabled?: boolean; consumerContentDisabled?: boolean; locationDisabled?: boolean; restorePoints?: number | null } | null;
}
export interface Facts { security?: Sec | null; firewall?: { domain?: boolean | null; private?: boolean | null; public?: boolean | null } | null }

export interface Control { id: string; group: Group; title: string; why: string; recipe: RecipeId | null; state: (f: Facts) => State }
/** Stronger or preference controls an administrator chooses deliberately. They are listed, but being off is not a deficiency and does not lower the score. */
const OPTIONAL = new Set(['ransomware-block', 'network-protection', 'location']);

const modeOn = (m: string | null | undefined): State => m === 'on' || m === 'audit' ? 'on' : m === 'off' ? 'off' : 'unknown';
const defenderOnly = (f: Facts, s: State): State => (f.security?.engineIsDefender === false ? 'na' : f.security ? s : 'unknown');
const flag = (f: Facts, pick: (h: NonNullable<Sec['hardening']>) => boolean | undefined): State => { const h = f.security?.hardening; if (!h) return 'unknown'; const v = pick(h); return v === undefined ? 'unknown' : v ? 'on' : 'off'; };

export const CONTROLS: Control[] = [
  { id: 'ransomware-shield', group: 'ransomware', title: 'Protected folders are watched for ransomware', recipe: 'protect.ransomware-audit', why: 'Defender Controlled Folder Access, in audit mode first so nothing legitimate is blocked.', state: f => defenderOnly(f, modeOn(f.security?.controlledFolderAccess)) },
  { id: 'ransomware-block', group: 'ransomware', title: 'Untrusted programs are blocked from changing protected folders', recipe: 'protect.ransomware-block', why: 'Blocking mode. Can stop unfamiliar but legitimate programs from saving into Documents, so it needs an administrator to approve.', state: f => defenderOnly(f, f.security?.controlledFolderAccess == null ? 'unknown' : f.security.controlledFolderAccess === 'on' ? 'on' : 'off') },
  { id: 'asr-ransomware', group: 'ransomware', title: 'Advanced cloud protection against ransomware', recipe: 'protect.asr-ransomware', why: 'Defender attack-surface rule that blocks executables that look like ransomware.', state: f => defenderOnly(f, modeOn(f.security?.hardening?.asrRansomware)) },
  { id: 'restore-points', group: 'ransomware', title: 'Windows can restore earlier versions of files', recipe: null, why: 'A recent restore point or shadow copy is what lets a PC recover without paying anyone. Reported only; Viro does not create backups yet.', state: f => { const n = f.security?.hardening?.restorePoints; return n == null ? 'unknown' : n > 0 ? 'on' : 'off'; } },
  { id: 'browser-hijack', group: 'privacy', title: 'No browser extension is taking over search or the home page', recipe: 'privacy.block-extension', why: 'Extensions that change your search engine or home page are how browser hijackers track and monetise searches. Needs approval because the extension is blocked in Chrome and Edge.', state: f => { const x = f.security?.hijackingExtensions; return x == null ? 'unknown' : x.length ? 'off' : 'on'; } },
  { id: 'pua', group: 'attacks', title: 'Potentially unwanted applications are blocked', recipe: 'protect.pua', why: 'Stops bundled adware, rogue "optimizers" and similar software.', state: f => defenderOnly(f, modeOn(f.security?.hardening?.pua)) },
  { id: 'network-protection', group: 'attacks', title: 'Connections to known malicious sites are blocked', recipe: 'protect.network-protection', why: 'Defender Network Protection. Administrator approval required because it can block sites people rely on.', state: f => defenderOnly(f, modeOn(f.security?.hardening?.networkProtection)) },
  { id: 'firewall', group: 'attacks', title: 'Windows Firewall is on for every network profile', recipe: 'protect.firewall', why: 'Blocks unsolicited inbound connections, including the ones worms and remote-access attacks rely on.', state: f => { const w = f.firewall; if (!w) return 'unknown'; const v = [w.domain, w.private, w.public]; return v.some(x => x === false) ? 'off' : v.every(x => x === true) ? 'on' : 'unknown'; } },
  { id: 'smb1', group: 'attacks', title: 'The obsolete SMBv1 protocol is off', recipe: 'protect.smb1-off', why: 'SMBv1 was used by WannaCry and NotPetya to spread between computers.', state: f => { const v = f.security?.hardening; if (!v) return 'unknown'; return v.smb1Enabled == null ? 'on' : v.smb1Enabled ? 'off' : 'on'; } },
  { id: 'rdp-nla', group: 'attacks', title: 'Remote Desktop requires Network Level Authentication', recipe: 'protect.rdp-nla', why: 'Only matters where Remote Desktop is switched on. Requires approval because very old clients cannot connect without it.', state: f => { const r = f.security?.rdp; if (!r || r.enabled == null) return 'unknown'; if (!r.enabled) return 'na'; return r.networkLevelAuth === true ? 'on' : r.networkLevelAuth === false ? 'off' : 'unknown'; } },
  { id: 'llmnr', group: 'attacks', title: 'LLMNR name resolution is off', recipe: 'protect.llmnr-off', why: 'LLMNR lets an attacker on the same network capture password hashes.', state: f => flag(f, h => h.llmnrDisabled) },
  { id: 'ps-logging', group: 'attacks', title: 'PowerShell activity is recorded', recipe: 'protect.ps-logging', why: 'Most modern attacks run through PowerShell; logging gives an investigator something to read afterwards.', state: f => flag(f, h => h.scriptBlockLogging) },
  { id: 'telemetry', group: 'privacy', title: 'Windows diagnostic data is limited to the required minimum', recipe: 'privacy.telemetry-minimum', why: 'Reduces what Windows sends to Microsoft about how the PC is used.', state: f => flag(f, h => (h.telemetryLevel == null ? false : h.telemetryLevel <= 1)) },
  { id: 'advertising-id', group: 'privacy', title: 'The advertising ID is off', recipe: 'privacy.advertising-id', why: 'Stops apps tracking a person across apps with one identifier.', state: f => flag(f, h => h.advertisingIdDisabled) },
  { id: 'activity-history', group: 'privacy', title: 'Activity history is not collected or uploaded', recipe: 'privacy.activity-history', why: 'Windows otherwise records which apps, files and sites were used.', state: f => flag(f, h => h.activityHistoryDisabled) },
  { id: 'consumer-content', group: 'privacy', title: 'Tailored ads and consumer suggestions are off', recipe: 'privacy.consumer-features', why: 'Stops Windows using diagnostic data to personalise promotions.', state: f => flag(f, h => h.consumerContentDisabled) },
  { id: 'location', group: 'privacy', title: 'Location services are off', recipe: 'privacy.location-off', why: 'Approval required: it also disables Find My Device and location-based features people may want.', state: f => flag(f, h => h.locationDisabled) },
];

export function protectionOf(f: Facts) {
  const controls = CONTROLS.map(c => ({ id: c.id, group: c.group, state: c.state(f) }));
  const scored = controls.filter(c => !OPTIONAL.has(c.id));
  const on = scored.filter(c => c.state === 'on').length, off = scored.filter(c => c.state === 'off').length;
  return { controls, on, off, unknown: scored.filter(c => c.state === 'unknown').length, score: on + off ? Math.round((100 * on) / (on + off)) : null };
}

interface Deps { signer: JobSigner }

export function registerProtectionRoutes(app: FastifyInstance, c: JobCtx & Deps) {
  const { db } = c;
  const latest = async (org: string) => (await db.query(`SELECT d.id, d.hostname, h.snapshot FROM devices d JOIN device_health h ON h.device_id=d.id WHERE d.org_id=$1 AND d.revoked_at IS NULL ORDER BY d.hostname`, [org])).rows as { id: string; hostname: string; snapshot: Facts }[];

  app.get('/api/v1/protection/overview', { preHandler: c.requireRole('viewer') }, async req => {
    const rows = await latest(req.user.org);
    const per = rows.map(r => ({ deviceId: r.id, hostname: r.hostname, ...protectionOf(r.snapshot) }));
    const controls = CONTROLS.map(ctl => {
      const st = per.map(p => ({ p, s: p.controls.find(x => x.id === ctl.id)!.state }));
      return { id: ctl.id, group: ctl.group, title: ctl.title, why: ctl.why, recipe: ctl.recipe, risk: ctl.recipe ? REPAIR_RECIPES[ctl.recipe].risk : null, reportOnly: !ctl.recipe, optional: OPTIONAL.has(ctl.id),
        on: st.filter(x => x.s === 'on').length, off: st.filter(x => x.s === 'off').length, unknown: st.filter(x => x.s === 'unknown').length, notApplicable: st.filter(x => x.s === 'na').length,
        devicesOff: st.filter(x => x.s === 'off').slice(0, 25).map(x => ({ deviceId: x.p.deviceId, hostname: x.p.hostname })) };
    });
    const on = per.reduce((n, p) => n + p.on, 0), off = per.reduce((n, p) => n + p.off, 0);
    return { devices: per.length, score: on + off ? Math.round((100 * on) / (on + off)) : null, controls, weakest: per.filter(p => p.score != null).sort((a, b) => (a.score! - b.score!)).slice(0, 10).map(p => ({ deviceId: p.deviceId, hostname: p.hostname, score: p.score, off: p.off })),
      limits: 'Viro switches on and monitors the protection Windows and Microsoft Defender already provide, and limits what Windows collects about people. It is not an antivirus engine, an intrusion-detection system or a browser tracker blocker, and it does not create backups yet.' };
  });

  app.post('/api/v1/protection/apply', { preHandler: c.requireRole('admin') }, async (req, reply) => {
    const b = z.object({ control: z.enum(CONTROLS.map(x => x.id) as [string, ...string[]]), deviceIds: z.array(z.string().uuid()).max(500).optional(), approved: z.boolean().optional() }).strict().parse(req.body);
    const ctl = CONTROLS.find(x => x.id === b.control)!;
    if (!ctl.recipe) return reply.code(400).send({ error: 'this control is reported only; Viro does not change it' });
    const risk = REPAIR_RECIPES[ctl.recipe].risk;
    if (risk === 'review' && b.approved !== true) return reply.code(400).send({ error: `"${ctl.title}" can affect how people work; send approved:true to confirm` });
    const rows = await latest(req.user.org);
    const wanted = b.deviceIds ? rows.filter(r => b.deviceIds!.includes(r.id)) : rows.filter(r => ctl.state(r.snapshot) === 'off');
    let queued = 0; const skipped: { hostname: string; reason: string }[] = [];
    for (const r of wanted) {
      const st = ctl.state(r.snapshot);
      if (st === 'on') { skipped.push({ hostname: r.hostname, reason: 'already in place' }); continue; }
      if (st === 'na') { skipped.push({ hostname: r.hostname, reason: 'not applicable here (another product manages this)' }); continue; }
      const id = await createSystemJob(db, c.signer, { orgId: req.user.org, deviceId: r.id, type: 'repair.run', params: risk === 'review' ? { recipe: ctl.recipe, approved: true } : { recipe: ctl.recipe }, ttlMinutes: 24 * 60, source: { protection: ctl.id, by: req.user.sub } });
      if (id) queued++;
    }
    await c.audit({ orgId: req.user.org, actorType: 'user', actorId: req.user.sub, action: 'protection.apply', targetType: 'control', targetId: ctl.id, next: { recipe: ctl.recipe, queued, skipped: skipped.length } });
    return reply.code(202).send({ control: ctl.id, recipe: ctl.recipe, queued, skipped });
  });
}
