import type { Db } from './db.js';

/**
 * The Health Engine's instruction to the Compute worker for one computer. Compute never wins over the health of the machine:
 *   BLOCK     a hardware fault that more load could make worse (failing drive, overheating) or a worn-out battery
 *   PAUSE     a repair or its verification is running, or the computer is crashing repeatedly and is being diagnosed
 *   THROTTLE  the processor is being slowed down by heat: halve the compute limit
 *   ALLOW     nothing in the way
 */
export type Gate = 'ALLOW' | 'THROTTLE' | 'PAUSE' | 'BLOCK';
export interface GateDecision { gate: Gate; reason: string }

/**
 * Security always overrides compute. While a threat is being contained, investigated or repaired compute is BLOCKED; while it is being verified
 * it is PAUSED; compute may resume only once the incident is verified clean (observation) or resolved.
 */
export function securityGate(statuses: { status: string; threat_type: string }[]): GateDecision | null {
  const open = statuses.filter(s => !['RESOLVED', 'OBSERVING'].includes(s.status));
  if (!open.length) return null;
  const ransom = open.find(s => s.threat_type === 'ransomware');
  if (ransom) return { gate: 'BLOCK', reason: 'Ransomware activity is being handled on this computer; compute stays off until it is verified clean.' };
  if (open.some(s => s.status === 'VERIFYING')) return { gate: 'PAUSE', reason: 'A security scan and inspection are checking that a threat is gone.' };
  return { gate: 'BLOCK', reason: 'A security threat is being contained and repaired on this computer; compute stays off until it is verified clean.' };
}

export function decideGate(incidents: { code: string; status: string; impact: string; remedy: string }[], security: { status: string; threat_type: string }[] = []): GateDecision {
  const sec = securityGate(security); if (sec) return sec;
  const open = incidents.filter(i => i.status !== 'RESOLVED');
  const hw = open.find(i => /^(hw\.|hardware\.disk|hardware\.hdd|hardware\.cooling|battery\.)/.test(i.code) && i.remedy === 'hardware' && (i.impact === 'high' || i.impact === 'medium'));
  if (hw) return { gate: 'BLOCK', reason: 'A hardware fault was detected on this computer; compute is disabled to avoid extra wear.' };
  const busy = open.find(i => i.status === 'REPAIRING' || i.status === 'VERIFYING');
  if (busy) return { gate: 'PAUSE', reason: 'A repair is being carried out or checked on this computer.' };
  const lowMem = open.find(i => i.code === 'perf.low_virtual_memory');
  if (lowMem) return { gate: 'PAUSE', reason: 'Windows has been running out of memory; compute stays off until that is dealt with.' };
  const crashing = open.find(i => i.code.startsWith('stability.app:') && i.impact === 'high');
  if (crashing) return { gate: 'PAUSE', reason: 'Applications are crashing repeatedly; compute is paused while this is diagnosed.' };
  const hot = open.find(i => i.code === 'perf.throttling');
  if (hot) return { gate: 'THROTTLE', reason: 'The processor is slowing itself down because of heat; compute is reduced.' };
  return { gate: 'ALLOW', reason: 'The computer is healthy.' };
}

export async function healthGate(db: Db, deviceId: string): Promise<GateDecision> {
  const r = await db.query(`SELECT code, status, impact, remedy FROM incidents WHERE device_id=$1 AND status <> 'RESOLVED'`, [deviceId]);
  const s = await db.query(`SELECT status, threat_type FROM security_incidents WHERE device_id=$1 AND status NOT IN ('RESOLVED','OBSERVING')`, [deviceId]);
  return decideGate(r.rows, s.rows);
}
