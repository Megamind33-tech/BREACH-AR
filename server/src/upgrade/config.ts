/** Tunable thresholds and scoring weights. Server-side only: weights are never sent to the console or shown to customers. */
export const UPGRADE_CONFIG = {
  powerStepLimit: 1.3,             // a candidate doing more than this multiple of the installed processor's sustained work is a power-class step, not a swap
  minGainPercent: 10,              // below this a hardware change is not worth asking for
  strongGainPercent: 25,           // at or above this a change is "high value" when it is also affordable
  uncertaintyBand: 0.12,           // +/- applied to a model prediction until the machine has been measured
  maxCostShare: 0.45,              // reject spending beyond this share of a new computer unless the gain is large
  outcomesMinInstalls: 3,          // verified installations needed before observed results replace the model
  ramHeadroom: 0.7,                // memory should peak at no more than this share of what is installed
  ramCriticalPercent: 92,          // peak use at or above this is "critically insufficient"
  tempHotIdleC: 80, tempHotLoadC: 92, sustainedRatioFloor: 0.9,
  weights: { performance: 1, compatibility: 1, stability: 1, cost: 1, platformLife: 1, thermal: 1, power: 1, complexity: 1 },
};
