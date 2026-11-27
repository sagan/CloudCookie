import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  decryptSlot,
  deriveKeys,
  encryptSlot,
  generateRootKey,
  isValidRootKey,
  signSyncRequest,
} from '../src/lib/crypto';

describe('CloudCookie v1 cryptography (PROTOCOL.md reference test vector)', () => {
  const K_ROOT = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const EXPECTED_CLIENT_ID =
    'efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e';
  const EXPECTED_K_ENC =
    '81d7dd656c9ed75994ce72f06f083e6891271f29c2221dfd844003118e1593b0';
  const NONCE_BYTES = utf8ToBytes('ABCDEFGHIJKLMNOPQRSTUVWX');
  const PLAINTEXT = '{"hello":"cloudcookie"}';
  const EXPECTED_ENCRYPTED =
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYmob7YcRaAVXTjoVMw1qdJkqG5yJ+18HiKUzRt4j2RMkePC2TNAN7';
  const EXPECTED_SIGNATURE =
    '5d1894a3d27d44072e859eef0c31f222bd032ed7576f0c76641c4717981c1facbf3c60ad4e5c36608bf44e8b476dd6e393f9d3d011d063de4d0e38855c86fc00';

  it('derives exact client_id and K_enc from K_root', () => {
    const keys = deriveKeys(K_ROOT);
    assert.equal(keys.clientId, EXPECTED_CLIENT_ID);
    assert.equal(bytesToHex(keys.kEnc), EXPECTED_K_ENC);
  });

  it('encrypts and decrypts matching the exact reference ciphertext', () => {
    const keys = deriveKeys(K_ROOT);
    const encrypted = encryptSlot(keys.kEnc, keys.clientId, 1, 1, PLAINTEXT, NONCE_BYTES);
    assert.equal(encrypted, EXPECTED_ENCRYPTED);

    const decrypted = decryptSlot(keys.kEnc, keys.clientId, 1, 1, encrypted);
    assert.equal(decrypted, PLAINTEXT);
  });

  it('produces the exact reference Ed25519 signature for update', () => {
    const keys = deriveKeys(K_ROOT);
    const sig = signSyncRequest({
      skAuth: keys.skAuth,
      action: 'update',
      clientId: keys.clientId,
      slot: 1,
      expectedVersion: 0,
      timestamp: 1700000000,
      nonce: '00112233445566778899aabbccddeeff',
      encryptedBase64: EXPECTED_ENCRYPTED,
    });
    assert.equal(sig, EXPECTED_SIGNATURE);
  });

  it('rejects decryption when AAD (slot, version, or clientId) does not match', () => {
    const keys = deriveKeys(K_ROOT);
    const encrypted = encryptSlot(keys.kEnc, keys.clientId, 2, 5, '{"ok":true}');

    assert.equal(decryptSlot(keys.kEnc, keys.clientId, 2, 5, encrypted), '{"ok":true}');
    assert.throws(() => decryptSlot(keys.kEnc, keys.clientId, 1, 5, encrypted));
    assert.throws(() => decryptSlot(keys.kEnc, keys.clientId, 2, 4, encrypted));
    assert.throws(() => decryptSlot(keys.kEnc, '0'.repeat(64), 2, 5, encrypted));
  });

  it('generates valid 256-bit hex root keys', () => {
    const key = generateRootKey();
    assert.equal(key.length, 64);
    assert.ok(isValidRootKey(key));
    assert.ok(!isValidRootKey('not-a-key'));
  });
});
