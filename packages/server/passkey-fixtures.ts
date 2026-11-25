/**
 * A software WebAuthn authenticator, for tests only.
 *
 * It is not a stub of the door's own code: it is the other half of the ceremony. The requests it
 * builds carry what a browser carries — a CBOR `attestationObject` with a real COSE key, an
 * `authData` buffer with the relying party's id hashed into it, a signature over `authData` plus the
 * SHA-256 of the decoded `clientDataJSON` — so better-auth's relying-party checks (origin, rpId hash,
 * challenge binding, the stored key, the counter) all run for real against it.
 *
 * `passkey-fixtures.ts` is imported by tests only. Its CBOR writer covers exactly what WebAuthn
 * structures need (integers, byte strings, text, arrays, maps, booleans, null), which is also why it
 * needs no dependency.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

export interface FixtureKey {
  /** What the browser holds: the credential's own id. */
  credentialId: Buffer;
  privateKey: KeyObject;
  /** The SPKI of the public key — what a door stores for an ES256 credential. */
  publicKeySpki: string;
  x: Buffer;
  y: Buffer;
}

export interface CeremonyOptions {
  rpId: string;
  origin: string;
  challenge: string;
}

const COSE_KTY_EC2 = 2;
const COSE_ALG_ES256 = -7;
const COSE_CRV_P256 = 1;

export function base64url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

export function unbase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function cborHead(major: number, argument: number): Buffer {
  const head = major << 5;
  if (argument < 24) return Buffer.from([head | argument]);
  if (argument < 0x100) return Buffer.from([head | 24, argument]);
  if (argument < 0x10000) {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(argument);
    return Buffer.concat([Buffer.from([head | 25]), length]);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(argument);
  return Buffer.concat([Buffer.from([head | 26]), length]);
}

function cborSigned(value: number): Buffer {
  // CBOR majors 0 and 1: the argument is the absolute value, the major says the sign.
  return value < 0 ? cborHead(1, -value - 1) : cborHead(0, value);
}

/** The subset of CBOR a WebAuthn authenticator emits. */
export function cborEncode(value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.from([0xf6]);
  if (typeof value === "boolean") return Buffer.from([value ? 0xf5 : 0xf4]);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`fixture CBOR cannot encode ${value}`);
    return cborSigned(value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cborEncode)]);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // A CBOR map keys may be integers (a COSE key does), and the order is insertion order.
    return Buffer.concat([
      cborHead(5, entries.length),
      // A COSE key is keyed by signed integers (-2 is the x coordinate), so an integer key — negative
      // included — is written as an integer and everything else as text.
      ...entries.flatMap(([key, item]) => [/^-?\d+$/.test(key.trim()) ? cborSigned(Number(key)) : cborEncode(key), cborEncode(item)]),
    ]);
  }
  throw new Error(`fixture CBOR cannot encode ${typeof value}`);
}

export function makeFixtureKey(): FixtureKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return {
    credentialId: randomBytes(16),
    privateKey,
    publicKeySpki: base64url(publicKey.export({ type: "spki", format: "der" })),
    x: unbase64url(jwk.x),
    y: unbase64url(jwk.y),
  };
}

function sha256(value: Buffer | string): Buffer {
  return createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest();
}

/** `authData` up to its attested part: rpIdHash, flags, counter. 0x45 = user-present, verified, attested. */
function authData(rpId: string, flags: number, counter: number): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter >>> 0);
  return Buffer.concat([sha256(rpId), Buffer.from([flags]), count]);
}

function clientData(type: string, challenge: string, origin: string): string {
  return base64url(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

/** The browser's `credential.toJSON()` for a registration: `none` attestation, the COSE key inside. */
export function registrationResponse(options: CeremonyOptions & { key: FixtureKey }): string {
  const { key, rpId, origin, challenge } = options;
  const coseKey = cborEncode({ 1: COSE_KTY_EC2, 3: COSE_ALG_ES256, [-1]: COSE_CRV_P256, [-2]: key.x, [-3]: key.y });
  // The attested part of `authData`, in the order a real authenticator writes it: an AAGUID (all zeros
  // for a software key, which is what this is), the credential id with its length in front, the COSE key.
  const length = Buffer.alloc(2);
  length.writeUInt16BE(key.credentialId.length);
  const attested = Buffer.concat([authData(rpId, 0x45, 0), Buffer.alloc(16), length, key.credentialId, coseKey]);
  const attestationObject = cborEncode({ fmt: "none", attStmt: {}, authData: attested });
  const raw = base64url(key.credentialId);
  return JSON.stringify({
    id: raw,
    rawId: raw,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: { clientDataJSON: clientData("webauthn.create", challenge, origin), attestationObject: base64url(attestationObject) },
    clientExtensionResults: {},
  });
}

/** The browser's `credential.toJSON()` for a sign-in: a signature over `authData` and the client data hash. */
export function assertionResponse(
  options: CeremonyOptions & { key: FixtureKey; credentialId?: string; counter?: number; userHandle?: string },
): string {
  const { key, rpId, origin, challenge } = options;
  const credentialId = options.credentialId ? unbase64url(options.credentialId) : key.credentialId;
  const data = authData(rpId, 0x05, options.counter ?? 1);
  const signed = Buffer.concat([data, sha256(unbase64url(clientData("webauthn.get", challenge, origin)))]);
  const signature = createSign("sha256").update(signed).sign({ key: key.privateKey, dsaEncoding: "der" });
  const raw = base64url(credentialId);
  return JSON.stringify({
    id: raw,
    rawId: raw,
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: clientData("webauthn.get", challenge, origin),
      authenticatorData: base64url(data),
      signature: base64url(signature),
      ...(options.userHandle ? { userHandle: options.userHandle } : {}),
    },
    clientExtensionResults: {},
  });
}
