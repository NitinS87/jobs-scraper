const test = require('node:test');
const assert = require('node:assert');

const { isChallengeResponse } = require('../lib/scraperUtils');

// Headers as served by jobsinjapan.com on 2026-10-28 (curl -D), trimmed.
const CF_CHALLENGE = { server: 'cloudflare', 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=UTF-8' };

test('a Cloudflare managed challenge is recognised from the response alone', () => {
  assert.equal(isChallengeResponse(403, CF_CHALLENGE), true);
});

test('header names are case-insensitive, as on the wire', () => {
  assert.equal(isChallengeResponse(403, { 'CF-Mitigated': 'challenge' }), true);
});

test('an ordinary 200 or a plain 403 is not a challenge', () => {
  assert.equal(isChallengeResponse(200, { server: 'cloudflare' }), false);
  assert.equal(isChallengeResponse(403, { server: 'nginx' }), false);
  assert.equal(isChallengeResponse(403, {}), false);
  assert.equal(isChallengeResponse(403, undefined), false);
});
