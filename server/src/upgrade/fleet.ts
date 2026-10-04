/** Phase 9: fleet intelligence. Identical computers are grouped so one verified answer covers many; bulk purchase plans are derived from the same recommendations. */
import { createHash } from 'node:crypto';
import { normalizeMachine } from './normalize.js';
import type { Recommendation } from './engine.js';

type Obj = Record<string, any>;
export interface FleetItem { deviceId: string; hostname: string; anatomy: Obj; report: Obj }

export function groupKeyOf(a: Obj): string {
  const m = normalizeMachine(a);
  return createHash('sha256').update(JSON.stringify([m.formFactor, m.board.manufacturer, m.board.model, m.board.chipset, m.cpu.model, m.memory.slotsTotal, m.memory.dimms.map(d => [d.capacityGB, d.type, d.ratedMTs]).sort(), m.disks.map(d => [d.kind, d.sizeGB]).sort()])).digest('hex').slice(0, 16);
}

export type FleetCategory = 'No upgrade required' | 'RAM upgrade recommended' | 'CPU upgrade recommended' | 'CPU + RAM' | 'Storage replacement' | 'Cooling issue' | 'Replacement more economical' | 'Not enough verified information';
export function categoryOf(report: Obj): FleetCategory {
  if (report.replacement?.action === 'REPLACE_MACHINE' || report.replacement?.action === 'DO_NOT_UPGRADE') return 'Replacement more economical';
  const recs: Recommendation[] = (report.recommendations ?? []).filter((r: Recommendation) => r.class !== 'OPTIONAL');
  const has = (c: string) => recs.some(r => r.component === c);
  if (has('storage')) return 'Storage replacement';
  if (has('cooling') && !has('cpu')) return 'Cooling issue';
  if (has('cpu') && has('memory')) return 'CPU + RAM';
  if (has('cpu')) return 'CPU upgrade recommended';
  if (has('memory')) return 'RAM upgrade recommended';
  if (has('cooling')) return 'Cooling issue';
  return (report.gaps?.length ?? 0) > 4 && !(report.recommendations ?? []).length ? 'Not enough verified information' : 'No upgrade required';
}

export function buildFleetPlan(items: FleetItem[]) {
  type Group = { key: string; machine: string; systems: { deviceId: string; hostname: string }[]; category: FleetCategory; recommendationIds: string[] };
  const counts: Record<string, number> = {}; const groups = new Map<string, Group>();
  const parts = new Map<string, { part: string; spec: string; component: string; machines: Set<string>; quantity: number; priority: string; confidence: number }>();
  const rank = { ESSENTIAL: 0, HIGH_VALUE: 1, OPTIONAL: 2 } as Record<string, number>;
  for (const it of items) {
    const cat = categoryOf(it.report); counts[cat] = (counts[cat] ?? 0) + 1;
    const key = groupKeyOf(it.anatomy) + '|' + cat; const m = it.report.machine;
    const g: Group = groups.get(key) ?? { key, machine: [m.board.manufacturer, m.board.model, m.cpu.name].filter(Boolean).join(' · '), systems: [], category: cat, recommendationIds: (it.report.recommendations ?? []).map((r: Recommendation) => r.id) };
    g.systems.push({ deviceId: it.deviceId, hostname: it.hostname }); groups.set(key, g);
    for (const r of (it.report.recommendations ?? []) as Recommendation[]) {
      if (r.component === 'cooling' || !r.part) continue;
      const spec = r.component === 'cpu' ? String(r.part.cpu) : r.component === 'memory' ? String(r.part.label) : String(r.part.spec);
      const pk = `${r.component}|${spec}`; const e = parts.get(pk) ?? { part: r.component === 'storage' ? r.title : spec, spec, component: r.component, machines: new Set<string>(), quantity: 0, priority: r.class, confidence: 1 };
      e.machines.add(it.deviceId); e.quantity += (r.part.quantity as number | undefined) ?? 1; if (rank[r.class]! < rank[e.priority]!) e.priority = r.class; e.confidence = Math.min(e.confidence, r.confidence.overall); parts.set(pk, e);
    }
  }
  return {
    analysed: items.length, categories: Object.entries(counts).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    groups: [...groups.values()].map(g => ({ ...g, count: g.systems.length })).sort((a, b) => b.count - a.count),
    purchasePlan: [...parts.values()].map(e => ({ part: e.part, specification: e.spec, component: e.component, compatibleSystems: e.machines.size, quantity: e.quantity, priority: e.priority, confidence: Math.round(e.confidence * 100) / 100 })).sort((a, b) => rank[a.priority]! - rank[b.priority]! || b.quantity - a.quantity),
  };
}
