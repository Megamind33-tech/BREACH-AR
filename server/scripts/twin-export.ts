import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXPORTED, SCHEMA_VERSION } from '../src/twin/contracts.js';
import { RULES, RULESET_VERSION } from '../src/twin/rules.js';
import { PcSession, createOffer, encodeOffer, makeHello, secretFromCode, seal, b64u, PROTOCOL } from '../src/twin/pairing.js';
import { createHash } from 'node:crypto';

/** Writes the language-neutral artifacts the Kotlin (phone) and C# (QuickCheck) implementations are built and tested against. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages');
export function render(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(EXPORTED)) out[`contracts/schema/${name}.schema.json`] = JSON.stringify(z.toJSONSchema(schema), null, 2) + '\n';
  out['contracts/schema/VERSION.json'] = JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2) + '\n';
  out['health-rules/rules.json'] = JSON.stringify({ rulesetVersion: RULESET_VERSION, rules: RULES }, null, 2) + '\n';
  out['pairing-protocol/vectors.json'] = JSON.stringify(pairingVectors(), null, 2) + '\n';
  return out;
}

/** Fixed-input conformance vectors: every implementation of WCP1 must reproduce every value here. */
export function pairingVectors() {
  const h = (s: string) => createHash('sha256').update(s).digest();
  const hex = (b: Buffer) => b.toString('hex');
  const pcPriv = h('wcp1 test pc private'), phonePriv = h('wcp1 test phone private');
  const sessionId = h('wcp1 test session').subarray(0, 16), secret = h('wcp1 test secret').subarray(0, 16);
  const nonceP = h('wcp1 test nonce phone').subarray(0, 16), nonceC = h('wcp1 test nonce pc').subarray(0, 16);
  const expiresAt = 1790000600;
  const pc = createOffer(1790000000, { privateKey: pcPriv, sessionId, secret, hints: ['lan:192.168.1.20:47821'] });
  const phone = makeHello(pc.offer, { privateKey: phonePriv, nonce: nonceP });
  const res = new PcSession(pc).hello(phone.hello, 1790000001, nonceC);
  if (!res.ok) throw new Error('vector generation failed');
  const keys = phone.finish(res.accept);
  return {
    protocol: PROTOCOL, note: 'Fixed inputs and outputs for WCP1. Keys are P-256 scalars (hex). Frames: counter(8, big-endian) | ciphertext | tag(16).',
    inputs: { pcPrivateKey: hex(pcPriv), phonePrivateKey: hex(phonePriv), sessionId: hex(sessionId), secret: hex(secret), nonceP: hex(nonceP), nonceC: hex(nonceC), expiresAt, hints: pc.offer.hints },
    expected: {
      pcPublicKey: hex(pc.offer.pcPub), phonePublicKey: hex(phone.hello.phonePub), offerUrl: encodeOffer(pc.offer), helloProof: hex(phone.hello.proof), acceptProof: hex(res.accept.proof),
      clientKey: hex(keys.clientKey), serverKey: hex(keys.serverKey), sas: keys.sas,
      frameClientToServerCounter0: { plaintextUtf8: 'ping', frame: hex(seal(keys.clientKey, sessionId, 'c2s', 0n, Buffer.from('ping'))) },
      frameServerToClientCounter5: { plaintextUtf8: '{"ok":true}', frame: hex(seal(keys.serverKey, sessionId, 's2c', 5n, Buffer.from('{"ok":true}'))) },
      secretFromCode: { code: '123-456-789', secret: hex(secretFromCode('123-456-789')) },
    },
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [rel, text] of Object.entries(render())) { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); console.log('wrote', rel); }
}
