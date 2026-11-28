import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CloudCookieClient } from '../src/lib/api';
import { deriveKeys } from '../src/lib/crypto';
import { createSyncCoordinator, makeUploadTargetKey } from '../src/lib/syncCore';
import {
  DEFAULT_LOCAL_STATE,
  type ListSlotEntry,
  type LocalState,
  type SerializedCookie,
  type Slot0Payload,
  type SyncSettings,
} from '../src/lib/types';

const ROOT_KEY_A = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const ROOT_KEY_B = 'ff0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const SAMPLE_COOKIES: Record<string, SerializedCookie[]> = {
  'example.com': [
    {
      name: 'sid',
      value: 'abc',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: true,
      session: false,
    },
  ],
};

function createTestHarness() {
  let syncSettings: SyncSettings = {
    server_url: 'https://server-a.example.com',
    root_key: ROOT_KEY_A,
  };
  let localState: LocalState = {
    ...DEFAULT_LOCAL_STATE,
    using_slot: 1,
    using_slot_name: 'Slot 1',
  };

  const highestVersions = new Map<string, number>();
  const remoteSlots = new Map<string, Map<number, { version: number; payload: unknown }>>();
  const slot0Data = new Map<string, { version: number; meta: Slot0Payload }>();
  const updateCalls: Array<{ serverUrl: string; clientId: string; slot: number; expectedVersion: number }> = [];
  let onBeforeUpdate: (() => Promise<void> | void) | null = null;

  function getServerClientMap(serverUrl: string, clientId: string) {
    const key = `${serverUrl}|${clientId}`;
    let m = remoteSlots.get(key);
    if (!m) {
      m = new Map();
      remoteSlots.set(key, m);
    }
    return m;
  }

  const coordinator = createSyncCoordinator({
    async getSyncSettings() {
      return { ...syncSettings };
    },
    async getLocalState() {
      return {
        ...localState,
        upload_states: { ...(localState.upload_states ?? {}) },
      };
    },
    async saveLocalState(patch) {
      localState = { ...localState, ...patch };
    },
    async clearSlotBinding() {
      localState = {
        ...localState,
        using_slot: null,
        using_slot_name: null,
        last_upload_hash: null,
        last_upload_at: null,
        last_upload_status: null,
        last_upload_error: null,
        last_slot_version: null,
        last_cookie_count: null,
        last_domain_count: null,
      };
    },
    async clearAllExtensionData() {
      syncSettings = { server_url: '', root_key: '' };
      localState = { ...DEFAULT_LOCAL_STATE, upload_states: {}, highest_slot_versions: {} };
      highestVersions.clear();
    },
    async collectLocalCookies() {
      return { cookies: SAMPLE_COOKIES, cookieCount: 1, domainCount: 1 };
    },
    hashCookieMap(cookies) {
      return JSON.stringify(cookies);
    },
    createClient(serverUrl: string, rootKey: string) {
      const keys = deriveKeys(rootKey);
      const clientId = keys.clientId;
      const clientMap = getServerClientMap(serverUrl, clientId);
      const s0Key = `${serverUrl}|${clientId}`;
      if (!slot0Data.has(s0Key)) {
        slot0Data.set(s0Key, {
          version: 1,
          meta: {
            schema_version: 1,
            updated_at: 1000,
            slots: {
              '1': { slot: 1, name: 'Slot 1', created_at: 1000, updated_at: 1000 },
              '2': { slot: 2, name: 'Slot 2', created_at: 1000, updated_at: 1000 },
            },
          },
        });
      }

      return {
        serverUrl,
        clientId,
        async getHighestSeenVersion(slot: number) {
          return highestVersions.get(`${clientId}:${slot}`) ?? 0;
        },
        async listSlots(): Promise<ListSlotEntry[]> {
          const entries: ListSlotEntry[] = [];
          for (const [slot, rec] of clientMap.entries()) {
            entries.push({
              slot,
              version: rec.version,
              updated_at: '2026-01-01T00:00:00Z',
              size_bytes: 100,
            });
          }
          return entries;
        },
        async getSlot<T>(slot: number) {
          if (slot === 0) {
            const s0 = slot0Data.get(s0Key)!;
            return {
              slot: 0,
              version: s0.version,
              updated_at: '2026-01-01T00:00:00Z',
              data: s0.meta as unknown as T,
            };
          }
          const rec = clientMap.get(slot);
          if (!rec) {
            throw new Error('no_data');
          }
          return {
            slot,
            version: rec.version,
            updated_at: '2026-01-01T00:00:00Z',
            data: rec.payload as T,
          };
        },
        async updateSlot(slot: number, expectedVersion: number, payload: unknown) {
          if (onBeforeUpdate) {
            await onBeforeUpdate();
          }
          if (slot === 0) {
            const s0 = slot0Data.get(s0Key)!;
            const nextVer = expectedVersion + 1;
            slot0Data.set(s0Key, { version: nextVer, meta: payload as Slot0Payload });
            highestVersions.set(`${clientId}:0`, nextVer);
            return { slot: 0, version: nextVer, updated_at: '2026-01-01T00:00:00Z' };
          }
          updateCalls.push({ serverUrl, clientId, slot, expectedVersion });
          const nextVer = expectedVersion + 1;
          clientMap.set(slot, { version: nextVer, payload });
          highestVersions.set(`${clientId}:${slot}`, nextVer);
          return { slot, version: nextVer, updated_at: '2026-01-01T00:00:00Z' };
        },
        async deleteSlot() {
          clientMap.clear();
        },
      } as unknown as CloudCookieClient;
    },
    showBadge() {},
  });

  return {
    coordinator,
    getSyncSettings: () => syncSettings,
    setSyncSettings: (s: SyncSettings) => {
      syncSettings = s;
    },
    getLocalState: () => localState,
    setLocalState: (patch: Partial<LocalState>) => {
      localState = { ...localState, ...patch };
    },
    remoteSlots,
    highestVersions,
    updateCalls,
    setOnBeforeUpdate: (fn: (() => Promise<void> | void) | null) => {
      onBeforeUpdate = fn;
    },
  };
}

describe('syncCoordinator race & state isolation', () => {
  it('keys upload state by (server_url, client_id, slot) and does not skip slot B or new connection', async () => {
    const h = createTestHarness();

    // Upload slot 1 on server A, key A
    const r1 = await h.coordinator.performUpload({ force: true });
    assert.equal(r1.ok, true);
    assert.equal(r1.version, 1);

    // Switch to slot 2 with identical cookies -> must NOT skip
    h.coordinator.invalidateUploads();
    h.setLocalState({ using_slot: 2, using_slot_name: 'Slot 2' });
    const r2 = await h.coordinator.performUpload({ force: false });
    assert.equal(r2.ok, true);
    assert.equal(r2.skipped, undefined);
    assert.equal(r2.version, 1);

    // Switch to root key B on slot 1 -> must NOT skip
    h.coordinator.invalidateUploads();
    h.setSyncSettings({ server_url: 'https://server-a.example.com', root_key: ROOT_KEY_B });
    h.setLocalState({ using_slot: 1, using_slot_name: 'Slot 1' });
    const r3 = await h.coordinator.performUpload({ force: false });
    assert.equal(r3.ok, true);
    assert.equal(r3.skipped, undefined);
    assert.equal(h.updateCalls.length, 3);
  });

  it('verifies remote state before skipping an unchanged hash', async () => {
    const h = createTestHarness();
    const r1 = await h.coordinator.performUpload({ force: true });
    assert.equal(r1.ok, true);

    // Remote matches -> skips
    const r2 = await h.coordinator.performUpload({ force: false });
    assert.equal(r2.ok, true);
    assert.equal(r2.skipped, true);

    // Remote slot is missing (e.g. deleted remotely) -> must NOT skip
    const keysA = deriveKeys(ROOT_KEY_A);
    h.remoteSlots.get(`https://server-a.example.com|${keysA.clientId}`)!.delete(1);
    const r3 = await h.coordinator.performUpload({ force: false });
    assert.equal(r3.ok, true);
    assert.equal(r3.skipped, undefined);
  });

  it('supersedes in-flight upload when slot changes before commit and serializes soft-delete', async () => {
    const h = createTestHarness();

    let switched = false;
    h.setOnBeforeUpdate(async () => {
      if (!switched) {
        switched = true;
        // Simulate user switching to slot 2 while slot 1 upload is mid-flight
        h.coordinator.invalidateUploads();
        h.setLocalState({ using_slot: 2, using_slot_name: 'Slot 2' });
      }
    });

    const p1 = h.coordinator.performUpload({ force: true });
    const res1 = await p1;
    assert.equal(res1.ok, true);

    // Now slot 2 has NOT been overwritten with slot 1's summary state
    assert.equal(h.getLocalState().last_upload_hash, null);
    assert.equal(h.getLocalState().using_slot, 2);

    // Serialized soft-delete supersedes any queued upload and clears binding
    h.setOnBeforeUpdate(null);
    const pUpload2 = h.coordinator.performUpload({ force: true });
    const pDel2 = h.coordinator.performSoftDeleteSlot(2);
    const [upRes, delRes] = await Promise.all([pUpload2, pDel2]);
    assert.equal(delRes.ok, true);
    assert.equal(upRes.ok, false);
    assert.match(upRes.error ?? '', /superseded/i);
    assert.equal(h.getLocalState().using_slot, null);
  });

  it('serializes delete-all with in-flight upload so deleted data is not written back', async () => {
    const h = createTestHarness();
    const pUpload = h.coordinator.performUpload({ force: true });
    const pDelAll = h.coordinator.performDeleteAllData();
    const [upRes, delRes] = await Promise.all([pUpload, pDelAll]);

    assert.equal(delRes.ok, true);
    assert.equal(upRes.ok, false);
    assert.equal(h.getSyncSettings().server_url, '');
    assert.equal(h.getLocalState().using_slot, null);
    assert.deepEqual(h.getLocalState().upload_states, {});
    const keysA = deriveKeys(ROOT_KEY_A);
    const key = makeUploadTargetKey('https://server-a.example.com', keysA.clientId, 1);
    assert.equal(h.getLocalState().upload_states[key], undefined);
  });

  it('uploads browser meta info in slot payload and re-uploads when meta changes', async () => {
    const h = createTestHarness();
    let currentUA = 'Mozilla/5.0 Chrome/130.0.0.0';

    const metaCoordinator = createSyncCoordinator({
      async getSyncSettings() {
        return h.getSyncSettings();
      },
      async getLocalState() {
        return h.getLocalState();
      },
      async saveLocalState(patch) {
        h.setLocalState(patch);
      },
      async clearSlotBinding() {},
      async clearAllExtensionData() {},
      async collectLocalCookies() {
        return { cookies: SAMPLE_COOKIES, cookieCount: 1, domainCount: 1 };
      },
      hashCookieMap(cookies) {
        return JSON.stringify(cookies);
      },
      async collectBrowserMeta() {
        return {
          user_agent: currentUA,
          platform: 'MacIntel',
          language: 'en-US',
        };
      },
      createClient(serverUrl, rootKey) {
        // Reuse the same mock server state via a fresh coordinator-compatible client
        const keys = deriveKeys(rootKey);
        const clientId = keys.clientId;
        const mapKey = `${serverUrl}|${clientId}`;
        let clientMap = h.remoteSlots.get(mapKey);
        if (!clientMap) {
          clientMap = new Map();
          h.remoteSlots.set(mapKey, clientMap);
        }
        return {
          serverUrl,
          clientId,
          async getHighestSeenVersion() {
            return 0;
          },
          async listSlots() {
            return Array.from(clientMap!.entries()).map(([slot, rec]) => ({
              slot,
              version: rec.version,
              updated_at: '2026-01-01T00:00:00Z',
              size_bytes: 100,
            }));
          },
          async getSlot() {
            throw new Error('unused');
          },
          async updateSlot(slot: number, expectedVersion: number, payload: unknown) {
            const existing = clientMap!.get(slot);
            const nextVer = (existing?.version ?? expectedVersion) + 1;
            clientMap!.set(slot, { version: nextVer, payload });
            return { slot, version: nextVer, updated_at: '2026-01-01T00:00:00Z' };
          },
          async deleteSlot() {},
        } as unknown as CloudCookieClient;
      },
      showBadge() {},
    });

    const r1 = await metaCoordinator.performUpload({ force: false });
    assert.equal(r1.ok, true);
    assert.equal(r1.skipped, undefined);

    const keysA = deriveKeys(ROOT_KEY_A);
    const stored1 = h.remoteSlots.get(`https://server-a.example.com|${keysA.clientId}`)!.get(1)!;
    assert.equal((stored1.payload as { meta?: { user_agent?: string } }).meta?.user_agent, 'Mozilla/5.0 Chrome/130.0.0.0');

    // Same cookies & same UA -> skipped
    const r2 = await metaCoordinator.performUpload({ force: false });
    assert.equal(r2.ok, true);
    assert.equal(r2.skipped, true);

    // Same cookies & changed UA -> must re-upload with new meta
    currentUA = 'Mozilla/5.0 Chrome/131.0.0.0';
    const r3 = await metaCoordinator.performUpload({ force: false });
    assert.equal(r3.ok, true);
    assert.equal(r3.skipped, undefined);

    const stored2 = h.remoteSlots.get(`https://server-a.example.com|${keysA.clientId}`)!.get(1)!;
    assert.equal((stored2.payload as { meta?: { user_agent?: string } }).meta?.user_agent, 'Mozilla/5.0 Chrome/131.0.0.0');
  });
});
