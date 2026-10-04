import type { HealthResult, Snapshot } from './health.js';
import { HARDWARE_CODES, IMPACT_RANK, confidenceFor, evidenceFor, safetyLevelOf, titleOf } from './incidents.js';

/**
 * "Why is this computer slow?" Ranked causes, each with the measurements behind it, a confidence and the action tied to that cause.
 * It never invents a cause: it re-presents what the health engine measured, and it says plainly when software has nothing left to fix.
 */
const DIAG_CATEGORIES = new Set(['performance', 'storage', 'updates', 'drivers', 'reliability', 'hardware', 'security']);

export function slowPcDiagnosis(h: HealthResult, snap: Snapshot) {
  const causes = h.deductions.filter(d => DIAG_CATEGORIES.has(d.category) && d.points > 0)
    .sort((a, b) => IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] || b.points - a.points)
    .map((d, i) => ({
      rank: i + 1, impact: d.impact, code: d.code, title: titleOf(d), cause: d.reason, confidence: confidenceFor(d, snap), points: d.points,
      evidence: evidenceFor(d, snap), remedy: d.remedy, safetyLevel: safetyLevelOf(d),
      action: d.fix ? { label: d.fix.label, automatic: safetyLevelOf(d) <= 1 } : null, recommendation: d.recommendation,
    }));
  const softwareCauses = causes.filter(c => c.remedy === 'safe-fix' || c.remedy === 'review' || c.remedy === 'manual');
  const hardwareCauses = causes.filter(c => c.remedy === 'hardware' || HARDWARE_CODES.test(c.code));
  const perfScore = h.categories.performance ?? 100;
  const softwareLimitReached = perfScore < 70 && softwareCauses.filter(c => c.impact !== 'low').length === 0 && hardwareCauses.length > 0;
  return {
    overall: h.overall, performanceScore: perfScore, causes,
    notMeasured: h.notMeasured,
    limit: softwareLimitReached ? {
      softwareLimitReached: true,
      message: 'Software optimization limit reached. Nothing left in Windows, drivers or storage explains the slowness; this computer is mainly held back by its hardware.',
      constraints: hardwareCauses.map(c => ({ title: c.title, evidence: c.cause, confidence: c.confidence })),
    } : { softwareLimitReached: false },
    summary: !causes.length ? 'No measurable cause of slowness was found.'
      : `${causes.filter(c => c.impact === 'high').length} high-impact and ${causes.filter(c => c.impact === 'medium').length} medium-impact causes found.`,
  };
}
