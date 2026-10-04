// Starts a throw-away Control with a fictional school ("Riverside Academy") so the marketing screenshots show a believable, safe organization.
// Nothing here is real customer data: the hardware readings are anonymised test fixtures (serials removed) and every name is invented.
// Usage: npx tsx scripts/site-demo.ts      (listens on 127.0.0.1:8098 and prints READY)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from '../test/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'upgrade', n), 'utf8'));
const h = await startHarness(54410);
const PK = { 'x-platform-key': 'platform-key' }; const GB = 2 ** 30;
const call = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method, url, payload: payload as any, headers });

await call('POST', '/api/v1/platform/organizations', { name: 'Riverside Academy', ownerEmail: 'owner@demo.test', ownerPassword: 'demo-local-pass-1', autopilot: true, plan: 'standard' }, PK);
const login = await call('POST', '/api/v1/auth/login', { email: 'owner@demo.test', password: 'demo-local-pass-1' });
const auth = { authorization: `Bearer ${login.json().token}` };
const main = (await call('POST', '/api/v1/sites', { name: 'Main Campus' }, auth)).json(), sci = (await call('POST', '/api/v1/sites', { name: 'Science Block' }, auth)).json();
const dept = async (siteId: string, name: string) => (await call('POST', '/api/v1/departments', { siteId, name }, auth)).json();
const office = await dept(main.id, 'Administration'), lab = await dept(sci.id, 'Computer Lab'), library = await dept(main.id, 'Library');

type Pc = { name: string; cpu: number; ram: number; freeGb: number; site: any; dept: any; anatomy?: string; bought?: [string, number] };
const PCS: Pc[] = [
  { name: 'FRONT-DESK-01', cpu: 18, ram: 46, freeGb: 310, site: main, dept: office , anatomy: 'hp-290-g4.json', bought: ['2024-05-10', 11200]},
  { name: 'BURSAR-LAPTOP', cpu: 24, ram: 58, freeGb: 140, site: main, dept: office, anatomy: 'probook-430-g7.json', bought: ['2021-03-08', 15800] },
  { name: 'HEADTEACHER-PC', cpu: 22, ram: 52, freeGb: 260, site: main, dept: office , anatomy: 'probook-430-g7.json', bought: ['2022-08-22', 17500]},
  { name: 'LIBRARY-03', cpu: 14, ram: 41, freeGb: 14, site: main, dept: library , anatomy: 'hp-290-g4.json', bought: ['2017-11-03', 9800]},
  { name: 'LAB-PC-01', cpu: 41, ram: 66, freeGb: 190, site: sci, dept: lab , anatomy: 'hp-290-g4.json', bought: ['2019-06-14', 10400]},
  { name: 'LAB-PC-02', cpu: 36, ram: 72, freeGb: 118, site: sci, dept: lab, anatomy: 'hp-290-g4.json', bought: ['2020-09-14', 10900] },
  { name: 'LAB-PC-03', cpu: 33, ram: 61, freeGb: 205, site: sci, dept: lab , anatomy: 'hp-290-g4.json', bought: ['2018-02-19', 9900]},
  { name: 'LAB-PC-04', cpu: 29, ram: 57, freeGb: 230, site: sci, dept: lab , anatomy: 'hp-290-g4.json', bought: ['2023-09-05', 12800]},
];
// the school's own price list, in kwacha (the demo is set in Zambia): about 25 kwacha to the dollar on the reference prices
await call('PUT', '/api/v1/price-book', { currency: 'ZMW', labourPerHour: 150, items: { ram_ddr3: 500, ram_ddr4: 650, ram_ddr5: 900, ram_lpddr4: 0, ssd_256gb: 1000, ssd_512gb: 1400, ssd_1tb: 2000, ssd_2tb: 3800, battery_laptop: 1500, thermal_service: 400, os_reinstall: 250 }, newPc: { laptop: 17500, desktop: 13500, 'all-in-one': 22000, server: 62000, unknown: 17500 } }, auth);
const devs: { name: string; dev: Record<string, string>; cpu: number; ram: number }[] = [];
for (const [i, p] of PCS.entries()) {
  const t = await call('POST', '/api/v1/enrollment-tokens', {}, auth);
  const e = await call('POST', '/agent/v1/enroll', { enrollmentToken: t.json().token, machineGuid: 'demo-guid-00000' + i, hostname: p.name, agentVersion: '0.1.11' });
  const dev = { authorization: `Bearer ${e.json().deviceId}.${e.json().deviceSecret}` };
  if (p.bought) await call('PATCH', `/api/v1/devices/${e.json().deviceId}/purchase`, { purchaseDate: p.bought[0], purchaseCost: p.bought[1] }, auth);
  await call('POST', '/api/v1/devices/assign', { deviceIds: [e.json().deviceId], siteId: p.site.id, departmentId: p.dept.id }, auth);
  await call('POST', '/agent/v1/heartbeat', { hostname: p.name, agentVersion: '0.1.11', metrics: { cpuPercent: p.cpu, ramPercent: p.ram }, osCaption: 'Microsoft Windows 11 Pro', loggedInUser: 'staff' }, dev);
  await call('PUT', '/agent/v1/health', { collectedAt: new Date().toISOString(), volumes: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: p.freeGb * GB, isSystem: true }] }, dev);
  if (p.anatomy) { const a = fixture(p.anatomy); delete a._fixture; a.collectedAt = new Date().toISOString(); await call('POST', '/agent/v1/anatomy', a, dev); }
  devs.push({ name: p.name, dev, cpu: p.cpu, ram: p.ram });
}
setInterval(() => { for (const d of devs) void call('POST', '/agent/v1/heartbeat', { hostname: d.name, agentVersion: '0.1.11', metrics: { cpuPercent: d.cpu + Math.round(Math.random() * 5), ramPercent: d.ram }, osCaption: 'Microsoft Windows 11 Pro' }, d.dev); }, 25_000);
await h.app.listen({ port: 8098, host: '127.0.0.1' });
console.log('READY');
