import test from 'node:test';
import assert from 'node:assert/strict';
import {
  str, email, date, time, oneOf, id, checkPassword, hashPassword, verifyPassword,
  timingSafeEqual, addDays, todayIL, PROCESSES, LEAD_STAGES, ValidationError,
} from '../src/lib.js';

test('str trims, enforces required and max length', () => {
  assert.equal(str('  שלום ', 'x'), 'שלום');
  assert.equal(str(undefined, 'x'), '');
  assert.throws(() => str('', 'x', { required: true }), ValidationError);
  assert.throws(() => str('a'.repeat(11), 'x', { max: 10 }), ValidationError);
  assert.throws(() => str({}, 'x'), ValidationError);
});

test('email validates and lower-cases', () => {
  assert.equal(email(' Michael@Example.CO.IL '), 'michael@example.co.il');
  assert.equal(email(''), '');
  assert.throws(() => email('not-an-email'), ValidationError);
  assert.throws(() => email('', 'אימייל', { required: true }), ValidationError);
});

test('date and time formats', () => {
  assert.equal(date('2026-11-15', 'd'), '2026-11-15');
  assert.equal(date('', 'd'), null);
  assert.throws(() => date('15/11/2026', 'd'), ValidationError);
  assert.equal(time('09:30', 't'), '09:30');
  assert.equal(time('', 't'), null);
  assert.throws(() => time('25:00', 't'), ValidationError);
});

test('oneOf and id', () => {
  assert.equal(oneOf('lead', 'k', ['lead', 'client']), 'lead');
  assert.throws(() => oneOf('x', 'k', ['lead']), ValidationError);
  assert.equal(id('12', 'i'), 12);
  assert.equal(id('', 'i', { required: false }), null);
  assert.throws(() => id('-1', 'i'), ValidationError);
  assert.throws(() => id('1.5', 'i'), ValidationError);
});

test('password rules and hashing round trip', async () => {
  assert.throws(() => checkPassword('short'), ValidationError);
  assert.equal(checkPassword('a-long-password'), 'a-long-password');
  const stored = await hashPassword('a-long-password', 1000);
  assert.match(stored, /^pbkdf2\$1000\$/);
  assert.equal(await verifyPassword('a-long-password', stored), true);
  assert.equal(await verifyPassword('wrong-password', stored), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  const again = await hashPassword('a-long-password', 1000);
  assert.notEqual(stored, again, 'salt must differ between hashes');
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('dates in Israel time', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  // 22:30 UTC on Nov 12 is already Nov 13 in Israel (UTC+2).
  assert.equal(todayIL(new Date('2026-11-12T22:30:00Z')), '2026-11-13');
});

test('process templates are well formed', () => {
  for (const [key, p] of Object.entries(PROCESSES)) {
    assert.ok(p.label && p.area, key);
    assert.ok(p.steps.length >= 2, key);
    for (const s of p.steps) {
      assert.ok(s.label, key);
      assert.ok(Array.isArray(s.tasks), key);
      for (const t of s.tasks) assert.ok(t.length <= 200, key);
    }
  }
  assert.ok(PROCESSES.general);
  assert.ok(LEAD_STAGES.some((s) => s.key === 'signed'));
});
