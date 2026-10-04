import { z } from 'zod';

/* ------------------------------------------------------------------------------------------------
 * WorkCare twin contracts (schema version 1). The single source of truth for payloads shared by WorkCare Mobile, QuickCheck,
 * WorkCare Desktop and the Control server. `npm run twin:export` writes JSON Schemas to packages/contracts/schema so the Kotlin
 * and C# implementations validate against the same shapes; a test fails if the checked-in files are stale.
 * Readers ignore unknown fields. A reader refuses a schemaVersion major it does not know.
 * ---------------------------------------------------------------------------------------------- */

export const SCHEMA_VERSION = 1;
const iso = z.string().datetime({ offset: true });
const base = { schemaVersion: z.literal(SCHEMA_VERSION), deviceId: z.string().min(1).max(80), timestamp: iso, source: z.enum(['desktop', 'quickcheck', 'mobile', 'server']) };

export const Severity = z.enum(['healthy', 'attention', 'critical']);
export const EvidenceType = z.enum(['measured', 'tested', 'inferred']);
export const Component = z.enum(['processor', 'memory', 'storage', 'battery', 'graphics', 'cooling', 'network', 'windows', 'security', 'display', 'system', 'apps', 'sensors']);
export const DeviceKind = z.enum(['pc', 'phone']);
export const Freshness = z.enum(['live', 'recent', 'stale', 'never']);

export const DiagnosticEvidence = z.object({ name: z.string().max(60), value: z.union([z.number(), z.string(), z.boolean()]), unit: z.string().max(12).nullish() });
export const DiagnosticFinding = z.object({
  id: z.string().max(80), component: Component, severity: Severity, title: z.string().max(100), summary: z.string().max(400),
  evidenceType: EvidenceType, evidence: z.array(DiagnosticEvidence).max(20), recommendedAction: z.string().max(300).nullish(),
  /** 'deep' findings come from the deeper audit (WorkCare Plus). Anything that is a safety problem is also reported by an essential check, so the free scan never hides one. */
  tier: z.enum(['essential', 'deep']).nullish(),
});

export const ComponentHealth = z.object({ component: Component, label: z.string().max(80), detail: z.string().max(160).nullish(), status: Severity.or(z.literal('unavailable')), unavailableReason: z.string().max(160).nullish(), findingIds: z.array(z.string()).max(30) });

export const DeviceSummary = z.object({
  ...base, kind: DeviceKind, name: z.string().max(120), model: z.string().max(120).nullish(), status: Severity,
  headline: z.string().max(160), lastSeenAt: iso.nullish(), freshness: Freshness, isThisDevice: z.boolean().default(false),
});
export const DeviceHealth = z.object({ ...base, status: Severity, headline: z.string().max(160), components: z.array(ComponentHealth), findings: z.array(DiagnosticFinding), notMeasured: z.array(z.string()).max(40) });

export const ScanStage = z.object({ id: z.string().max(40), label: z.string().max(60), state: z.enum(['waiting', 'running', 'done', 'skipped', 'failed']), detail: z.string().max(160).nullish() });
/** Progress is the share of stages actually finished: never an invented percentage. */
export const ScanProgress = z.object({ ...base, scanId: z.string().max(60), stages: z.array(ScanStage).min(1), completedStages: z.number().int().min(0), totalStages: z.number().int().min(1), finished: z.boolean() });
export const ScanResult = z.object({ ...base, scanId: z.string().max(60), device: z.object({ name: z.string().max(120), model: z.string().max(120).nullish() }), passed: z.number().int().min(0), attention: z.number().int().min(0), critical: z.number().int().min(0), findings: z.array(DiagnosticFinding), notMeasured: z.array(z.string()).max(40), disclaimer: z.string().max(300),
  /** Plain facts about the gadget for the report: grouped label/value pairs read from the machine. Never estimates. */
  facts: z.array(z.object({ group: z.string().max(30), label: z.string().max(60), value: z.string().max(160), evidenceType: EvidenceType.nullish() })).max(60).nullish(),
  /** 'essential' = the free scan; 'deep' = the deeper audit also ran. */
  depth: z.enum(['essential', 'deep']).nullish(),
  /** The deep checks that did NOT run. Names and what they look at only: nothing is claimed about their result. */
  deepNotRun: z.array(z.object({ id: z.string().max(60), title: z.string().max(120), why: z.string().max(300) })).max(40).nullish() });

export const Alert = z.object({ ...base, id: z.string().max(60), severity: z.enum(['attention', 'critical']), title: z.string().max(100), summary: z.string().max(400), openedAt: iso, resolvedAt: iso.nullish() });
export const MachinePassportEvent = z.object({ ...base, id: z.string().max(60), at: iso, kind: z.string().max(60), title: z.string().max(120), detail: z.string().max(300).nullish(), origin: z.enum(['buyer_check', 'agent', 'service_record', 'repair_verification', 'alert']) });
export const RepairVerification = z.object({ ...base, id: z.string().max(60), title: z.string().max(120), before: z.array(DiagnosticEvidence), after: z.array(DiagnosticEvidence), verified: z.boolean(), note: z.string().max(300).nullish() });
export const ConnectionSession = z.object({ ...base, sessionId: z.string().max(60), transport: z.enum(['lan', 'hotspot', 'usb', 'relay', 'bluetooth', 'code']), expiresAt: iso, state: z.enum(['created', 'pairing', 'secured', 'inspecting', 'closed', 'expired', 'revoked']), scope: z.enum(['inspect', 'manage']) });
export const ComputeStatus = z.object({
  ...base, available: z.boolean(), enabledByPolicy: z.boolean(), state: z.string().max(40).nullish(), reason: z.string().max(300).nullish(), cpuCapPercent: z.number().min(0).max(100).nullish(), cpuTempC: z.number().nullish(),
  gate: z.enum(['ALLOW', 'THROTTLE', 'PAUSE', 'BLOCK']).nullish(), consentRecorded: z.boolean(), canPause: z.boolean(), canResume: z.boolean(),
});

/** The portable inventory both QuickCheck and the phone produce. Every field is optional: unreadable means absent, never guessed. */
export const PcInventory = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  identity: z.object({ hostname: z.string().max(80).nullish(), manufacturer: z.string().max(80).nullish(), model: z.string().max(120).nullish(), serial: z.string().max(80).nullish(), biosVersion: z.string().max(80).nullish(), boardModel: z.string().max(80).nullish(), biosDate: z.string().max(12).nullish(), osInstalled: z.string().max(12).nullish() }).partial(),
  windows: z.object({ caption: z.string().max(120).nullish(), build: z.string().max(20).nullish() }).partial().nullish(),
  cpu: z.object({ name: z.string().max(120).nullish(), cores: z.number().int().nullish(), maxClockMhz: z.number().nullish(), gpu: z.string().max(120).nullish(), peakTempC: z.number().nullish(), throttled: z.boolean().nullish(), usagePercent: z.number().nullish() }).partial().nullish(),
  memory: z.object({ totalBytes: z.number().nullish(), slotsTotal: z.number().int().nullish(), slotsUsed: z.number().int().nullish(), type: z.string().max(20).nullish(), speedMhz: z.number().nullish() }).partial().nullish(),
  storage: z.array(z.object({
    model: z.string().max(120).nullish(), sizeBytes: z.number().nullish(), freeBytes: z.number().nullish(), mediaType: z.string().max(20).nullish(), health: z.string().max(20).nullish(), isSystem: z.boolean().nullish(), powerOnHours: z.number().nullish(),
    nvme: z.object({ percentageUsed: z.number().nullish(), availableSparePercent: z.number().nullish(), criticalWarning: z.number().nullish(), mediaErrors: z.number().nullish(), unsafeShutdowns: z.number().nullish(), temperatureC: z.number().nullish() }).partial().nullish(),
  })).max(16).nullish(),
  battery: z.object({ designWh: z.number().nullish(), fullChargeWh: z.number().nullish(), cycleCount: z.number().nullish() }).partial().nullish(),
  gpu: z.array(z.object({ name: z.string().max(120).nullish() })).max(8).nullish(),
  security: z.object({ defenderEnabled: z.boolean().nullish(), firewallEnabled: z.boolean().nullish() }).partial().nullish(),
  /** Readings from the deep Windows audit (encryption, boot, updates, Defender freshness, settings, reliability, Wi-Fi). Only present when that audit ran. */
  deep: z.record(z.string(), z.unknown()).nullish(),
  unavailable: z.array(z.object({ component: z.string().max(40), reason: z.string().max(160) })).max(30).nullish(),
});
export type PcInventoryT = z.infer<typeof PcInventory>;
export type DiagnosticFindingT = z.infer<typeof DiagnosticFinding>;
export type SeverityT = z.infer<typeof Severity>;

/** Everything exported as JSON Schema for the other languages. */
export const EXPORTED = { DiagnosticFinding, DiagnosticEvidence, ComponentHealth, DeviceSummary, DeviceHealth, ScanProgress, ScanResult, Alert, MachinePassportEvent, RepairVerification, ConnectionSession, ComputeStatus, PcInventory } as const;
