import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type CredentialDeviceType,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import {
  COSEALG,
  cose,
  decodeAttestationObject,
  decodeCredentialPublicKey,
  decodeClientDataJSON,
  isoCBOR,
} from '@simplewebauthn/server/helpers';
import { z } from 'zod';
import { digest, equal } from './security.js';

const { passkeyNameMaxLength, passkeyNamePattern } = (await import(
  import.meta.url.endsWith('.ts') ? '../../shared/passkey-name.mjs' : './passkey-name.mjs'
)) as typeof import('../../shared/passkey-name.mjs');

const algorithmIDs = [COSEALG.ES256, COSEALG.RS256];
const ceremonyTimeout = 90_000;
export const passkeyBodyLimit = 32 * 1024;

function base64url(maxBytes: number) {
  return z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
}
export const passkeyId = base64url(1023);
export const passkeyName = z
  .string()
  .trim()
  .min(1)
  .max(passkeyNameMaxLength)
  .regex(passkeyNamePattern);
const clientDataJSON = base64url(4096);
const publicCredential = {
  id: passkeyId,
  rawId: passkeyId,
  type: z.literal('public-key'),
};
export const registrationBody = z.strictObject({
  name: passkeyName,
  response: z.object({
    ...publicCredential,
    response: z.object({ clientDataJSON, attestationObject: base64url(8192) }),
    clientExtensionResults: z.object({
      credProps: z.object({ rk: z.boolean().optional() }).optional(),
    }),
  }),
});
export const assertionBody = z.strictObject({
  response: z.object({
    ...publicCredential,
    response: z.object({
      clientDataJSON,
      authenticatorData: base64url(4096),
      signature: base64url(1024),
      userHandle: base64url(64)
        .nullish()
        .transform((value) => value ?? undefined),
    }),
    clientExtensionResults: z.object({}),
  }),
});

// Run unknown credentials through the same verifier. This P-256 point is public
// and the caller must still find a stored credential before granting access.
const { COSEKEYS, COSEKTY, COSECRV } = cose;
function permittedPublicKey(encoded: WebAuthnCredential['publicKey']) {
  const key = decodeCredentialPublicKey(encoded);
  if (cose.isCOSEPublicKeyEC2(key)) {
    const x = key.get(COSEKEYS.x),
      y = key.get(COSEKEYS.y);
    return (
      key.get(COSEKEYS.alg) === COSEALG.ES256 &&
      key.get(COSEKEYS.crv) === COSECRV.P256 &&
      x instanceof Uint8Array &&
      x.byteLength === 32 &&
      y instanceof Uint8Array &&
      y.byteLength === 32
    );
  }
  if (!cose.isCOSEPublicKeyRSA(key) || key.get(COSEKEYS.alg) !== COSEALG.RS256) return false;
  const modulus = key.get(COSEKEYS.n);
  const exponent = key.get(COSEKEYS.e);
  return (
    modulus instanceof Uint8Array &&
    modulus.length >= 256 &&
    modulus.length <= 512 &&
    modulus[0] >= 128 &&
    exponent instanceof Uint8Array &&
    Buffer.from(exponent).equals(Buffer.from([1, 0, 1]))
  );
}
const dummyPublicKey = isoCBOR.encode(
  new Map<number, number | Uint8Array>([
    [COSEKEYS.kty, COSEKTY.EC2],
    [COSEKEYS.alg, COSEALG.ES256],
    [COSEKEYS.crv, COSECRV.P256],
    [
      COSEKEYS.x,
      Buffer.from('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296', 'hex'),
    ],
    [
      COSEKEYS.y,
      Buffer.from('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex'),
    ],
  ]),
);

const firstParty = (clientData: string) => {
  const { crossOrigin, topOrigin } = decodeClientDataJSON(clientData);
  return (crossOrigin === undefined || crossOrigin === false) && topOrigin === undefined;
};
const challengeMatches = (hash: string) => (challenge: string) =>
  typeof challenge === 'string' && equal(hash, digest(challenge));

export function passkeyCeremonies(appUrl: string) {
  const origin = new URL(appUrl);
  const rpID = origin.hostname;
  const rp = { expectedOrigin: origin.origin, expectedRPID: rpID };
  return {
    registrationOptions(
      username: string,
      handle: string,
      excludeCredentials: { id: string }[],
      challenge?: Uint8Array<ArrayBuffer>,
    ) {
      return generateRegistrationOptions({
        rpName: 'cswatch',
        rpID,
        userID: Buffer.from(handle, 'hex'),
        userName: username,
        userDisplayName: username,
        challenge,
        timeout: ceremonyTimeout,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { credProps: true },
        excludeCredentials,
        supportedAlgorithmIDs: algorithmIDs,
      });
    },
    assertionOptions(allowCredentials?: { id: string }[], challenge?: Uint8Array<ArrayBuffer>) {
      return generateAuthenticationOptions({
        rpID,
        challenge,
        timeout: ceremonyTimeout,
        userVerification: 'required',
        allowCredentials,
      });
    },
    async register(response: z.output<typeof registrationBody>['response'], challengeHash: string) {
      try {
        if (
          !firstParty(response.response.clientDataJSON) ||
          response.clientExtensionResults.credProps?.rk === false
        )
          return null;
        // The instance requests no manufacturer attestation. Only this format
        // reaches the verifier, including when an arbitrary client posts data.
        const attestation = decodeAttestationObject(
          Buffer.from(response.response.attestationObject, 'base64url'),
        );
        if (!(attestation instanceof Map) || attestation.get('fmt') !== 'none') return null;
        const statement = attestation.get('attStmt');
        if (!(statement instanceof Map) || statement.size !== 0) return null;
        const result = await verifyRegistrationResponse({
          ...rp,
          response,
          expectedChallenge: challengeMatches(challengeHash),
          expectedType: 'webauthn.create',
          requireUserPresence: true,
          requireUserVerification: true,
          supportedAlgorithmIDs: algorithmIDs,
        });
        if (!result.verified || !result.registrationInfo.userVerified) return null;
        const info = result.registrationInfo;
        if (
          info.credential.id !== response.id ||
          info.credential.publicKey.length > 640 ||
          !permittedPublicKey(info.credential.publicKey)
        )
          return null;
        return {
          credential: info.credential,
          credentialDeviceType: info.credentialDeviceType,
          credentialBackedUp: info.credentialBackedUp,
        };
      } catch {
        return null;
      }
    },
    async verify(
      response: z.output<typeof assertionBody>['response'],
      challengeHash: string,
      credential?: WebAuthnCredential & { deviceType: CredentialDeviceType },
    ) {
      try {
        if (!firstParty(response.response.clientDataJSON)) return null;
        const result = await verifyAuthenticationResponse({
          ...rp,
          response,
          expectedChallenge: challengeMatches(challengeHash),
          expectedType: 'webauthn.get',
          requireUserVerification: true,
          credential: credential ?? { id: response.id, publicKey: dummyPublicKey, counter: 0 },
        });
        const info = result.authenticationInfo;
        if (
          !credential ||
          !result.verified ||
          !info.userVerified ||
          info.credentialDeviceType !== credential.deviceType
        )
          return null;
        return info;
      } catch {
        return null;
      }
    },
  };
}
