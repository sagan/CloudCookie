import { ApiError, CloudCookieClient } from './api';
import type { BookmarkSlotPayload, ListSlotEntry, Slot0Payload, SlotDataPayload } from './types';

const MAX_CAS_RETRIES = 4;
const MAX_SLOT_ID = 1023;

function randomIndex(length: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / length) * length;
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0] ?? 0;
  } while (value >= limit);
  return value % length;
}

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
      ...(typeof res.data?.bookmarks_slot === 'number' ? { bookmarks_slot: res.data.bookmarks_slot } : {}),
      slots: res.data?.slots && typeof res.data.slots === 'object' ? res.data.slots : {},
    };
    return { meta, version: res.version };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'no_data') {
      const highestSeen =
        typeof client.getHighestSeenVersion === 'function'
          ? await client.getHighestSeenVersion(0)
          : 0;
      if (highestSeen > 0) {
        throw new ApiError(
          404,
          'rollback_detected',
          `Rollback detected for meta slot 0: server returned no_data, but locally recorded version is ${highestSeen}.`,
        );
      }
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
    if (typeof client.getHighestSeenVersion === 'function') {
      const highestSeen = await client.getHighestSeenVersion(entry.slot);
      if (entry.version < highestSeen) {
        throw new ApiError(
          200,
          'rollback_detected',
          `Rollback detected in slot list for slot ${entry.slot}: server listed version ${entry.version}, which is lower than locally recorded version ${highestSeen}.`,
        );
      }
    }
    serverSlots.set(entry.slot, entry);
  }
  return {
    meta: slot0.meta,
    slot0Version: slot0.version,
    serverSlots,
  };
}

export function allocateNextSlotId(
  meta: Slot0Payload,
  serverSlots: Map<number, ListSlotEntry>,
): number {
  const used = new Set<number>();
  for (const key of Object.keys(meta.slots)) {
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1) used.add(n);
  }
  for (const slot of serverSlots.keys()) {
    if (Number.isInteger(slot) && slot >= 1) used.add(slot);
  }
  const available: number[] = [];
  for (let candidate = 1; candidate <= MAX_SLOT_ID; candidate++) {
    if (!used.has(candidate)) {
      available.push(candidate);
    }
  }
  if (available.length === 0) {
    throw new Error(`No available slot IDs remaining (max ${MAX_SLOT_ID})`);
  }
  return available[randomIndex(available.length)]!;
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
      ...(typeof meta.bookmarks_slot === 'number' ? { bookmarks_slot: meta.bookmarks_slot } : {}),
      slots: {
        ...meta.slots,
        [String(newSlotId)]: {
          slot: newSlotId,
          name: cleanName,
          type: 'cookies',
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
      ...(typeof meta.bookmarks_slot === 'number' ? { bookmarks_slot: meta.bookmarks_slot } : {}),
      slots: {
        ...meta.slots,
        [String(slot)]: {
          slot,
          name: cleanName,
          ...(existing?.type ? { type: existing.type } : {}),
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

  // 1. Clear the slot's cookie data first so a failure never hides un-deleted cookies.
  const serverSlots = await client.listSlots();
  const existingServerSlot = serverSlots.find((s) => s.slot === slot);
  if (existingServerSlot) {
    let expectedVersion = existingServerSlot.version;
    let dataCleared = false;

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
        dataCleared = true;
        break;
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

    if (!dataCleared) {
      throw new Error(`Failed to clear slot ${slot} data due to concurrent updates`);
    }
  }

  // 2. Mark the slot as deleted in slot 0 metadata only after data is cleared.
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, version } = await fetchSlot0(client);
    const existing = meta.slots[String(slot)];
    const now = Date.now();

    const nextMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: now,
      ...(typeof meta.bookmarks_slot === 'number' ? { bookmarks_slot: meta.bookmarks_slot } : {}),
      slots: {
        ...meta.slots,
        [String(slot)]: {
          slot,
          name: existing?.name ?? `Slot #${slot}`,
          ...(existing?.type ? { type: existing.type } : {}),
          created_at: existing?.created_at ?? now,
          updated_at: now,
          deleted: true,
        },
      },
    };

    try {
      await client.updateSlot(0, version, nextMeta);
      return nextMeta;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict' && attempt < MAX_CAS_RETRIES - 1) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to update slot 0 metadata while soft deleting slot');
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
      ...(typeof meta.bookmarks_slot === 'number' && meta.bookmarks_slot !== slot
        ? { bookmarks_slot: meta.bookmarks_slot }
        : {}),
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

export function findBookmarksSlotId(meta: Slot0Payload): number | null {
  if (typeof meta.bookmarks_slot === 'number' && meta.bookmarks_slot >= 1) {
    const entry = meta.slots[String(meta.bookmarks_slot)];
    if (!entry?.deleted) {
      return meta.bookmarks_slot;
    }
  }
  for (const entry of Object.values(meta.slots)) {
    if (!entry.deleted && entry.type === 'bookmarks' && entry.slot >= 1) {
      return entry.slot;
    }
  }
  return null;
}

export async function ensureBookmarksSlot(
  client: CloudCookieClient,
): Promise<{ slot: number; meta: Slot0Payload; slot0Version: number }> {
  for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
    const { meta, slot0Version, serverSlots } = await fetchSlotsWithServerInfo(client);
    const existingSlot = findBookmarksSlotId(meta);
    if (existingSlot !== null) {
      return { slot: existingSlot, meta, slot0Version };
    }

    const newSlotId = allocateNextSlotId(meta, serverSlots);
    const now = Date.now();
    const updatedMeta: Slot0Payload = {
      schema_version: 1,
      updated_at: now,
      bookmarks_slot: newSlotId,
      slots: {
        ...meta.slots,
        [String(newSlotId)]: {
          slot: newSlotId,
          name: 'Bookmarks',
          type: 'bookmarks',
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

  throw new Error('Failed to allocate bookmarks slot due to concurrent updates');
}

export async function fetchBookmarksSlot(
  client: CloudCookieClient,
): Promise<{ slot: number; version: number; updated_at: string; payload: BookmarkSlotPayload } | null> {
  const { meta } = await fetchSlot0(client);
  const slot = findBookmarksSlotId(meta);
  if (slot === null) {
    return null;
  }
  try {
    const res = await client.getSlot<BookmarkSlotPayload>(slot);
    return {
      slot,
      version: res.version,
      updated_at: res.updated_at,
      payload: res.data,
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'no_data') {
      return null;
    }
    throw err;
  }
}
