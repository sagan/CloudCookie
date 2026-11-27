import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, CloudCookieClient, type SlotVersionStore } from '../src/lib/api';
import { deriveKeys, encryptSlot } from '../src/lib/crypto';

const TEST_ROOT_KEY_A = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_ROOT_KEY_B = 'ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function createMemoryVersionStore(): SlotVersionStore {
  const map = new Map<string, number>();
  return {
    async getHighestVersion(serverUrl: string, clientId: string, slot: number): Promise<number> {
      return map.get(`${serverUrl}|${clientId}:${slot}`) ?? 0;
    },
    async setHighestVersion(
      serverUrl: string,
      clientId: string,
      slot: number,
      version: number,
    ): Promise<void> {
      const key = `${serverUrl}|${clientId}:${slot}`;
      const prev = map.get(key) ?? 0;
      if (version > prev) {
        map.set(key, version);
      }
    },
  };
}

function withMockFetch<T>(
  handler: (body: Record<string, unknown>) => Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const reqBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const resBody = handler(reqBody);
    return new Response(JSON.stringify(resBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

describe('CloudCookieClient rollback protection', () => {
  it('rejects lower version on getSlot for data slots and slot 0', async () => {
    const store = createMemoryVersionStore();
    const client = new CloudCookieClient('https://example.com', TEST_ROOT_KEY_A, store);
    const keys = deriveKeys(TEST_ROOT_KEY_A);

    const encV3 = encryptSlot(keys.kEnc, keys.clientId, 1, 3, JSON.stringify({ cookies: { 'a.com': [] } }));
    const encV2 = encryptSlot(keys.kEnc, keys.clientId, 1, 2, JSON.stringify({ cookies: { 'old.com': [] } }));

    let servedVersion = 3;
    await withMockFetch(
      (req) => ({
        ok: true,
        action: 'get',
        client_id: req.client_id,
        slot: req.slot,
        version: servedVersion,
        updated_at: '2026-01-01T00:00:00Z',
        encrypted: servedVersion === 3 ? encV3 : encV2,
      }),
      async () => {
        const first = await client.getSlot<{ cookies: Record<string, unknown> }>(1);
        assert.equal(first.version, 3);
        assert.equal(await client.getHighestSeenVersion(1), 3);

        // Server rolls back to valid (ciphertext, version=2) pair
        servedVersion = 2;
        await assert.rejects(
          () => client.getSlot(1),
          (err: unknown) => err instanceof ApiError && err.code === 'rollback_detected',
        );
      },
    );

    // Also verify slot 0 rollback protection
    const slot0V2 = encryptSlot(keys.kEnc, keys.clientId, 0, 2, JSON.stringify({ schema_version: 1, updated_at: 2, slots: {} }));
    const slot0V1 = encryptSlot(keys.kEnc, keys.clientId, 0, 1, JSON.stringify({ schema_version: 1, updated_at: 1, slots: {} }));
    let slot0Ver = 2;
    await withMockFetch(
      (req) => ({
        ok: true,
        action: 'get',
        client_id: req.client_id,
        slot: req.slot,
        version: slot0Ver,
        updated_at: '2026-01-01T00:00:00Z',
        encrypted: slot0Ver === 2 ? slot0V2 : slot0V1,
      }),
      async () => {
        const res = await client.getSlot(0);
        assert.equal(res.version, 2);

        slot0Ver = 1;
        await assert.rejects(
          () => client.getSlot(0),
          (err: unknown) => err instanceof ApiError && err.code === 'rollback_detected',
        );
      },
    );
  });

  it('tracks highest seen version per client_id independently', async () => {
    const store = createMemoryVersionStore();
    const clientA = new CloudCookieClient('https://example.com', TEST_ROOT_KEY_A, store);
    const clientB = new CloudCookieClient('https://example.com', TEST_ROOT_KEY_B, store);
    const keysA = deriveKeys(TEST_ROOT_KEY_A);
    const keysB = deriveKeys(TEST_ROOT_KEY_B);

    await withMockFetch(
      (req) => {
        const cid = String(req.client_id);
        const kEnc = cid === keysA.clientId ? keysA.kEnc : keysB.kEnc;
        const ver = cid === keysA.clientId ? 5 : 1;
        return {
          ok: true,
          action: 'get',
          client_id: cid,
          slot: 1,
          version: ver,
          updated_at: '2026-01-01T00:00:00Z',
          encrypted: encryptSlot(kEnc, cid, 1, ver, JSON.stringify({ ok: true })),
        };
      },
      async () => {
        assert.equal((await clientA.getSlot(1)).version, 5);
        assert.equal((await clientB.getSlot(1)).version, 1);
      },
    );
  });

  it('records version on updateSlot and rejects updates with expectedVersion < highestSeen', async () => {
    const store = createMemoryVersionStore();
    const client = new CloudCookieClient('https://example.com', TEST_ROOT_KEY_A, store);

    await withMockFetch(
      (req) => ({
        ok: true,
        action: 'update',
        slot: req.slot,
        version: Number(req.expected_version) + 1,
        updated_at: '2026-01-01T00:00:00Z',
      }),
      async () => {
        const res = await client.updateSlot(1, 0, { hello: 'world' });
        assert.equal(res.version, 1);
        assert.equal(await client.getHighestSeenVersion(1), 1);

        await assert.rejects(
          () => client.updateSlot(1, 0, { hello: 'stale' }),
          (err: unknown) => err instanceof ApiError && err.code === 'rollback_detected',
        );
      },
    );
  });

  it('tracks highest seen version per serverUrl independently for the same client_id', async () => {
    const store = createMemoryVersionStore();
    const clientServerA = new CloudCookieClient('https://server-a.example.com', TEST_ROOT_KEY_A, store);
    const clientServerB = new CloudCookieClient('https://server-b.example.com', TEST_ROOT_KEY_A, store);
    const keys = deriveKeys(TEST_ROOT_KEY_A);

    await withMockFetch(
      (req) => ({
        ok: true,
        action: 'get',
        client_id: req.client_id,
        slot: 0,
        version: 4,
        updated_at: '2026-01-01T00:00:00Z',
        encrypted: encryptSlot(keys.kEnc, keys.clientId, 0, 4, JSON.stringify({ schema_version: 1, updated_at: 4, slots: {} })),
      }),
      async () => {
        const resA = await clientServerA.getSlot(0);
        assert.equal(resA.version, 4);
        assert.equal(await clientServerA.getHighestSeenVersion(0), 4);
        assert.equal(await clientServerB.getHighestSeenVersion(0), 0);
      },
    );

    await withMockFetch(
      (req) => ({
        ok: true,
        action: 'get',
        client_id: req.client_id,
        slot: 0,
        version: 1,
        updated_at: '2026-01-01T00:00:00Z',
        encrypted: encryptSlot(keys.kEnc, keys.clientId, 0, 1, JSON.stringify({ schema_version: 1, updated_at: 1, slots: {} })),
      }),
      async () => {
        const resB = await clientServerB.getSlot(0);
        assert.equal(resB.version, 1);
        assert.equal(await clientServerB.getHighestSeenVersion(0), 1);
        assert.equal(await clientServerA.getHighestSeenVersion(0), 4);
      },
    );
  });
});
