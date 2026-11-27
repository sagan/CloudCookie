import { ApiError, CloudCookieClient } from './api';
import { ListSlotEntry, Slot0Payload, SlotDataPayload } from './types';

const MAX_CAS_RETRIES = 4;

export function emptySlot0(): Slot0Payload {
  return {
    schema_version: 1,
    updated_at: Date.now(),
    slots: {},
  };
}

export async function fetchSlot0(
  client: CloudCookieClient,
): Promise<{ meta: Slot0Payload; version: number }> {
  try {
    const res = await client.getSlot<Slot0Payload>(0);
    const meta: Slot0Payload = {
      schema_version: 1,
      updated_at: res.data?.updated_at ?? Date.now(),
      slots: res.data?.slots && typeof res.data.slots === 'object' ? res.data.slots : {},
    };
    return { meta, version: res.version };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'no_data') {
      return { meta: emptySlot0(), version: 0 };
    }
    throw err;
  }
}

export async function fetchSlotsWithServerInfo(client: CloudCookieClient): Promise<{
  meta: Slot0Payload;
  slot0Version: number;
  serverSlots: Map<number, ListSlotEntry>;
}> {
  const [listEntries, slot0] = await Promise.all([client.listSlots(), fetchSlot0(client)]);
  const serverSlots = new Map<number, ListSlotEntry>();
  for (const entry of listEntries) {
    serverSlots.set(entry.slot, entry);
  }
  return {
    meta: slot0.meta,
    slot0Version: slot0.version,
    serverSlots,
  };
}

function allocateNextSlotId(meta: Slot0Payload, serverSlots: Map<number, ListSlotEntry>): number {
  const used = new Set<number>();
  for (const key of Object.keys(meta.slots)) {
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1) used.add(n);
  }
  for (const slot of serverSlots.keys()) {
    if (Number.isInteger(slot) && slot >= 1) used.add(slot);
  }
  let candidate = 1;
  while (used.has(candidate)) {
    candidate++;
  }
  return candidate;
}

export async function createNewSlot(
  client: CloudCookieClient,
  instanceName: string,
): Promise<{ slot: number; meta: Slot0Payload; slot0Version: number }> {
  const cleanName = instanceName.trim();
  if (!cleanName) {
    throw new Error('Browser instance name is required');
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, slot0Version, serverSlots } = await fetchSlotsWithServerInfo(client);
    const newSlotId = allocateNextSlotId(meta, serverSlots);
    const now = Date.now();

    const updatedMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: now,
      slots: {
        ...meta.slots,
        [String(newSlotId)]: {
          slot: newSlotId,
          name: cleanName,
          created_at: now,
          updated_at: now,
        },
      },
    };

    try {
      const res = await client.updateSlot(0, slot0Version, updatedMeta);
      return {
        slot: newSlotId,
        meta: updatedMeta,
        slot0Version: res.version,
      };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to create slot due to concurrent updates');
}

export async function renameSlot(
  client: CloudCookieClient,
  slot: number,
  newName: string,
): Promise<Slot0Payload> {
  const cleanName = newName.trim();
  if (!cleanName) {
    throw new Error('Slot name cannot be empty');
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, version } = await fetchSlot0(client);
    const existing = meta.slots[String(slot)];
    const now = Date.now();

    const updatedMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: now,
      slots: {
        ...meta.slots,
        [String(slot)]: {
          slot,
          name: cleanName,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        },
      },
    };

    try {
      await client.updateSlot(0, version, updatedMeta);
      return updatedMeta;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to rename slot due to concurrent updates');
}

export async function softDeleteSlot(client: CloudCookieClient, slot: number): Promise<Slot0Payload> {
  if (!Number.isInteger(slot) || slot < 1) {
    throw new Error('Cannot soft delete meta slot 0');
  }

  let updatedMeta: Slot0Payload | null = null;

  // 1. Update metadata in slot 0 to mark the slot as no longer used.
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, version } = await fetchSlot0(client);
    const existing = meta.slots[String(slot)];
    const now = Date.now();

    const nextMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: now,
      slots: {
        ...meta.slots,
        [String(slot)]: {
          slot,
          name: existing?.name ?? `Slot #${slot}`,
          created_at: existing?.created_at ?? now,
          updated_at: now,
          deleted: true,
        },
      },
    };

    try {
      await client.updateSlot(0, version, nextMeta);
      updatedMeta = nextMeta;
      break;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  if (!updatedMeta) {
    throw new Error('Failed to update slot 0 metadata while soft deleting slot');
  }

  // 2. Update the slot's data to an empty placeholder.
  const serverSlots = await client.listSlots();
  let expectedVersion = serverSlots.find((s) => s.slot === slot)?.version ?? 0;

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const emptyPayload: SlotDataPayload = {
      schema_version: 1,
      slot,
      instance_name: '',
      updated_at: Date.now(),
      cookie_count: 0,
      domain_count: 0,
      cookies: {},
    };

    try {
      await client.updateSlot(slot, expectedVersion, emptyPayload);
      return updatedMeta;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        if (err.currentVersion !== undefined) {
          expectedVersion = err.currentVersion;
        } else {
          const refreshed = await client.listSlots();
          expectedVersion = refreshed.find((s) => s.slot === slot)?.version ?? 0;
        }
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to clear slot ${slot} data due to concurrent updates`);
}

export async function deleteAllServerData(client: CloudCookieClient): Promise<void> {
  try {
    await client.deleteSlot('all');
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'no_data' || err.code === 'client_not_found')) {
      return;
    }
    throw err;
  }
}

export async function deleteSlotAndMeta(client: CloudCookieClient, slot: number): Promise<Slot0Payload> {
  if (slot < 1) {
    throw new Error('Cannot delete meta slot 0');
  }

  try {
    await client.deleteSlot(slot);
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'no_data')) {
      throw err;
    }
  }

  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, version } = await fetchSlot0(client);
    const nextSlots = { ...meta.slots };
    delete nextSlots[String(slot)];

    const updatedMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: Date.now(),
      slots: nextSlots,
    };

    try {
      await client.updateSlot(0, version, updatedMeta);
      return updatedMeta;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to update slot 0 after deleting slot');
}

export async function fetchSlotCookies(
  client: CloudCookieClient,
  slot: number,
): Promise<{ version: number; updated_at: string; payload: SlotDataPayload }> {
  const res = await client.getSlot<SlotDataPayload>(slot);
  return {
    version: res.version,
    updated_at: res.updated_at,
    payload: res.data,
  };
}
