import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { digest } from '../src/security.js';
import { acceptedTotpStep, base32 } from '../src/totp.js';
import { assertionBody, passkeyCeremonies, registrationBody } from '../src/webauthn.js';
import { virtualPasskey } from './fixtures/virtual-passkey.js';

test('TOTP follows RFC 6238 SHA-1 vectors, preserves leading zeroes and spends each step once', () => {
  const seed = Buffer.from('12345678901234567890');
  assert.equal(base32(seed), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const vectors: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [time, code] of vectors) {
    const step = Math.floor(time / 30);
    for (const drift of [-30, 0, 30])
      assert.equal(acceptedTotpStep(seed, code, time + drift, -1), step);
    assert.equal(acceptedTotpStep(seed, code, time + 60, -1), null);
    assert.equal(acceptedTotpStep(seed, code, time, step), null);
  }
});

test('a discoverable ES256 passkey registers and authenticates for the configured HTTPS origin', async () => {
  const origin = 'https://replays.example.test:8443';
  const rpId = 'replays.example.test';
  const webauthn = passkeyCeremonies(origin);
  const handle = randomBytes(16);
  const registration = await webauthn.registrationOptions('fixture', handle.toString('hex'), []);
  assert.equal(registration.rp.id, rpId);
  assert.equal(registration.user.id, handle.toString('base64url'));
  assert.equal(registration.authenticatorSelection?.residentKey, 'required');
  assert.equal(registration.authenticatorSelection?.userVerification, 'required');
  assert.deepEqual(
    registration.pubKeyCredParams.map(({ alg }) => alg),
    [-7, -257],
  );
  assert.equal(registration.attestation, 'none');

  const key = virtualPasskey(origin, registration.user.id);
  const registrationResponse = registrationBody.parse(key.registration(registration.challenge));
  const stored = await webauthn.register(
    registrationResponse.response,
    digest(registration.challenge),
  );
  assert.ok(stored);
  assert.equal(stored.credential.id, key.id);
  assert.equal(stored.credential.counter, 0);
  assert.equal(stored.credentialDeviceType, 'singleDevice');

  const assertion = await webauthn.assertionOptions();
  assert.equal(assertion.rpId, rpId);
  assert.equal(assertion.userVerification, 'required');
  assert.equal(assertion.allowCredentials, undefined);
  const assertionResponse = assertionBody.parse(key.assertion(assertion.challenge));
  const credentialState = { ...stored.credential, deviceType: stored.credentialDeviceType };
  const info = await webauthn.verify(
    assertionResponse.response,
    digest(assertion.challenge),
    credentialState,
  );
  assert.equal(info?.credentialID, key.id);
  assert.equal(info?.newCounter, 1);
  assert.equal(info?.userVerified, true);
  // The same genuine assertion belongs to exactly one challenge, origin, public key and counter state.
  assert.equal(
    await webauthn.verify(
      assertionResponse.response,
      digest(registration.challenge),
      credentialState,
    ),
    null,
  );
  assert.equal(
    await passkeyCeremonies('https://other.example.test').verify(
      assertionResponse.response,
      digest(assertion.challenge),
      credentialState,
    ),
    null,
  );
  assert.equal(
    await webauthn.verify(assertionResponse.response, digest(assertion.challenge), {
      ...credentialState,
      counter: 1,
    }),
    null,
  );
  assert.equal(
    await webauthn.verify(assertionResponse.response, digest(assertion.challenge), {
      ...credentialState,
      deviceType: 'multiDevice',
    }),
    null,
  );
});
