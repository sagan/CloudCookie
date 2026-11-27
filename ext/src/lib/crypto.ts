import * as ed25519 from '@noble/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { ecb, gcm } from '@noble/ciphers/aes.js';
import type { SyncAction } from './types';

// Enable synchronous Ed25519 in @noble/ed25519 v3
ed25519.hashes.sha512 = sha512;

const HKDF_SALT = utf8ToBytes('cloudcookie-v1');
const HKDF_INFO_AUTH = utf8ToBytes('client-auth-ed25519');
const HKDF_INFO_ENC = utf8ToBytes('e2e-xaes256gcm');
const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface DerivedKeys {
  skAuth: Uint8Array;
  pkAuth: Uint8Array;
  clientId: string;
  kEnc: Uint8Array;
}

export function isValidRootKey(hex: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(hex.trim());
}

export function normalizeRootKey(hex: string): string {
  return hex.trim().toLowerCase();
}

export function generateRootKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function generateRequestNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function deriveKeys(rootKeyHex: string): DerivedKeys {
  const normalized = normalizeRootKey(rootKeyHex);
  if (!isValidRootKey(normalized)) {
    throw new Error('Root key must be 64 hexadecimal characters (256 bits)');
  }
  const ikm = hexToBytes(normalized);
  const skAuth = hkdf(sha256, ikm, HKDF_SALT, HKDF_INFO_AUTH, 32);
  const pkAuth = ed25519.getPublicKey(skAuth);
  const clientId = bytesToHex(pkAuth);
  const kEnc = hkdf(sha256, ikm, HKDF_SALT, HKDF_INFO_ENC, 32);

  return { skAuth, pkAuth, clientId, kEnc };
}

export function buildAad(clientId: string, slot: number, version: number): Uint8Array {
  return utf8ToBytes(`cloudcookie-v1:${clientId}:${slot}:${version}`);
}

function cmacSubkey(l: Uint8Array): Uint8Array {
  const k1 = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const b = l[i] ?? 0;
    k1[i] = ((b << 1) | carry) & 0xff;
    carry = (b >>> 7) & 1;
  }
  if (carry) {
    k1[15] = (k1[15] ?? 0) ^ 0x87;
  }
  return k1;
}

function xor16(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return out;
}

function deriveXaesKey(kEnc: Uint8Array, n1: Uint8Array): Uint8Array {
  const l = ecb(kEnc, { disablePadding: true }).encrypt(new Uint8Array(16));
  const k1 = cmacSubkey(l);

  const m1 = new Uint8Array(16);
  m1[0] = 0x00;
  m1[1] = 0x01;
  m1[2] = 0x58; // 'X'
  m1[3] = 0x00;
  m1.set(n1, 4);

  const m2 = new Uint8Array(16);
  m2[0] = 0x00;
  m2[1] = 0x02;
  m2[2] = 0x58; // 'X'
  m2[3] = 0x00;
  m2.set(n1, 4);

  const kx1 = ecb(kEnc, { disablePadding: true }).encrypt(xor16(m1, k1));
  const kx2 = ecb(kEnc, { disablePadding: true }).encrypt(xor16(m2, k1));
  return concatBytes(kx1, kx2);
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encryptSlot(
  kEnc: Uint8Array,
  clientId: string,
  slot: number,
  version: number,
  plaintextUtf8: string,
  nonceOverride?: Uint8Array,
): string {
  const nonce = nonceOverride ? new Uint8Array(nonceOverride) : new Uint8Array(24);
  if (!nonceOverride) {
    crypto.getRandomValues(nonce);
  }
  if (nonce.length !== 24) {
    throw new Error('XAES-256-GCM nonce must be 24 bytes');
  }

  const n1 = nonce.subarray(0, 12);
  const n2 = nonce.subarray(12, 24);
  const kx = deriveXaesKey(kEnc, n1);
  const aad = buildAad(clientId, slot, version);
  const plaintext = utf8ToBytes(plaintextUtf8);

  const ciphertextAndTag = gcm(kx, n2, aad).encrypt(plaintext);
  return base64Encode(concatBytes(nonce, ciphertextAndTag));
}

export function decryptSlot(
  kEnc: Uint8Array,
  clientId: string,
  slot: number,
  version: number,
  encryptedBase64: string,
): string {
  const raw = base64Decode(encryptedBase64);
  if (raw.length < 40) {
    throw new Error('Encrypted payload is too short (minimum 40 bytes)');
  }
  const nonce = raw.subarray(0, 24);
  const ciphertextAndTag = raw.subarray(24);
  const n1 = nonce.subarray(0, 12);
  const n2 = nonce.subarray(12, 24);
  const kx = deriveXaesKey(kEnc, n1);
  const aad = buildAad(clientId, slot, version);

  const plaintext = gcm(kx, n2, aad).decrypt(ciphertextAndTag);
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
}

export function signSyncRequest(params: {
  skAuth: Uint8Array;
  action: SyncAction;
  clientId: string;
  slot: number | 'all' | '-';
  expectedVersion?: number;
  timestamp: number;
  nonce: string;
  encryptedBase64?: string;
}): string {
  const slotStr = String(params.slot);
  const expectedVersionStr =
    params.action === 'update' && params.expectedVersion !== undefined
      ? String(params.expectedVersion)
      : '-';
  const payloadHashHex =
    params.action === 'update' && params.encryptedBase64 !== undefined
      ? bytesToHex(sha256(utf8ToBytes(params.encryptedBase64)))
      : EMPTY_SHA256_HEX;

  const message = `cloudcookie-v1:${params.action}:${params.clientId}:${slotStr}:${expectedVersionStr}:${params.timestamp}:${params.nonce}:${payloadHashHex}`;
  const sig = ed25519.sign(utf8ToBytes(message), params.skAuth);
  return bytesToHex(sig);
}
