import type { Db } from './db.js';
import type { Deduction, HealthResult, Snapshot } from './health.js';
import { JOB_TYPES, createSystemJob, type JobSigner } from './jobs.js';
import { beforeBenchmark, compareBenchmarks, storeBenchmark } from './benchmarks.js';
import { storeUpgradeBenchmark, completeVerification } from './upgrade-store.js';
import { STABILITY_PREFIX, crashesSince, stabilityFindings, type HistoryPoint } from './stability.js';
import { preventiveFindings } from './preventive.js';
import { afterUpdateInstall } from './patching.js';

/**
 * Incident engine. One incident per device and finding, following the lifecycle
 *   detect -> evidence -> cause+confidence -> safe action -> repair -> verify the technical result -> verify the original symptom
 *   -> observe for recurrence -> resolve (or escalate).
 * An exit code never resolves anything: a finished repair job only moves an incident to VERIFYING; RESOLVED needs the symptom to be
 * gone in later health reports AND the observation window to pass. Everything here is built from recorded telemetry.
 */

export type IncidentStatus = 'DETECTED' | 'DIAGNOSING' | 'ROOT_CAUSE_SUSPECTED' | 'ROOT_CAUSE_CONFIRMED' | 'REPAIR_READY' | 'REPAIRING' | 'VERIFYING' | 'OBSERVING'
  | 'RESOLVED' | 'IMPROVED' | 'UNRESOLVED' | 'HARDWARE_ACTION_REQUIRED' | 'USER_ACTION_REQUIRED' | 'ADMIN_APPROVAL_REQUIRED';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

const REOPEN_DAYS = 14;
const EVIDENCE_EVERY_MS = 6 * 3600_000;

/** How long a repaired problem is observed before it counts as resolved (minutes). Overridable for tests through the incident row. */
export function observationMinutes(code: string): number {
  if (code === 'perf.service_failed') return 5;
  if (code.startsWith('stability.app:')) return 7 * 24 * 60;
  if (code.startsWith('updates.')) return 30;
  if (code.startsWith('drivers.')) return 48 * 60;
  if (code.startsWith('reliability.')) return 7 * 24 * 60;
  if (code.startsWith('storage.')) return 24 * 60;
  if (code.startsWith('security.')) return 60;
  return 24 * 60;
}

/** Findings that describe hardware limits: software cannot fix them, so the incident asks for a physical action. */
export const HARDWARE_CODES = /^(hardware\.|hw\.)/;

export function confidenceFor(d: Deduction, snap: Snapshot): Confidence {
  const c = d.code;
  if (/^(storage\.|security\.|updates\.|perf\.service_failed|perf\.startup_heavy|perf\.slow_boot|perf\.low_virtual_memory|perf\.memory_hog|perf\.firmware_throttle|reliability\.shutdown_failures|perf\.ram_idle_waste|hardware\.cooling|hardware\.low_ram|hardware\.hdd_system|drivers\.)/.test(c)) return 'HIGH';   // measured directly
  if (c === 'perf.throttling') return snap.perf && (snap.perf as any).cpuTempC != null ? 'HIGH' : 'LOW';                                           // no sensor: inferred from behaviour
  if (c === 'perf.ram_pressure' || c === 'perf.pagefile_pressure' || c === 'perf.cpu_saturation' || c === 'perf.disk_latency' || c === 'perf.disk_queue') return 'MEDIUM';
  if (c.startsWith('reliability.')) return 'MEDIUM';
  if (HARDWARE_CODES.test(c)) return 'MEDIUM';
  return 'MEDIUM';
}

export function safetyLevelOf(d: Deduction): number {
  if (d.remedy === 'hardware') return 4;
  if (d.remedy === 'manual') return 3;
  if (d.remedy === 'review') return 3;
  const f = d.fix; if (!f) return 0;
  if (f.jobType === 'repair.run') { const r = String((f.params as any)?.recipe ?? ''); return /^(windows\.sfc|windows\.dism|windows\.update-reset|network\.reset|office\.quick-repair)$/.test(r) ? 2 : 1; }
  return 1;
}

/** The incident status a finding starts in (and returns to when nothing is in progress). */
export function initialStatus(d: Deduction, conf: Confidence): IncidentStatus {
  if (d.remedy === 'hardware') return 'HARDWARE_ACTION_REQUIRED';
  if (d.remedy === 'manual') return 'USER_ACTION_REQUIRED';
  if (d.remedy === 'review') return 'ADMIN_APPROVAL_REQUIRED';
  if (d.fix) return conf === 'HIGH' || conf === 'MEDIUM' ? 'REPAIR_READY' : 'ROOT_CAUSE_SUSPECTED';
  return conf === 'HIGH' ? 'ROOT_CAUSE_CONFIRMED' : 'ROOT_CAUSE_SUSPECTED';
}

const TITLES: Record<string, string> = {
  'storage.system_low': 'System drive almost full', 'storage.data_low': 'Data drive almost full', 'perf.ram_pressure': 'Memory under pressure', 'perf.pagefile_pressure': 'Heavy paging',
  'perf.startup_heavy': 'Too many programs start with Windows', 'perf.low_virtual_memory': 'Windows ran out of memory', 'perf.memory_hog': 'One program is holding a lot of memory', 'security.multiple_engines': 'Several security products are running', 'reliability.shutdown_failures': 'Windows failed to shut down or restart', 'perf.firmware_throttle': 'The processor is being slowed by firmware', 'perf.slow_boot': 'Windows starts slowly', 'perf.ram_idle_waste': 'Idle programs are holding memory', 'hardware.cooling': 'Cooling problem suspected', 'perf.service_failed': 'A Windows service has stopped', 'perf.cpu_saturation': 'Processor constantly busy', 'perf.disk_latency': 'Slow disk responses',
  'perf.disk_queue': 'Disk overloaded', 'perf.throttling': 'Processor slowed down', 'perf.browser_heavy': 'Browser using a lot of memory', 'updates.critical_pending': 'Security updates waiting',
  'updates.many_pending': 'Many updates waiting', 'updates.search_stuck': 'Windows Update is stuck', 'updates.stale': 'Windows has not updated in a long time', 'updates.reboot_required': 'A restart is needed',
  'drivers.device_error': 'A device driver has errors', 'reliability.app_unstable': 'An application keeps crashing', 'reliability.unexpected_shutdown': 'Unexpected shutdowns',
  'security.av_off': 'Antivirus is off', 'security.rtp_off': 'Real-time protection is off', 'security.firewall_off': 'Firewall is off', 'security.ransomware_shield_off': 'Ransomware protection is off', 'security.asr_ransomware_off': 'Advanced ransomware rule is off', 'security.pua_off': 'Unwanted-app blocking is off', 'security.smb1_on': 'Obsolete SMBv1 protocol is on', 'security.no_restore_points': 'No restore point to recover files from', 'security.signatures_old': 'Virus definitions are out of date',
  'security.active_threat': 'Active threat detected', 'hardware.low_ram': 'Not enough memory for this workload', 'preventive.storage_filling': 'System drive is filling up', 'preventive.health_declining': 'Condition is getting worse', 'preventive.boot_slower': 'Start-up has become slower', 'hardware.hdd_system': 'Windows runs from a mechanical hard disk',
};
export const titleOf = (d: Deduction) => TITLES[d.code] ?? (d.code.startsWith('stability.app:') ? `${d.code.slice(14).replace(/\.exe$/, '').replace(/^./, c => c.toUpperCase())} keeps crashing` : undefined) ?? (d.code.startsWith('hw.') ? 'Hardware fault detected' : d.reason.split('.')[0].slice(0, 90));

/** Measurements that go into before/after comparisons. Only values the agent actually reported. */
export function metricsOf(snap: Snapshot, h: HealthResult): Record<string, number | null> {
  const sys = snap.volumes?.find(v => v.isSystem);
  return {
    healthOverall: h.overall,
    systemFreeBytes: sys ? sys.freeBytes : null,
    systemFreePercent: sys && sys.totalBytes ? Math.round(sys.freeBytes / sys.totalBytes * 1000) / 10 : null,
    ramPercent: (snap.perf as any)?.ramPercent ?? null,
    cpuAvgPercent: (snap.perf as any)?.cpuAvgPercent ?? null,
    startupCount: snap.startup ? snap.startup.length : null,
    bootSeconds: snap.boot?.lastBootSeconds ?? null,
    idleMemoryMb: snap.care?.memory?.idleTrimmableMb ?? null,
    failedServices: snap.failedServices ? snap.failedServices.length : null,
    pendingUpdates: snap.updates ? snap.updates.pendingCount : null,
    crashes7d: snap.crashes ? snap.crashes.reduce((n, c) => n + c.count, 0) : null,
    driverErrors: snap.driverErrors ? snap.driverErrors.length : null,
    unexpectedShutdowns7d: (snap.unexpectedShutdowns7d as number | null | undefined) ?? null,
  };
}

/** The raw measurements behind a finding, kept as evidence. */
export function evidenceFor(d: Deduction, snap: Snapshot): { type: 'TELEMETRY' | 'EVENT_LOG' | 'INVENTORY' | 'HARDWARE'; source: string; value: Record<string, unknown>; note?: string }[] {
  const out: { type: 'TELEMETRY' | 'EVENT_LOG' | 'INVENTORY' | 'HARDWARE'; source: string; value: Record<string, unknown>; note?: string }[] = [];
  const sys = snap.volumes?.find(v => v.isSystem);
  if (d.code.startsWith('storage.') && sys) out.push({ type: 'TELEMETRY', source: 'Volume free space', value: { volume: sys.name, freeBytes: sys.freeBytes, totalBytes: sys.totalBytes } });
  if (d.code.startsWith('perf.ram') || d.code === 'perf.pagefile_pressure') out.push({ type: 'TELEMETRY', source: 'Performance counters', value: { ramPercent: (snap.perf as any)?.ramPercent ?? null, commitPercent: (snap.perf as any)?.commitPercent ?? null, availableBytes: snap.memory?.availableBytes ?? null } });
  if (d.code === 'perf.cpu_saturation' || d.code === 'perf.throttling') out.push({ type: 'TELEMETRY', source: 'Performance counters', value: { cpuAvgPercent: (snap.perf as any)?.cpuAvgPercent ?? null, cpuFrequencyPercent: (snap.perf as any)?.cpuFrequencyPercent ?? null } });
  if (d.code.startsWith('perf.disk')) out.push({ type: 'TELEMETRY', source: 'Disk performance counters', value: { latencyMs: (snap.perf as any)?.diskLatencyMs ?? null, queue: (snap.perf as any)?.diskQueue ?? null } });
  if (d.code === 'perf.slow_boot') out.push({ type: 'EVENT_LOG', source: 'Windows Diagnostics-Performance', value: { lastBootSeconds: snap.boot?.lastBootSeconds ?? null, mainPathSeconds: snap.boot?.mainPathSeconds ?? null, slowest: (snap.boot?.degrading ?? []).slice(0, 5) } });
  if (d.code === 'perf.ram_idle_waste') out.push({ type: 'TELEMETRY', source: 'Memory guard', value: { usedPercent: snap.care?.memory?.usedPercent ?? null, targetPercent: snap.care?.memory?.targetPercent ?? null, idleTrimmableMb: snap.care?.memory?.idleTrimmableMb ?? null } });
  if (d.code === 'perf.low_virtual_memory' || d.code === 'perf.memory_hog') out.push({ type: 'TELEMETRY', source: 'Windows memory records', value: { commitPercent: snap.resources?.commitPercent ?? null, topCommit: (snap.resources?.topCommit ?? []).slice(0, 4), lowVirtualMemory24h: (snap.resources?.lowVirtualMemory24h ?? []).slice(0, 3) } });
  if (d.code === 'reliability.shutdown_failures' || d.code === 'perf.firmware_throttle') out.push({ type: 'EVENT_LOG', source: 'Windows System log', value: { failedShutdowns7d: snap.resources?.failedShutdowns7d ?? null, firmwareThrottle24h: snap.resources?.firmwareThrottle24h ?? null } });
  if (d.code === 'security.multiple_engines') out.push({ type: 'INVENTORY', source: 'Running security products', value: { engines: snap.resources?.securityEngines ?? [] } });
  if (d.code === 'hardware.cooling') out.push({ type: 'HARDWARE', source: 'Thermal monitor', value: snap.care?.thermal ?? {} });
  if (d.code === 'perf.startup_heavy') out.push({ type: 'INVENTORY', source: 'Startup entries', value: { count: snap.startup?.length ?? 0, examples: (snap.startup ?? []).slice(0, 8).map(s => s.name) } });
  if (d.code === 'perf.service_failed') out.push({ type: 'EVENT_LOG', source: 'Service Control Manager', value: { services: (snap.failedServices ?? []).map(s => ({ name: s.name, exitCode: s.exitCode ?? null })) } });
  if (d.code.startsWith('updates.')) out.push({ type: 'TELEMETRY', source: 'Windows Update Agent', value: { pending: snap.updates?.pendingCount ?? null, critical: snap.updates?.pendingCriticalCount ?? null, searchStuckMinutes: snap.updateSearchStuckMinutes ?? null, lastInstallDays: snap.updates?.lastInstallDays ?? null } });
  if (d.code.startsWith('drivers.')) out.push({ type: 'EVENT_LOG', source: 'Plug and Play', value: { errors: snap.driverErrors ?? [] } });
  if (d.code.startsWith('reliability.')) out.push({ type: 'EVENT_LOG', source: 'Windows Reliability history', value: { crashes: (snap.crashes ?? []).slice(0, 10), unexpectedShutdowns7d: snap.unexpectedShutdowns7d ?? null } });
  if (d.code.startsWith('security.')) out.push({ type: 'TELEMETRY', source: 'Windows Security', value: { defender: snap.defender ?? null, avProducts: snap.avProducts ?? [] } });
  if (HARDWARE_CODES.test(d.code)) out.push({ type: 'HARDWARE', source: 'Hardware diagnosis', value: { finding: d.reason } });
  return out;
}

const RELEVANT = (d: Deduction) => d.impact === 'high' || d.impact === 'medium';

/** True when a finding is materially smaller than when it was detected (used for IMPROVED versus UNRESOLVED). */
export const materiallyImproved = (pointsAtDetection: number, pointsNow: number) => pointsAtDetection > 0 && pointsNow <= pointsAtDetection * 0.7;

const addEvidence = (db: Db, incidentId: string, e: { type: string; source: string; value: unknown; note?: string }, at = new Date()) =>
  db.query(`INSERT INTO incident_evidence(incident_id,type,source,observed_at,value,note) VALUES ($1,$2,$3,$4,$5,$6)`, [incidentId, e.type, e.source, at, JSON.stringify(e.value), e.note ?? null]);

/**
 * Called with every fresh health assessment. Creates, updates, verifies, resolves and reopens incidents. Idempotent.
 */
export async function syncIncidents(db: Db, orgId: string, deviceId: string, snap: Snapshot, h: HealthResult, now = new Date()): Promise<void> {
  const current = new Map<string, Deduction>(h.deductions.filter(d => RELEVANT(d) && !(d.code === 'reliability.app_unstable' && snap.stability)).map(d => [d.code, d]));
  const metrics = metricsOf(snap, h);
  const open = (await db.query(`SELECT * FROM incidents WHERE device_id=$1 AND status <> 'RESOLVED'`, [deviceId])).rows;
  const byCode = new Map(open.map(r => [r.code as string, r]));
  for (const f of await preventiveFindings(db, deviceId, now)) current.set(f.code, f);
  // Stability: one finding per unstable application, judged on crashes after the last repair only.
  const confOverride = new Map<string, Confidence>();
  if (snap.stability?.crashes?.length) {
    const history: HistoryPoint[] = (await db.query(`SELECT at, metrics FROM device_health_history WHERE device_id=$1 AND at > $2 ORDER BY at`, [deviceId, new Date(now.getTime() - 15 * 86_400_000)])).rows.map(r => ({ at: new Date(r.at), metrics: r.metrics }));
    const prior = (await db.query(`SELECT DISTINCT ON (code) code, repaired_at, status FROM incidents WHERE device_id=$1 AND code LIKE 'stability.app:%' AND repaired_at IS NOT NULL ORDER BY code, first_detected DESC`, [deviceId])).rows;
    const since = new Map(prior.map(r => [r.code as string, { repairedAt: new Date(r.repaired_at), inObservation: r.status === 'VERIFYING' || r.status === 'OBSERVING' }]));
    for (const f of stabilityFindings(snap, history, since, now)) { current.set(f.deduction.code, f.deduction); confOverride.set(f.deduction.code, f.confidence); }
  }

  // 1) findings present now
  for (const [code, d] of current) {
    const conf = confOverride.get(code) ?? confidenceFor(d, snap);
    const ev = (d as any).evidence ?? evidenceFor(d, snap);
    const ex = byCode.get(code);
    if (!ex) {
      const recent = (await db.query(`SELECT * FROM incidents WHERE device_id=$1 AND code=$2 AND status='RESOLVED' AND resolved_at > $3 ORDER BY resolved_at DESC LIMIT 1`, [deviceId, code, new Date(now.getTime() - REOPEN_DAYS * 86_400_000)])).rows[0];
      if (recent) {           // recurrence: the same problem came back after it was resolved
        await db.query(`UPDATE incidents SET status=$2, recurrence_count=recurrence_count+1, resolved_at=NULL, resolution=NULL, last_detected=$3, points=$4, points_at_detection=$4, confidence=$5, root_cause=$6,
                          repaired_at=NULL, observation_until=NULL, before_metrics=$7, before_score=$8, after_metrics=NULL, after_score=NULL, verification=NULL WHERE id=$1`,
          [recent.id, initialStatus(d, conf), now, d.points, conf, d.reason, JSON.stringify({ ...metrics, ...((d as any).crashCount != null ? { crashesInWindow: (d as any).crashCount } : {}) }), h.overall]);
        await addEvidence(db, recent.id, { type: 'RECURRENCE', source: 'Health engine', value: { code, points: d.points, message: 'The problem came back after it was marked resolved.' } }, now);
        for (const e of ev) await addEvidence(db, recent.id, e, now);
        continue;
      }
      const ins = await db.query(
        `INSERT INTO incidents(org_id,device_id,code,category,impact,title,root_cause,confidence,status,remedy,safety_level,action_label,fix,recommendation,points,points_at_detection,first_detected,last_detected,before_metrics,before_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$16,$17,$18) RETURNING id`,
        [orgId, deviceId, code, d.category, d.impact, titleOf(d), d.reason, conf, initialStatus(d, conf), d.remedy, safetyLevelOf(d), d.fix?.label ?? null, d.fix ? JSON.stringify(d.fix) : null, d.recommendation, d.points, now, JSON.stringify({ ...metrics, ...((d as any).crashCount != null ? { crashesInWindow: (d as any).crashCount } : {}) }), h.overall]);
      for (const e of ev) await addEvidence(db, ins.rows[0].id, e, now);
      continue;
    }
    // existing, unresolved incident
    const st = ex.status as IncidentStatus;
    const upd: string[] = ['last_detected=$2', 'points=$3', 'root_cause=$4', 'confidence=$5', 'impact=$6', 'recommendation=$7'];
    const args: unknown[] = [ex.id, now, d.points, d.reason, conf, d.impact, d.recommendation];
    let next: IncidentStatus | null = null;
    if (st === 'VERIFYING' || st === 'OBSERVING') {
      // The repair finished but the symptom is still there: it did not work (or only partly).
      next = materiallyImproved(ex.points_at_detection, d.points) ? 'IMPROVED' : 'UNRESOLVED';
      if (st === 'OBSERVING') upd.push('recurrence_count=recurrence_count+1');
      await addEvidence(db, ex.id, { type: 'VERIFICATION', source: 'Health engine', value: { code, pointsBefore: ex.points_at_detection, pointsNow: d.points, result: next, symptomPresent: true } }, now);
      upd.push(`after_metrics=$${args.push(JSON.stringify({ ...metrics, ...((d as any).crashCount != null ? { crashesSinceRepair: (d as any).crashCount } : {}) }))}`, `after_score=$${args.push(h.overall)}`, `verification=$${args.push(JSON.stringify({ technical: 'repair ran', symptomGone: false, result: next }))}`);
    } else if (st === 'UNRESOLVED' || st === 'IMPROVED' || st === 'DETECTED' || st === 'ROOT_CAUSE_SUSPECTED' || st === 'ROOT_CAUSE_CONFIRMED' || st === 'REPAIR_READY') {
      // Nothing in progress: keep the status in line with what is known now. A failed repair escalates to a human instead of retrying forever.
      if (st === 'UNRESOLVED' || st === 'IMPROVED') next = d.fix && ex.recurrence_count < 2 && st === 'IMPROVED' ? st : 'ADMIN_APPROVAL_REQUIRED';
      else next = initialStatus(d, conf);
    }
    if (next && next !== st) upd.push(`status=$${args.push(next)}`);
    await db.query(`UPDATE incidents SET ${upd.join(', ')} WHERE id=$1`, args);
    const lastEv = (await db.query(`SELECT max(observed_at) t FROM incident_evidence WHERE incident_id=$1 AND type='TELEMETRY'`, [ex.id])).rows[0].t;
    if (!lastEv || now.getTime() - new Date(lastEv).getTime() > EVIDENCE_EVERY_MS) for (const e of ev) await addEvidence(db, ex.id, e, now);
  }

  // 2) findings that are gone
  for (const [code, ex] of byCode) {
    if (current.has(code)) continue;
    const st = ex.status as IncidentStatus;
    if (st === 'VERIFYING') {
      // Technical result and symptom both verified; now watch for recurrence for the observation window.
      const until = new Date(new Date(ex.repaired_at ?? now).getTime() + observationMinutes(code) * 60_000);
      const since = code.startsWith(STABILITY_PREFIX) ? { crashesSinceRepair: crashesSince(snap, code, new Date(ex.repaired_at ?? now)) } : {};
      await db.query(`UPDATE incidents SET status='OBSERVING', observation_until=$2, after_metrics=$3, after_score=$4, verification=$5, last_detected=last_detected WHERE id=$1`,
        [ex.id, until, JSON.stringify({ ...metrics, ...since }), h.overall, JSON.stringify({ technical: 'repair ran', symptomGone: true, observedUntil: until.toISOString(), ...since })]);
      await addEvidence(db, ex.id, { type: 'VERIFICATION', source: 'Health engine', value: { code, symptomGone: true, observationUntil: until.toISOString(), metrics } }, now);
    } else if (st === 'OBSERVING') {
      const until = ex.observation_until ? new Date(ex.observation_until) : now;
      if (now >= until) {
        const since = code.startsWith(STABILITY_PREFIX) ? { crashesSinceRepair: crashesSince(snap, code, new Date(ex.repaired_at ?? now)) } : {};
        const after = { ...metrics, ...since };
        await db.query(`UPDATE incidents SET status='RESOLVED', resolved_at=$2, resolution='viro-repair', after_metrics=$3, after_score=$4 WHERE id=$1`, [ex.id, now, JSON.stringify(after), h.overall]);
        await addEvidence(db, ex.id, { type: 'VERIFICATION', source: 'Health engine', value: { code, result: 'observation window passed without recurrence', metrics: after } }, now);
        await recordAutomaticService(db, ex, after, h.overall, now);
      }
    } else if (st !== 'REPAIRING') {
      // Cleared without a Viro repair (the user fixed it, or it was transient): close it, but say so.
      await db.query(`UPDATE incidents SET status='RESOLVED', resolved_at=$2, resolution='self-cleared', after_metrics=$3, after_score=$4 WHERE id=$1`, [ex.id, now, JSON.stringify(metrics), h.overall]);
      await addEvidence(db, ex.id, { type: 'VERIFICATION', source: 'Health engine', value: { code, result: 'the finding is no longer present; no Viro repair was involved' } }, now);
    }
  }
}

const SERVICE_TYPE_BY_CODE = (code: string) => code.startsWith('storage.') ? 'storage cleanup' : code.startsWith('drivers.') ? 'driver remediation' : code.startsWith('security.') ? 'security remediation' : 'major software repair';

async function recordAutomaticService(db: Db, inc: any, after: Record<string, unknown>, afterScore: number, now: Date) {
  if (inc.repaired_at == null) return;
  await db.query(
    `INSERT INTO service_events(org_id,device_id,occurred_at,source,service_type,reason,notes,evidence,incident_id) VALUES ($1,$2,$3,'AUTOMATIC',$4,$5,$6,$7,$8)`,
    [inc.org_id, inc.device_id, now, SERVICE_TYPE_BY_CODE(inc.code), inc.title, `Verified: ${inc.root_cause}`, JSON.stringify({ before: inc.before_metrics, after, scoreBefore: inc.before_score, scoreAfter: afterScore }), inc.id]);
}

/** Records that a job was started to repair an incident (by Autopilot or by a person) and marks it as being repaired. */
export async function attachRepairJob(db: Db, deviceId: string, code: string, jobId: string, by: 'autopilot' | 'user'): Promise<boolean> {
  const inc = (await db.query(`SELECT id, status FROM incidents WHERE device_id=$1 AND code=$2 AND status <> 'RESOLVED'`, [deviceId, code])).rows[0];
  if (!inc) return false;
  await db.query(`INSERT INTO incident_actions(incident_id,job_id,kind,by) VALUES ($1,$2,'repair',$3)`, [inc.id, jobId, by]);
  await db.query(`UPDATE incidents SET status='REPAIRING' WHERE id=$1`, [inc.id]);
  return true;
}

/**
 * A repair job finished. This does NOT resolve the incident: it moves it to VERIFYING and asks the device for a fresh health assessment
 * (and a benchmark when supported) so the symptom itself can be checked.
 */
export async function onJobFinished(db: Db, signer: JobSigner, orgId: string, deviceId: string, jobId: string, type: string, status: string, result: unknown): Promise<void> {
  const acts = (await db.query(`SELECT a.id, a.kind, a.incident_id, i.status inc_status FROM incident_actions a JOIN incidents i ON i.id=a.incident_id WHERE a.job_id=$1 AND a.finished_at IS NULL`, [jobId])).rows;
  if (type === 'benchmark.upgrade' && status === 'completed') {
    const purpose = ((await db.query('SELECT params FROM jobs WHERE id=$1', [jobId])).rows[0]?.params?.purpose ?? 'baseline') as 'baseline' | 'after' | 'periodic';
    const metrics = await storeUpgradeBenchmark(db, orgId, deviceId, jobId, result as any, purpose);
    if (metrics && purpose === 'after') await completeVerification(db, orgId, deviceId, jobId, metrics, (result as any)?.safety ?? null, (await db.query('SELECT data FROM device_anatomy WHERE device_id=$1', [deviceId])).rows[0]?.data ?? null);
  }
  if (type === 'benchmark.upgrade' && status === 'failed') await db.query(`UPDATE upgrade_verifications SET state='inconclusive', completed_at=now() WHERE job_id=$1 AND state='awaiting_measurement'`, [jobId]);
  if (type === 'benchmark.run' && status === 'completed') await storeBenchmark(db, orgId, deviceId, jobId, result, acts.find(a => a.kind === 'benchmark')?.incident_id ?? null);
  for (const a of acts) {
    await db.query(`UPDATE incident_actions SET finished_at=now(), outcome=$2 WHERE id=$1`, [a.id, status]);
    if (a.kind === 'repair') {
      if (status === 'completed' && (result as any)?.deferred) {
        await db.query(`UPDATE incidents SET status='REPAIR_READY' WHERE id=$1 AND status='REPAIRING'`, [a.incident_id]);
        await db.query(`UPDATE incident_actions SET outcome='deferred' WHERE id=$1`, [a.id]);
        await addEvidence(db, a.incident_id, { type: 'COMMAND_OUTPUT', source: `Job ${type}`, value: { deferred: true, reason: (result as any)?.report?.summary ?? 'deferred' }, note: 'The repair was postponed and nothing was changed. Viro will try again later.' });
        await db.query(`DELETE FROM policy_runs WHERE device_id=$1 AND schedule_key = 'auto:' || (SELECT code FROM incidents WHERE id=$2)`, [deviceId, a.incident_id]);   // lets Autopilot retry at the next report
      } else if (status === 'completed') {
        await db.query(`UPDATE incidents SET status='VERIFYING', repaired_at=now() WHERE id=$1 AND status='REPAIRING'`, [a.incident_id]);
        const rep = (result as any)?.report ?? result as any;
        if (rep?.rebootRequired) await afterUpdateInstall(db, signer, orgId, deviceId, { rebootRequired: true });   // restart per policy: countdown, ask, or never
        await addEvidence(db, a.incident_id, { type: 'COMMAND_OUTPUT', source: `Job ${type}`, value: { status, result: trimResult(result) }, note: 'The repair step ran. This alone does not prove the problem is fixed.' });
        const hc = await createSystemJob(db, signer, { orgId, deviceId, type: 'health.check', params: {}, ttlMinutes: 240, source: { incidentId: a.incident_id, purpose: 'verify repair' } });
        if (hc) await db.query(`INSERT INTO incident_actions(incident_id,job_id,kind,by) VALUES ($1,$2,'verify-health','autopilot')`, [a.incident_id, hc]);
        if (JOB_TYPES['benchmark.run']) {
          const bj = await createSystemJob(db, signer, { orgId, deviceId, type: 'benchmark.run', params: {}, ttlMinutes: 240, source: { incidentId: a.incident_id, purpose: 'after repair' } });
          if (bj) await db.query(`INSERT INTO incident_actions(incident_id,job_id,kind,by) VALUES ($1,$2,'benchmark','autopilot')`, [a.incident_id, bj]);
        }
      } else {
        await db.query(`UPDATE incidents SET status='UNRESOLVED' WHERE id=$1 AND status='REPAIRING'`, [a.incident_id]);
        await addEvidence(db, a.incident_id, { type: 'COMMAND_OUTPUT', source: `Job ${type}`, value: { status, result: trimResult(result) }, note: 'The repair did not complete.' });
      }
    }
  }
}

const trimResult = (r: unknown) => { const s = JSON.stringify(r ?? null); return s.length > 2000 ? { truncated: s.slice(0, 2000) } : r ?? null; };

/* ------------------------------------------------------------------------------------------------------------------------------
 * Read models
 * ---------------------------------------------------------------------------------------------------------------------------- */
export interface StoryIncident { id: string; code: string; title: string; status: IncidentStatus; impact: string; confidence: Confidence; rootCause: string; recommendation: string | null; canFix: boolean; hardwareAction: boolean }

const STATUS_RANK: Record<string, number> = { HARDWARE_ACTION_REQUIRED: 1, UNRESOLVED: 2, ADMIN_APPROVAL_REQUIRED: 3, USER_ACTION_REQUIRED: 4, REPAIR_READY: 5, ROOT_CAUSE_CONFIRMED: 6, ROOT_CAUSE_SUSPECTED: 7, DETECTED: 8, REPAIRING: 9, VERIFYING: 10, OBSERVING: 11, IMPROVED: 12 };
export const IMPACT_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export async function deviceStory(db: Db, orgId: string, deviceId: string) {
  const rows = (await db.query(`SELECT * FROM incidents WHERE org_id=$1 AND device_id=$2 AND status <> 'RESOLVED'`, [orgId, deviceId])).rows;
  rows.sort((a, b) => (IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact]) || (b.points - a.points));
  const top = rows[0];
  const fixable = rows.filter(r => r.status === 'REPAIR_READY');
  const hardware = rows.filter(r => r.status === 'HARDWARE_ACTION_REQUIRED');
  const hs = (await db.query(`SELECT overall FROM device_health_history WHERE device_id=$1 ORDER BY id DESC LIMIT 1`, [deviceId])).rows[0]?.overall ?? null;
  return {
    healthOverall: hs,
    status: !rows.length ? 'Healthy' : rows.some(r => r.impact === 'high') ? 'Needs attention' : 'Watch',
    biggestProblem: top ? { id: top.id, title: top.title, rootCause: top.root_cause, confidence: top.confidence, status: top.status } : null,
    virocanFix: !rows.length ? 'Nothing to fix' : fixable.length === rows.length ? 'Yes' : fixable.length ? 'Partially' : 'No',
    hardwareAction: hardware.map(r => ({ id: r.id, title: r.title, recommendation: r.recommendation })),
    activeCount: rows.length,
  };
}

/** Measured before/after for a repaired incident: the last benchmark taken before the repair versus the one taken after it. */
export async function incidentBenchmark(db: Db, r: any) {
  if (!r.repaired_at) return null;
  const before = await beforeBenchmark(db, r.device_id, new Date(r.repaired_at));
  const afterRow = (await db.query(`SELECT metrics, taken_at FROM benchmarks WHERE incident_id=$1 ORDER BY taken_at DESC LIMIT 1`, [r.id])).rows[0];
  if (!before || !afterRow) return { measured: false, reason: !before ? 'No benchmark existed before the repair.' : 'The after-repair benchmark has not arrived yet.' };
  return { ...compareBenchmarks(before, afterRow.metrics), before, after: afterRow.metrics, afterAt: afterRow.taken_at };
}

export const incidentRow = (r: any) => ({
  id: r.id, deviceId: r.device_id, code: r.code, category: r.category, impact: r.impact, title: r.title, status: r.status as IncidentStatus, rootCause: r.root_cause, confidence: r.confidence as Confidence,
  remedy: r.remedy, safetyLevel: r.safety_level, action: r.action_label, recommendation: r.recommendation, firstDetected: r.first_detected, lastDetected: r.last_detected, repairedAt: r.repaired_at,
  observationUntil: r.observation_until, resolvedAt: r.resolved_at, resolution: r.resolution, recurrenceCount: r.recurrence_count, beforeMetrics: r.before_metrics, afterMetrics: r.after_metrics,
  beforeScore: r.before_score, afterScore: r.after_score, verification: r.verification, canFix: r.status === 'REPAIR_READY' || r.status === 'ADMIN_APPROVAL_REQUIRED' && !!r.fix, hardwareAction: r.status === 'HARDWARE_ACTION_REQUIRED',
});

export { STATUS_RANK };
