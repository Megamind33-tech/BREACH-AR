import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('the platform console is a separate page: its script parses, it shares nothing with the organization console, and typed text is escaped', () => {
  const html = readFileSync(join(pub, 'platform.html'), 'utf8');
  const script = html.split('<script>')[1]!.split('</script>')[0]!;
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /const esc = /);
  assert.doesNotMatch(html, /index\.html|views-|app\.js/);
  // every field a person can type (names, emails, reasons, roles) goes through esc() before it reaches the page
  const risky = /\$\{[a-z]+\.(email|name|owner_email|suspended_reason|org_name|actor_id|plan|role)\}/g;
  assert.deepEqual([...script.matchAll(risky)].map(m => m[0]), []);
});
