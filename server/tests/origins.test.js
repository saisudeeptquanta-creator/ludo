/**
 * Origin policy.
 *
 * Regression guard for two production-only failures found by running the built
 * app the way a host runs it:
 *
 *  1. Applying CORS globally gated the app's own JS/CSS, so every asset 403'd
 *     and the page rendered blank.
 *  2. Browsers send an Origin header on same-origin WebSocket upgrades, so the
 *     deployment rejected its own socket with a 400 and never came online.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'production';
process.env.CORS_ORIGINS = '';

const { isOriginAllowed } = await import('../src/utils/origins.js');

test('a same-origin request is allowed even with an empty allow list', () => {
  // This is the normal production case: the server serves its own client.
  assert.ok(isOriginAllowed('https://ludo.example.com', 'ludo.example.com'));
  assert.ok(isOriginAllowed('http://localhost:4000', 'localhost:4000'));
});

test('a cross-origin request is still refused in production', () => {
  assert.ok(!isOriginAllowed('https://evil.example.com', 'ludo.example.com'));
  assert.ok(!isOriginAllowed('http://localhost:5173', 'ludo.example.com'));
});

test('requests with no Origin header are allowed', () => {
  // curl, health checks and server-to-server calls send none.
  assert.ok(isOriginAllowed(undefined, 'ludo.example.com'));
  assert.ok(isOriginAllowed('', 'ludo.example.com'));
});

test('a malformed Origin is refused rather than throwing', () => {
  assert.ok(!isOriginAllowed('not-a-url', 'ludo.example.com'));
  assert.ok(!isOriginAllowed('javascript:alert(1)', 'ludo.example.com'));
});

test('a separately hosted client is allowed via CORS_ORIGINS', async () => {
  // The allow list is read once at import, so this uses a child process with a
  // different environment rather than trying to re-import the module.
  const { execFileSync } = await import('node:child_process');
  const script = `
    const { isOriginAllowed } = await import('./src/utils/origins.js');
    console.log(JSON.stringify({
      configured: isOriginAllowed('https://cdn.example.com', 'api.example.com'),
      other: isOriginAllowed('https://other.example.com', 'api.example.com'),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, NODE_ENV: 'production', CORS_ORIGINS: 'https://cdn.example.com' },
    encoding: 'utf8',
  });
  const result = JSON.parse(out.trim().split('\n').pop());

  assert.equal(result.configured, true, 'a configured origin must be allowed');
  assert.equal(result.other, false, 'an unlisted cross-origin must still be refused');
});
