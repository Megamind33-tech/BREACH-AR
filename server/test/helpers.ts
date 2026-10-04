import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { connect, migrate } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { JobSigner } from '../src/jobs.js';
import { createServer } from 'node:net';

/** First port at or above `start` that nothing is listening on (a killed earlier run can leave a dead socket on a fixed port). */
async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    const ok = await new Promise<boolean>(res => { const s = createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error('no free port for the test database near ' + start);
}
const within = <T>(what: string, ms: number, p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms / 1000}s`)), ms))]);

/** Stops exactly this test database (the postmaster named in its own postmaster.pid) and the server processes under it, so nothing is left running to hold its folder. */
function killDatabase(dir: string) {
  try {
    const pid = Number(readFileSync(join(dir, 'postmaster.pid'), 'utf8').split('\n')[0]);
    if (pid > 0) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { process.kill(pid); } catch { /* already gone */ } } }
  } catch { /* no pid file: not running */ }
}

process.env.VIRO_QUIET = '1';
export async function startHarness(wantedPort: number) {
  const port = await freePort(wantedPort);
  const dir = mkdtempSync(join(tmpdir(), 'viro-pg-'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'viro', password: 'viro', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  // A test run that ends abruptly (a failed start, process.exit, Ctrl+C) must not leave its own database folder and server process behind: each one is ~50 MB.
  const cleanup = () => {
    killDatabase(dir);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } catch { /* best effort */ }
  };
  process.once('exit', cleanup);
  try { await within('test database start', 90_000, (async () => { await pg.initialise(); await pg.start(); await pg.createDatabase('viro'); })()); }
  catch (e) { cleanup(); throw e; }
  const db = connect(`postgres://viro:viro@localhost:${port}/viro`);
  await migrate(db);
  const signer = JobSigner.generate();
  const releasesDir = mkdtempSync(join(tmpdir(), 'viro-rel-'));   // each harness gets its own release/installer store: no state leaks between runs
  const app = await buildApp({ db, signer, releasesDir, jwtSecret: 'test-secret-test-secret-test-secret', platformKey: 'platform-key', onlineWindowSeconds: 120, loginRateLimitPerMinute: 1000, signupRateLimitPerMinute: 1000 });
  const log = (m: string) => { if (process.env.VIRO_DEBUG) console.log('[stop]', m); };
  return { app, db, signer, async stop() { log('close app'); await app.close(); log('end pool'); await db.end(); log('stop postgres'); try { const ok = await Promise.race([pg.stop().then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 15_000))]); if (!ok) killDatabase(dir); } catch { /* embedded-postgres removes its own dir; EBUSY on Windows is harmless */ } try { rmSync(releasesDir, { recursive: true, force: true }); } catch { /* disposable */ } try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows may hold the dir briefly; temp dir is disposable */ } } };
}
