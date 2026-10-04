// Local development Postgres (real Postgres binaries via embedded-postgres). Not used in production.
import EmbeddedPostgres from 'embedded-postgres';
const pg = new EmbeddedPostgres({ databaseDir: './.devdata', user: 'viro', password: 'viro', port: 5433, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
try { await pg.initialise(); } catch { /* already initialised */ }
await pg.start();
try { await pg.createDatabase('viro'); } catch { /* exists */ }
console.log('dev postgres ready: postgres://viro:viro@localhost:5433/viro');
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
