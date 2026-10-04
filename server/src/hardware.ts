/**
 * Hardware analysis. Input is the raw result of the agent's `hardware.diagnose` job (facts read from the machine);
 * output is findings with severity. Nothing here invents a reading: a component the agent could not read arrives in
 * `unavailable` with the reason and is reported as such, never scored.
 */
export type Severity = 'critical' | 'warning' | 'info';
export interface HwFinding { component: 'storage' | 'memory' | 'cpu' | 'thermal' | 'battery' | 'platform'; severity: Severity; code: string; message: string; recommendation: string }
export interface HwAnalysis {
  verdict: 'ok' | 'warning' | 'critical';
  findings: HwFinding[];
  unavailable: { component: string; reason: string }[];
  /** Components that were actually read successfully, so "ok" can be distinguished from "not looked at". */
  checked: string[];
}

type Obj = Record<string, any>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ATA_NAMES: Record<number, string> = { 5: 'Reallocated sectors', 9: 'Power-on hours', 177: 'Wear leveling count', 187: 'Uncorrectable errors', 194: 'Temperature', 197: 'Pending sectors', 198: 'Offline uncorrectable sectors', 231: 'SSD life left', 233: 'Media wearout indicator' };

export function analyzeHardware(raw: Obj): HwAnalysis {
  const f: HwFinding[] = [];
  const unavailable: HwAnalysis['unavailable'] = [];
  const checked: string[] = [];
  const add = (x: HwFinding) => f.push(x);

  for (const u of Array.isArray(raw.unavailable) ? raw.unavailable : []) if (u?.component) unavailable.push({ component: String(u.component), reason: String(u.reason ?? 'unknown') });

  // ---------- storage ----------
  for (const d of Array.isArray(raw.storage?.disks) ? raw.storage.disks : []) {
    const name = d.model ?? `Disk ${d.index}`;
    const st = (m: string, r: string, sev: Severity, code: string) => add({ component: 'storage', severity: sev, code, message: `${name}: ${m}`, recommendation: r });
    if (d.health === 'Unhealthy') st('Windows reports the drive as Unhealthy.', 'Verify backups immediately, then replace the drive.', 'critical', 'storage.unhealthy');
    else if (d.health === 'Warning') st('Windows reports a health Warning for the drive.', 'Verify backups and plan replacement.', 'warning', 'storage.health_warning');
    const rel = d.reliability;
    if (rel) {
      const unc = (num(rel.readErrorsUncorrected) ?? 0) + (num(rel.writeErrorsUncorrected) ?? 0);
      if (unc > 0) st(`${unc} uncorrectable read/write error(s) recorded by the drive.`, 'Storage reliability has deteriorated. Verify backups, then replace the drive.', 'critical', 'storage.uncorrectable');
      const wear = num(rel.wearPercent);
      if (wear != null && wear >= 90) st(`${wear}% of rated write endurance used.`, 'Replace the SSD soon.', 'critical', 'storage.wear_critical');
      else if (wear != null && wear >= 80) st(`${wear}% of rated write endurance used.`, 'Plan SSD replacement.', 'warning', 'storage.wear_high');
    }
    const n = d.nvme;
    if (n) {
      checked.push(`NVMe SMART (${name})`);
      const cw = num(n.criticalWarning) ?? 0;
      const bits: [number, string][] = [[1, 'available spare capacity below threshold'], [2, 'temperature outside safe range'], [4, 'NVM subsystem reliability degraded'], [8, 'media placed in read-only mode'], [16, 'volatile memory backup failed']];
      for (const [bit, text] of bits) if (cw & bit) st(`Drive controller raised a critical warning: ${text}.`, 'Back up now and replace the drive.', 'critical', `storage.nvme_critical_${bit}`);
      const spare = num(n.availableSparePercent), thr = num(n.availableSpareThresholdPercent);
      if (spare != null && thr != null && spare <= thr && !(cw & 1)) st(`Available spare capacity (${spare}%) is at or below its threshold (${thr}%).`, 'Replace the drive.', 'critical', 'storage.nvme_spare');
      else if (spare != null && spare < 30) st(`Available spare capacity is down to ${spare}%.`, 'Plan drive replacement.', 'warning', 'storage.nvme_spare_low');
      const used = num(n.percentageUsed);
      if (used != null && used >= 100) st(`Drive reports ${used}% of its rated life used.`, 'Replace the drive.', 'critical', 'storage.nvme_life');
      else if (used != null && used >= 80) st(`Drive reports ${used}% of its rated life used.`, 'Plan drive replacement.', 'warning', 'storage.nvme_life_high');
      const me = num(n.mediaErrors);
      if (me != null && me > 0) st(`${me} media and data integrity error(s) recorded.`, 'Data integrity is at risk. Verify backups, then replace the drive.', 'critical', 'storage.nvme_media_errors');
      const unsafe = num(n.unsafeShutdowns), cycles = num(n.powerCycles);
      if (unsafe != null && unsafe >= 50) {
        const ratio = cycles ? unsafe / cycles : null;
        st(`Drive recorded ${unsafe} unsafe shutdowns${ratio != null ? ` (${Math.round(ratio * 100)}% of ${cycles} power cycles)` : ''}: power was lost or the PC was forced off without a clean shutdown.`, 'Repeated hard power-offs risk file-system corruption; check the power supply/battery and how users shut down.', ratio != null && ratio > 0.5 ? 'warning' : 'info', 'storage.unsafe_shutdowns');
      }
      const t = num(n.temperatureC);
      if (t != null && t >= 80) st(`Drive temperature is ${t}°C.`, 'Check airflow and cooling.', 'critical', 'storage.hot');
      else if (t != null && t >= 70) st(`Drive temperature is ${t}°C.`, 'Check airflow and cooling.', 'warning', 'storage.warm');
    } else if (d.nvmeError) unavailable.push({ component: `NVMe SMART (${name})`, reason: String(d.nvmeError) });
  }
  const ata = Array.isArray(raw.storage?.ataSmart) ? raw.storage.ataSmart : [];
  for (const a of ata) {
    checked.push('ATA SMART');
    if (a.predictFailure === true) add({ component: 'storage', severity: 'critical', code: 'storage.smart_predict_failure', message: 'A drive is predicting imminent failure (SMART).', recommendation: 'Back up immediately and replace the drive.' });
    for (const at of Array.isArray(a.attributes) ? a.attributes : []) {
      const raw48 = num(at.raw) ?? 0, label = ATA_NAMES[at.id] ?? `Attribute ${at.id}`;
      if (at.id === 5 && raw48 > 0) add({ component: 'storage', severity: raw48 >= 100 ? 'critical' : 'warning', code: 'storage.reallocated', message: `${raw48} reallocated sector(s).`, recommendation: 'The drive is remapping bad sectors; back up and plan replacement.' });
      if ((at.id === 197 || at.id === 198 || at.id === 187) && raw48 > 0) add({ component: 'storage', severity: at.id === 197 ? 'warning' : 'critical', code: `storage.smart_${at.id}`, message: `${label}: ${raw48}.`, recommendation: 'Back up and replace the drive.' });
    }
  }
  const io = raw.storage?.ioErrors;
  if (io) {
    checked.push('Disk I/O error events');
    const disk: Obj = io.disk ?? {}, days = io.days ?? 30;
    if ((disk['7'] ?? 0) > 0) add({ component: 'storage', severity: 'critical', code: 'storage.bad_block', message: `Windows logged ${disk['7']} bad-block event(s) in ${days} days.`, recommendation: 'A drive has bad sectors. Back up and replace it.' });
    if ((disk['11'] ?? 0) > 0) add({ component: 'storage', severity: (disk['11'] ?? 0) >= 5 ? 'critical' : 'warning', code: 'storage.controller_error', message: `Windows logged ${disk['11']} disk controller error(s) in ${days} days.`, recommendation: 'Check cables/drive health; replace if repeated.' });
    if ((disk['51'] ?? 0) > 0) add({ component: 'storage', severity: 'warning', code: 'storage.paging_error', message: `Windows logged ${disk['51']} disk paging error(s) in ${days} days.`, recommendation: 'Investigate drive health.' });
    if ((disk['153'] ?? 0) > 0) add({ component: 'storage', severity: 'warning', code: 'storage.io_retried', message: `Windows had to retry disk I/O ${disk['153']} time(s) in ${days} days.`, recommendation: 'Investigate drive/controller health.' });
    if ((io.ntfsCorruption ?? 0) > 0) add({ component: 'storage', severity: 'warning', code: 'storage.fs_corruption', message: `File-system corruption was reported ${io.ntfsCorruption} time(s) in ${days} days.`, recommendation: 'Schedule a disk check (CHKDSK) and verify the drive.' });
  }

  // ---------- memory ----------
  const mem = raw.memory;
  if (mem?.modules?.length) {
    checked.push('Memory modules');
    const speeds = new Set((mem.modules as Obj[]).map(m => num(m.configuredMhz) ?? num(m.speedMhz)).filter(x => x != null));
    const rated = new Set((mem.modules as Obj[]).map(m => num(m.speedMhz)).filter(x => x != null));
    if (rated.size > 1) add({ component: 'memory', severity: 'info', code: 'memory.mixed_speed', message: `Memory modules are rated at different speeds (${[...rated].join(' and ')} MT/s); all run at the slowest.`, recommendation: 'Use matched modules for best performance.' });
    if (speeds.size > 1) add({ component: 'memory', severity: 'info', code: 'memory.mixed_configured', message: `Memory modules are configured at different speeds (${[...speeds].join(' and ')} MT/s).`, recommendation: 'Use matched modules.' });
  }
  for (const r of Array.isArray(mem?.diagnosticResults) ? mem.diagnosticResults : []) {
    if (r.passed === false) add({ component: 'memory', severity: 'critical', code: 'memory.diagnostic_failed', message: `Windows Memory Diagnostic reported errors (${r.at ?? 'date unknown'}).`, recommendation: 'Replace the faulty RAM module.' });
  }
  const lastDiag = (mem?.diagnosticResults ?? [])[0];
  if (lastDiag?.passed === true) checked.push('Windows Memory Diagnostic (last run passed)');

  // ---------- platform hardware errors ----------
  const wh = raw.whea;
  if (wh) {
    checked.push('WHEA hardware error log');
    const n = num(wh.events30d) ?? 0;
    if (n > 0) add({ component: 'platform', severity: n >= 3 ? 'critical' : 'warning', code: 'platform.whea', message: `Windows recorded ${n} hardware error(s) (WHEA) in 30 days${wh.samples?.[0]?.message ? `: ${String(wh.samples[0].message).slice(0, 160)}` : ''}.`, recommendation: 'Hardware is reporting faults (CPU, memory, PCIe or storage). Investigate before it fails.' });
  }

  // ---------- CPU / thermal ----------
  const th = num(raw.cpu?.thermalThrottleEvents7d);
  if (th != null) {
    checked.push('CPU throttle events');
    if (th >= 5) add({ component: 'cpu', severity: 'warning', code: 'cpu.throttled', message: `The CPU was slowed by firmware ${th} time(s) in 7 days.`, recommendation: 'Check cooling, dust and power delivery.' });
  }
  const zones: { name: string; tempC: number }[] = Array.isArray(raw.thermal?.zones) ? raw.thermal.zones.filter((z: Obj) => num(z.tempC) != null) : [];
  if (zones.length) {
    checked.push('Thermal zones');
    const cpuZone = zones.find(z => /cpu/i.test(z.name)) ?? [...zones].sort((a, b) => b.tempC - a.tempC)[0]!;
    if (cpuZone.tempC >= 90) add({ component: 'thermal', severity: 'critical', code: 'thermal.hot', message: `Thermal zone ${cpuZone.name} reads ${cpuZone.tempC.toFixed(0)}°C right now.`, recommendation: 'Overheating: check fans, vents and thermal paste.' });
    else if (cpuZone.tempC >= 80) add({ component: 'thermal', severity: 'warning', code: 'thermal.warm', message: `Thermal zone ${cpuZone.name} reads ${cpuZone.tempC.toFixed(0)}°C right now.`, recommendation: 'Running hot; check cooling if this persists at idle.' });
  }

  // ---------- battery ----------
  const b = raw.battery;
  if (b) {
    checked.push('Battery');
    const design = num(b.designCapacityMWh), full = num(b.fullChargeCapacityMWh), cyc = num(b.cycleCount);
    const health = design && full ? Math.round((100 * full) / design) : null;
    if (health != null && health < 50) add({ component: 'battery', severity: 'critical', code: 'battery.worn', message: `Battery holds only ${health}% of its original capacity${cyc != null ? ` after ${cyc} cycles` : ''}.`, recommendation: 'Replace the battery.' });
    else if (health != null && health < 70) add({ component: 'battery', severity: 'warning', code: 'battery.degraded', message: `Battery holds ${health}% of its original capacity${cyc != null ? ` after ${cyc} cycles` : ''}.`, recommendation: 'Plan battery replacement.' });
    else if (health != null && health < 85) add({ component: 'battery', severity: 'info', code: 'battery.aging', message: `Battery holds ${health}% of its original capacity${cyc != null ? ` after ${cyc} cycles` : ''}.`, recommendation: 'Normal ageing; monitor.' });
    if (health == null && cyc != null && cyc > 800) add({ component: 'battery', severity: 'warning', code: 'battery.cycles', message: `Battery has ${cyc} charge cycles.`, recommendation: 'Plan battery replacement.' });
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  f.sort((a, c) => rank[a.severity] - rank[c.severity]);
  const verdict = f.some(x => x.severity === 'critical') ? 'critical' : f.some(x => x.severity === 'warning') ? 'warning' : 'ok';
  return { verdict, findings: f, unavailable, checked };
}
