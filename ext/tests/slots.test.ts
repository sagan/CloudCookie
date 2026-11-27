import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, CloudCookieClient } from '../src/lib/api';
import { deleteAllServerData, softDeleteSlot } from '../src/lib/slots';
import { ListSlotEntry, Slot0Payload, SlotDataPayload } from '../src/lib/types';

function createMockClient(options?: {
  slot0Version?: number;
  slot0Data?: Slot0Payload;
  listEntries?: ListSlotEntry[];
  failFirstSlot0Conflict?: boolean;
  failFirstDataConflict?: { currentVersion: number };
}) {
  let slot0Version = options?.slot0Version ?? 1;
  let slot0Data: Slot0Payload = options?.slot0Data ?? {
    schema_version: 1,
    updated_at: 1000,
    slots: {
      '1': { slot: 1, name: 'Work', created_at: 1000, updated_at: 1000 },
      '2': { slot: 2, name: 'Home', created_at: 1000, updated_at: 1000 },
    },
  };
  let listEntries: ListSlotEntry[] = options?.listEntries ?? [
    { slot: 0, version: slot0Version, updated_at: '2026-01-01T00:00:00Z', size_bytes: 100 },
    { slot: 2, version: 3, updated_at: '2026-01-01T00:00:00Z', size_bytes: 500 },
  ];
  let failSlot0 = options?.failFirstSlot0Conflict ?? false;
  let failData = options?.failFirstDataConflict;

  const updatedSlots: Array<{ slot: number; expectedVersion: number; payload: unknown }> = [];
  const deletedArgs: Array<number | 'all'> = [];

  const mockClient = {
    async getSlot<T>(slot: number): Promise<{ slot: number; version: number; updated_at: string; data: T }> {
      if (slot === 0) {
        return {
          slot: 0,
          version: slot0Version,
          updated_at: '2026-01-01T00:00:00Z',
          data: slot0Data as unknown as T,
        };
      }
      throw new ApiError(404, 'no_data', 'Not found');
    },
    async listSlots(): Promise<ListSlotEntry[]> {
      return listEntries;
    },
    async updateSlot(slot: number, expectedVersion: number, payload: unknown) {
      if (slot === 0 && failSlot0) {
        failSlot0 = false;
        slot0Version += 1;
        throw new ApiError(409, 'version_conflict', 'Conflict', { currentVersion: slot0Version });
      }
      if (slot !== 0 && failData) {
        const cv = failData.currentVersion;
        failData = undefined;
        throw new ApiError(409, 'version_conflict', 'Conflict', { currentVersion: cv });
      }
      updatedSlots.push({ slot, expectedVersion, payload });
      const nextVersion = expectedVersion + 1;
      if (slot === 0) {
        slot0Version = nextVersion;
        slot0Data = payload as Slot0Payload;
      }
      return { slot, version: nextVersion, updated_at: '2026-01-01T00:01:00Z' };
    },
    async deleteSlot(slot: number | 'all'): Promise<void> {
      deletedArgs.push(slot);
    },
  } as unknown as CloudCookieClient;

  return { mockClient, updatedSlots, deletedArgs };
}

describe('softDeleteSlot', () => {
  it('rejects slot < 1', async () => {
    const { mockClient } = createMockClient();
    await assert.rejects(() => softDeleteSlot(mockClient, 0), /Cannot soft delete meta slot 0/);
  });

  it('marks slot as deleted in slot 0 and replaces slot data with empty placeholder', async () => {
    const { mockClient, updatedSlots, deletedArgs } = createMockClient();

    const result = await softDeleteSlot(mockClient, 2);

    assert.equal(deletedArgs.length, 0);
    assert.equal(result.slots['2'].deleted, true);
    assert.equal(result.slots['1'].deleted, undefined);

    assert.equal(updatedSlots.length, 2);

    const slot0Update = updatedSlots[0];
    assert.equal(slot0Update.slot, 0);
    assert.equal(slot0Update.expectedVersion, 1);
    assert.equal((slot0Update.payload as Slot0Payload).slots['2'].deleted, true);

    const slot2Update = updatedSlots[1];
    assert.equal(slot2Update.slot, 2);
    assert.equal(slot2Update.expectedVersion, 3);
    const dataPayload = slot2Update.payload as SlotDataPayload;
    assert.equal(dataPayload.slot, 2);
    assert.equal(dataPayload.instance_name, '');
    assert.equal(dataPayload.cookie_count, 0);
    assert.equal(dataPayload.domain_count, 0);
    assert.deepEqual(dataPayload.cookies, {});
  });

  it('retries on version_conflict for both slot 0 and target slot data', async () => {
    const { mockClient, updatedSlots } = createMockClient({
      failFirstSlot0Conflict: true,
      failFirstDataConflict: { currentVersion: 5 },
    });

    const result = await softDeleteSlot(mockClient, 2);
    assert.equal(result.slots['2'].deleted, true);
    assert.equal(updatedSlots.length, 2);
    assert.equal(updatedSlots[0].slot, 0);
    assert.equal(updatedSlots[0].expectedVersion, 2);
    assert.equal(updatedSlots[1].slot, 2);
    assert.equal(updatedSlots[1].expectedVersion, 5);
  });
});

describe('deleteAllServerData', () => {
  it('calls deleteSlot("all")', async () => {
    const { mockClient, deletedArgs } = createMockClient();
    await deleteAllServerData(mockClient);
    assert.deepEqual(deletedArgs, ['all']);
  });

  it('ignores client_not_found and no_data errors', async () => {
    const clientNotFound = {
      deleteSlot: async () => {
        throw new ApiError(404, 'client_not_found', 'Not found');
      },
    } as unknown as CloudCookieClient;
    await deleteAllServerData(clientNotFound);

    const noData = {
      deleteSlot: async () => {
        throw new ApiError(404, 'no_data', 'No data');
      },
    } as unknown as CloudCookieClient;
    await deleteAllServerData(noData);
  });

  it('rethrows other ApiErrors', async () => {
    const unauthorized = {
      deleteSlot: async () => {
        throw new ApiError(401, 'invalid_signature', 'Bad sig');
      },
    } as unknown as CloudCookieClient;
    await assert.rejects(() => deleteAllServerData(unauthorized), /Bad sig/);
  });
});
