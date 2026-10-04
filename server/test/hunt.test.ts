import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JOB_TYPES } from '../src/jobs.js';

test('quarantining a start-up file is an administrator action that needs explicit approval and a plain file name, never a path', () => {
  const q = JOB_TYPES['startup.quarantine']!; assert.equal(q.role, 'admin');
  assert.equal(q.params.safeParse({ name: 'bad.bat', approved: true }).success, true);
  assert.equal(q.params.safeParse({ name: 'bad.bat' }).success, false, 'no approval, no quarantine');
  assert.equal(q.params.safeParse({ name: 'bad.bat', approved: false }).success, false);
  for (const name of ['C:\\x\\bad.bat', '..\\bad.bat', 'a/b.bat', 'bad:stream.bat', 'a*.bat']) assert.equal(q.params.safeParse({ name, approved: true }).success, false, name);
  assert.equal(q.params.safeParse({ name: 'bad.bat', approved: true, path: 'C:\\Windows' }).success, false, 'no extra fields');
});
test('restore needs approval and a quarantine id; the hunt and the file inspection are read-only technician jobs', () => {
  const r = JOB_TYPES['startup.restore']!; assert.equal(r.role, 'admin');
  assert.equal(r.params.safeParse({ id: '20261002081530-252769ab-1', approved: true }).success, true); assert.equal(r.params.safeParse({ id: '..\\..\\x', approved: true }).success, false); assert.equal(r.params.safeParse({ id: '20261002081530-252769ab-1' }).success, false);
  for (const t of ['persistence.hunt', 'startup.inspect']) { assert.equal(JOB_TYPES[t]!.role, 'technician'); assert.match(JOB_TYPES[t]!.description, /read-only|Read-only|changes nothing|Changes nothing/i); }
});
