import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { COSEALG, cose, isoCBOR } from '@simplewebauthn/server/helpers';

export function virtualPasskey(origin: string, handle: string) {
  const rpId = new URL(origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credential = randomBytes(32);
  const id = credential.toString('base64url');
  const { COSEKEYS, COSEKTY, COSECRV } = cose;
  const credentialPublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [COSEKEYS.kty, COSEKTY.EC2],
      [COSEKEYS.alg, COSEALG.ES256],
      [COSEKEYS.crv, COSECRV.P256],
      [COSEKEYS.x, Buffer.from(jwk.x!, 'base64url')],
      [COSEKEYS.y, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const rpHash = createHash('sha256').update(rpId).digest();
  const registrationAuthData = Buffer.concat([
    rpHash,
    Buffer.from([0x45, 0, 0, 0, 0]),
    Buffer.alloc(16),
    Buffer.from([0, credential.length]),
    credential,
    credentialPublicKey,
  ]);
  const attestationObject = isoCBOR.encode(
    new Map<string, string | Map<never, never> | Uint8Array>([
      ['fmt', 'none'],
      ['attStmt', new Map<never, never>()],
      ['authData', registrationAuthData],
    ]),
  );
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const registration = (challenge: string) => ({
    name: 'Test authenticator',
    response: {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientData('webauthn.create', challenge).toString('base64url'),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
      },
      clientExtensionResults: { credProps: { rk: true } },
    },
  });
  function assertion(challenge: string) {
    const assertionAuthData = Buffer.concat([rpHash, Buffer.from([0x05, 0, 0, 0, 1])]);
    const assertionClientData = clientData('webauthn.get', challenge);
    const sig = sign(
      'sha256',
      Buffer.concat([assertionAuthData, createHash('sha256').update(assertionClientData).digest()]),
      privateKey,
    );
    return {
      response: {
        id,
        rawId: id,
        type: 'public-key' as const,
        response: {
          clientDataJSON: assertionClientData.toString('base64url'),
          authenticatorData: assertionAuthData.toString('base64url'),
          signature: sig.toString('base64url'),
          userHandle: handle,
        },
        clientExtensionResults: {},
      },
    };
  }
  return { id, registration, assertion };
}
