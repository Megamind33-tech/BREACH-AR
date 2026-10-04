import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.VIRO_MAIL_MODE = 'outbox';
const { startHarness } = await import('./helpers.js');

const reading = (): any => ({
  version: 1, collectedAt: '2026-10-01T10:00:00Z',
  system: { manufacturer: 'Dell Inc.', model: 'Latitude 5400', serial: 'ABC1234XYZ', formFactor: 'laptop', totalPhysicalMemoryBytes: 8 * 2 ** 30 },
  bios: { releaseDate: '2023-03-10', mode: 'UEFI', secureBoot: true, tpm: { present: true, enabled: true, version: '2.0' } },
  cpu: { name: 'Intel(R) Core(TM) i5-8365U CPU @ 1.60GHz', cores: 4, logical: 8, architecture: 'x64' },
  memory: { slotsTotal: 2, modules: [{ capacityBytes: 8 * 2 ** 30, manufacturer: 'Samsung', serial: 'MEM1', type: 'DDR4' }] },
  monitors: [{ year: 2020, week: 14, sizeInches: 14, builtIn: true }],
  battery: { cycleCount: 640, wearPercent: 45, designMWh: 60000, fullChargeMWh: 33000 },
  os: { caption: 'Microsoft Windows 10 Pro', build: '19045' },
  evidence: { windowsInstalls: [{ date: '2020-05-20', product: 'Windows 10 Pro', build: '18363' }], currentWindowsInstall: '2024-06-01' },
  diagnostics: { storage: { disks: [{ index: 0, model: 'ST1000LM035', mediaType: 'HDD', health: 'Healthy', sizeBytes: 1e12, reliability: { powerOnHours: 41000, readErrorsUncorrected: 0 } }] } },
  unavailable: [],
});

let h: Awaited<ReturnType<typeof startHarness>>;
before(async () => { h = await startHarness(54411); });
after(async () => { await h.stop(); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url, payload: payload as any, headers });
const put = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'PUT', url, payload: payload as any, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: 'GET', url, headers });
const outbox = () => (h.app as any).mailer.outbox as { to: string; text: string }[];
const PK = { 'x-platform-key': 'platform-key' };

test('a free plan sees that there is something to look at, a paid plan gets the detail, and the reading is not kept', async () => {
  await post('/api/v1/signup', { name: 'Test Person', email: 'mypc@example.com', password: 'a-long-password-1', acceptTerms: true });
  await get(`/verify-email?token=${outbox().pop()!.text.match(/token=([\w-]+)/)![1]}`);
  const me = { authorization: `Bearer ${(await post('/api/v1/auth/login', { email: 'mypc@example.com', password: 'a-long-password-1' })).json().token}` };

  assert.equal((await post('/api/v1/my-pc/report', {}, me)).statusCode, 400);
  const free = (await post('/api/v1/my-pc/report', { anatomy: reading() }, me)).json();
  assert.ok(free.summary.watch + free.summary.urgent > 0, 'the count is shown so the person knows there is something to see');
  assert.equal(free.health.locked, true); assert.equal(free.health.feature, 'health.warnings'); assert.equal(free.advice.feature, 'advice.replace'); assert.equal(free.history.feature, 'history.machine');
  assert.equal(free.machine.model, 'Latitude 5400'); assert.ok(!JSON.stringify(free).includes('ABC1234XYZ'));

  await put('/api/v1/platform/billing/plans/care-year', { name: 'Care', audience: 'person', price: 250, currency: 'ZMW', period: 'year', active: true }, PK);
  const method = (await post('/api/v1/platform/billing/methods', { kind: 'cash', label: 'Cash', instructions: 'Pay in person.' }, PK)).json().id;
  const order = (await post('/api/v1/billing/orders', { planCode: 'care-year', quantity: 1, methodId: method }, me)).json();
  await post(`/api/v1/billing/orders/${order.id}/paid`, { payerName: 'T', transactionId: 'R1' }, me); await post(`/api/v1/platform/billing/orders/${order.id}/confirm`, {}, PK);

  const paid = (await post('/api/v1/my-pc/report', { anatomy: reading(), purchaseCost: 900 }, me)).json();
  assert.ok(paid.health.parts.length > 5); const battery = paid.health.parts.find((p: any) => p.kind === 'Battery'); assert.ok(['WATCH', 'HIGH', 'CRITICAL'].includes(battery.risk)); assert.ok(battery.action);
  assert.ok(paid.advice.cost.priced); assert.ok(paid.advice.cost.repairTotal > 0); assert.ok(paid.advice.age.ageYears > 5); assert.equal(paid.advice.lifeStage.stage, 'Past its typical life');
  assert.equal(paid.advice.windows.runningWindows10, true); assert.equal(paid.history.summary.windowsUpgrades, 1);
  assert.ok(!JSON.stringify(paid).includes('ABC1234XYZ') && !JSON.stringify(paid).includes('MEM1'), 'identifiers are never sent back');
  assert.equal((await h.db.query(`SELECT count(*)::int n FROM device_anatomy`)).rows[0].n, 0, 'the reading is not stored');
});
