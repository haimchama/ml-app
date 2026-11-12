import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrom, header, decodeBase64Url, extractText, htmlToText, attachmentNames, authUrl } from '../src/gmail.js';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('parseFrom handles names, quotes and bare addresses', () => {
  assert.deepEqual(parseFrom('"דנה כהן" <Dana@Example.co.il>'), { name: 'דנה כהן', email: 'dana@example.co.il' });
  assert.deepEqual(parseFrom('Dana <dana@x.co>'), { name: 'Dana', email: 'dana@x.co' });
  assert.deepEqual(parseFrom('dana@x.co'), { name: '', email: 'dana@x.co' });
  assert.deepEqual(parseFrom(''), { name: '', email: '' });
});

test('header lookup is case-insensitive', () => {
  assert.equal(header([{ name: 'subject', value: 'שלום' }], 'Subject'), 'שלום');
  assert.equal(header([], 'From'), '');
});

test('base64url decoding keeps Hebrew', () => {
  assert.equal(decodeBase64Url(b64url('שלום עולם – בדיקה')), 'שלום עולם – בדיקה');
});

test('extractText prefers text/plain, falls back to html, skips attachments', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64url('שלום,\r\nמצורף ההסכם.') } },
      { mimeType: 'text/html', body: { data: b64url('<p>שלום</p>') } },
    ] },
    { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('attachment text') } },
    { mimeType: 'application/pdf', filename: 'הסכם.pdf', body: { attachmentId: 'x' } },
  ] };
  assert.equal(extractText(payload), 'שלום,\nמצורף ההסכם.');
  assert.deepEqual(attachmentNames(payload), ['notes.txt', 'הסכם.pdf']);
  const htmlOnly = { mimeType: 'text/html', body: { data: b64url('<style>x{}</style><p>שורה 1</p><p>שורה&nbsp;2 &amp; עוד</p><script>alert(1)</script>') } };
  assert.equal(extractText(htmlOnly), 'שורה 1\nשורה 2 & עוד');
  assert.equal(htmlToText('<b>a</b><br>b'), 'a\nb');
});

test('auth URL asks for read-only Gmail, offline access and carries state', () => {
  const u = new URL(authUrl('abc.apps.googleusercontent.com', 'https://ml.tkb-pro.com/api/gmail/callback', 'st8'));
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('state'), 'st8');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://ml.tkb-pro.com/api/gmail/callback');
});
