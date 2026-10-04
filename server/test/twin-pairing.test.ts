import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Channel, MAX_FAILED_ATTEMPTS, PcSession, createOffer, encodeOffer, makeHello, newCode, parseOffer, secretFromCode, open } from '../src/twin/pairing.js';
import { pairingVectors } from '../scripts/twin-export.js';

const NOW = 1_790_000_000;
const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages');

function pair(now = NOW) {
  const pc = createOffer(now, { hints: ['lan:10.0.0.5:47821'] });
  const session = new PcSession(pc);
  const phone = makeHello(parseOffer(encodeOffer(pc.offer)));
  const res = session.hello(phone.hello, now + 1);
  return { pc, session, phone, res };
}

test('a phone that scanned the offer and the PC end up with the same keys and the same 6-digit authentication string; frames flow both ways', () => {
  const { pc, phone, res } = pair();
  assert.ok(res.ok); if (!res.ok) return;
  const keys = phone.finish(res.accept);
  assert.deepEqual(keys.clientKey, res.keys.clientKey); assert.deepEqual(keys.serverKey, res.keys.serverKey);
  assert.equal(keys.sas, res.keys.sas); assert.match(keys.sas, /^\d{6}$/);
  const phoneCh = new Channel(keys, pc.offer.sessionId, 'client'), pcCh = new Channel(res.keys, pc.offer.sessionId, 'server');
  assert.equal(pcCh.receive(phoneCh.send(Buffer.from('start scan'))).toString(), 'start scan');
  assert.equal(phoneCh.receive(pcCh.send(Buffer.from('{"stage":"cpu"}'))).toString(), '{"stage":"cpu"}');
});

test('the QR text carries only the session, the public key, the expiry, the one-time secret and transport hints: no device identity or health', () => {
  const pc = createOffer(NOW); const url = encodeOffer(pc.offer);
  assert.deepEqual([...new URL(url).searchParams.keys()].sort(), ['e', 'k', 'q', 's', 'v']);
  assert.ok(url.length < 260, 'small enough for a reliable QR');
  assert.throws(() => parseOffer('https://evil.example/pair?v=1'), /not a WorkCare/);
  assert.throws(() => parseOffer('workcare://pair?v=2&s=a&k=b&e=1&q=c'), /unsupported/);
  assert.throws(() => parseOffer('workcare://pair?v=1&s=AAAA&k=AAAA&e=1&q=AAAA'), /malformed/);
});

test('an expired, revoked or already-used session refuses a hello; one successful pairing consumes the session', () => {
  const pc = createOffer(NOW, { ttl: 60 }); const s = new PcSession(pc); const phone = makeHello(pc.offer);
  const late = s.hello(phone.hello, NOW + 60); assert.deepEqual(late, { ok: false, reason: 'expired' });
  const pc2 = createOffer(NOW); const s2 = new PcSession(pc2); s2.revoke();
  assert.deepEqual(s2.hello(makeHello(pc2.offer).hello, NOW), { ok: false, reason: 'expired' });
  const a = pair(); assert.ok(a.res.ok);
  assert.deepEqual(a.session.hello(makeHello(a.pc.offer).hello, NOW + 2), { ok: false, reason: 'used' }, 'a second phone cannot reuse a scanned code');
});

test('wrong secret: failed attempts are counted and the session locks after the limit, even for the right secret afterwards', () => {
  const pc = createOffer(NOW); const s = new PcSession(pc);
  const wrong = { ...pc.offer, secret: Buffer.alloc(16, 7) };
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) assert.deepEqual(s.hello(makeHello(wrong).hello, NOW), { ok: false, reason: 'bad_proof' });
  assert.deepEqual(s.hello(makeHello(pc.offer).hello, NOW), { ok: false, reason: 'locked' });
});

test('a phone is not fooled by a computer that lacks the pairing secret (mutual proof), and tampered or replayed frames are refused', () => {
  const pc = createOffer(NOW); const phone = makeHello(pc.offer);
  const impostor = new PcSession(createOffer(NOW, { sessionId: pc.offer.sessionId, secret: Buffer.alloc(16, 9) }));
  const fake = impostor.hello({ ...phone.hello, proof: Buffer.alloc(32) }, NOW); assert.equal(fake.ok, false);
  const { phone: p2, res, pc: pc2 } = pair(); assert.ok(res.ok); if (!res.ok) return;
  assert.throws(() => p2.finish({ nonceC: res.accept.nonceC, proof: Buffer.alloc(32, 1) }), /did not prove/);
  const keys = p2.finish(res.accept);
  const a = new Channel(keys, pc2.offer.sessionId, 'client'), b = new Channel(res.keys, pc2.offer.sessionId, 'server');
  const f1 = a.send(Buffer.from('one')), f2 = a.send(Buffer.from('two'));
  assert.equal(b.receive(f2).toString(), 'two');
  assert.throws(() => b.receive(f1), /replayed|out-of-order/, 'older counter after a newer one');
  assert.throws(() => b.receive(f2), /replayed|out-of-order/, 'same frame twice');
  const bad = Buffer.from(a.send(Buffer.from('three'))); bad[10] ^= 1;
  assert.throws(() => b.receive(bad));
  assert.throws(() => open(res.keys.serverKey, pc2.offer.sessionId, 's2c', f1), 'a client frame does not open as a server frame');
});

test('typed session codes: nine digits, deterministic secret, and the typed form is weaker than a QR so the authentication string is the safeguard', () => {
  const c = newCode(); assert.match(c, /^\d{3}-\d{3}-\d{3}$/);
  assert.deepEqual(secretFromCode('123-456-789'), secretFromCode('123456789'));
  assert.notDeepEqual(secretFromCode('123-456-789'), secretFromCode('123-456-780'));
  const pc = createOffer(NOW, { secret: secretFromCode('123-456-789') }); const s = new PcSession(pc);
  const phone = makeHello({ ...pc.offer, secret: secretFromCode('123-456-789') }); const r = s.hello(phone.hello, NOW); assert.ok(r.ok);
  if (r.ok) assert.equal(phone.finish(r.accept).sas, r.keys.sas);
});

test('the checked-in WCP1 conformance vectors are exactly what the reference implementation produces', () => {
  const p = join(packages, 'pairing-protocol', 'vectors.json');
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify(pairingVectors(), null, 2) + '\n', 'run "npx tsx scripts/twin-export.ts" in server/');
});
