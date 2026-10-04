import { buildApp } from './app.js';
import { connect, migrate } from './db.js';
import { JobSigner, sweepJobs } from './jobs.js';
import { schedulerTick } from './policies.js';
import { rolloutTick, autoStartDriverRollouts } from './patching.js';
import { offlineSweep } from './alerts.js';
import { webhookTick } from './webhooks.js';
import { fixRolloutTick } from './fleet-routes.js';
import { summaryTick } from './summary.js';
import { securityTick } from './security-incidents.js';
import { ensureFirstPlatformAdmin } from './platform.js';
import { miningTick } from './mining-reporting.js';

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing required env ${k}`); process.exit(1); } return v; };

if (process.env.NODE_ENV === 'production') {
  for (const k of ['JWT_SECRET', 'PLATFORM_KEY']) { const v = process.env[k] ?? ''; if (v.length < 32 || /^dev-|change-?me|example|secret$/i.test(v)) { console.error(`${k} is missing, too short (32+ characters) or a development default; refusing to start in production`); process.exit(1); } }
}
const db = connect(need('DATABASE_URL'));
const applied = await migrate(db);
if (applied.length) console.log('applied migrations:', applied.join(', '));
const first = await ensureFirstPlatformAdmin(db, process.env.PLATFORM_ADMIN_EMAIL, process.env.PLATFORM_ADMIN_PASSWORD);
if (first === 'created') console.log('created the first platform admin from PLATFORM_ADMIN_EMAIL');
if (first === 'skipped') console.warn('no platform admin exists: set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD (12+ characters) to create one');
const signer = JobSigner.load(process.env);
setInterval(() => sweepJobs(db).catch(e => console.error('job sweep failed', e)), 30_000).unref();
setInterval(() => schedulerTick(db, signer).catch(e => console.error('scheduler failed', e)), 60_000).unref();
setInterval(() => rolloutTick(db, signer).catch(e => console.error('rollout tick failed', e)), 30_000).unref();
setInterval(() => autoStartDriverRollouts(db, signer).catch(e => console.error('driver auto-start failed', e)), 600_000).unref();
setInterval(() => fixRolloutTick(db, signer).catch(e => console.error('fix rollout tick failed', e)), 30_000).unref();
setInterval(() => securityTick(db, signer).catch(e => console.error('security tick failed', e)), 30_000).unref();
setInterval(() => webhookTick(db).catch(e => console.error('webhook tick failed', e)), 15_000).unref();
setInterval(() => summaryTick(db).catch(e => console.error('summary tick failed', e)), 3_600_000).unref();
setInterval(() => miningTick(db).catch(e => console.error('mining tick failed', e)), 600_000).unref();
setInterval(() => offlineSweep(db).catch(e => console.error('offline sweep failed', e)), 60_000).unref();
const app = await buildApp({ db, signer, jwtSecret: need('JWT_SECRET'), platformKey: need('PLATFORM_KEY'), releasesDir: process.env.RELEASES_DIR ?? './data/releases', trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(",").map(s => s.trim()) : false, requireTrustedSignature: process.env.REQUIRE_TRUSTED_SIGNATURE === '1' });
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
