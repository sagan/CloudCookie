import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudCookieClient } from '../src/lib/api';
import {
  hashBookmarks,
  normalizeBookmarkTree,
  type BookmarkTreeNodeLike,
} from '../src/lib/bookmarkCore';
import { generateRootKey } from '../src/lib/crypto';
import { ensureBookmarksSlot, fetchBookmarksSlot, findBookmarksSlotId } from '../src/lib/slots';
import { createSyncCoordinator } from '../src/lib/syncCore';
import { DEFAULT_LOCAL_STATE, type LocalState, type Slot0Payload } from '../src/lib/types';

function makeMockFetch() {
  const slots = new Map<number, { encrypted: string; version: number; updated_at: string }>();

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      action: string;
      client_id: string;
      slot?: number;
      expected_version?: number;
      encrypted?: string;
    };

    if (body.action === 'list') {
      const list = Array.from(slots.entries()).map(([slot, entry]) => ({
        slot,
        version: entry.version,
        updated_at: entry.updated_at,
        size_bytes: entry.encrypted.length,
      }));
      return new Response(
        JSON.stringify({ ok: true, action: 'list', client_id: body.client_id, slots: list }),
        { status: 200 },
      );
    }

    if (body.action === 'get') {
      const slot = body.slot ?? 0;
      const entry = slots.get(slot);
      if (!entry) {
        return new Response(
          JSON.stringify({ ok: false, error: 'no_data', message: 'not found' }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          action: 'get',
          client_id: body.client_id,
          slot,
          encrypted: entry.encrypted,
          updated_at: entry.updated_at,
          version: entry.version,
        }),
        { status: 200 },
      );
    }

    if (body.action === 'update') {
      const slot = body.slot ?? 0;
      const current = slots.get(slot)?.version ?? 0;
      if ((body.expected_version ?? 0) !== current) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'version_conflict',
            current_version: current,
            message: 'conflict',
          }),
          { status: 409 },
        );
      }
      const nextVersion = current + 1;
      const updated_at = new Date().toISOString();
      slots.set(slot, { encrypted: body.encrypted ?? '', version: nextVersion, updated_at });
      return new Response(
        JSON.stringify({
          ok: true,
          action: 'update',
          client_id: body.client_id,
          slot,
          updated_at,
          version: nextVersion,
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ ok: false, error: 'bad_action' }), { status: 400 });
  }) as typeof fetch;

  return { fetchImpl, slots };
}

test('normalizeBookmarkTree and hashBookmarks produce deterministic output', () => {
  const tree = [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          title: 'Bookmarks bar',
          children: [
            { id: '10', title: 'GitHub', url: 'https://github.com', dateAdded: 1000 },
            {
              id: '11',
              title: 'Docs',
              children: [{ id: '12', title: 'MDN', url: 'https://developer.mozilla.org' }],
            },
          ],
        },
        {
          id: '2',
          title: 'Other bookmarks',
          children: [],
        },
      ],
    },
  ] as BookmarkTreeNodeLike[];

  const res = normalizeBookmarkTree(tree);
  assert.equal(res.bookmarkCount, 2);
  assert.equal(res.folderCount, 3);
  assert.equal(res.roots.length, 2);
  assert.equal(res.roots[0]?.children?.[0]?.url, 'https://github.com');

  const h1 = hashBookmarks(res.roots);
  const h2 = hashBookmarks(res.roots);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('ensureBookmarksSlot allocates a dedicated slot in Slot 0 and reuses it', async () => {
  const { fetchImpl } = makeMockFetch();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const client = new CloudCookieClient('https://cookie.example.com', generateRootKey());

    const first = await ensureBookmarksSlot(client);
    assert.ok(first.slot >= 1);
    assert.equal(first.meta.bookmarks_slot, first.slot);
    assert.equal(first.meta.slots[String(first.slot)]?.type, 'bookmarks');
    assert.equal(findBookmarksSlotId(first.meta), first.slot);

    const second = await ensureBookmarksSlot(client);
    assert.equal(second.slot, first.slot);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('performBookmarksUpload respects opt-in flag and uploads to separate slot', async () => {
  const { fetchImpl } = makeMockFetch();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const rootKey = generateRootKey();
    let localState: LocalState = {
      ...DEFAULT_LOCAL_STATE,
      using_slot: 1,
      using_slot_name: 'Main Chrome',
      bookmarks_upload_enabled: false,
    };

    const roots = [
      {
        title: 'Bookmarks bar',
        children: [{ title: 'Example', url: 'https://example.com' }],
      },
    ];

    const coordinator = createSyncCoordinator({
      getSyncSettings: async () => ({ server_url: 'https://cookie.example.com', root_key: rootKey }),
      getLocalState: async () => localState,
      saveLocalState: async (patch) => {
        localState = { ...localState, ...patch };
      },
      clearSlotBinding: async () => {},
      clearAllExtensionData: async () => {},
      collectLocalCookies: async () => ({ cookies: {}, cookieCount: 0, domainCount: 0 }),
      hashCookieMap: () => 'cookiehash',
      collectLocalBookmarks: async () => ({
        roots,
        bookmarkCount: roots[0]?.children?.length ?? 0,
        folderCount: 1,
      }),
      hashBookmarks,
      createClient: (url, key) => new CloudCookieClient(url, key),
      showBadge: () => {},
    });

    // 1. Disabled by default -> skipped
    const disabledRes = await coordinator.performBookmarksUpload({ force: false });
    assert.equal(disabledRes.ok, true);
    assert.equal(disabledRes.skipped, true);

    // 2. Enable opt-in -> uploads to dedicated bookmarks slot
    localState = { ...localState, bookmarks_upload_enabled: true };
    const uploaded = await coordinator.performBookmarksUpload({ force: false });
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.skipped, undefined);
    assert.equal(uploaded.bookmarkCount, 1);
    assert.equal(uploaded.version, 1);
    assert.ok((uploaded.slot ?? 0) >= 1);

    // 3. Unchanged -> skipped
    const skipped = await coordinator.performBookmarksUpload({ force: false });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.skipped, true);

    // 4. Fetch decrypted bookmarks via fetchBookmarksSlot
    const client = new CloudCookieClient('https://cookie.example.com', rootKey);
    const fetched = await fetchBookmarksSlot(client);
    assert.ok(fetched !== null);
    assert.equal(fetched.slot, uploaded.slot);
    assert.equal(fetched.payload.bookmark_count, 1);
    assert.equal(fetched.payload.roots[0]?.children?.[0]?.url, 'https://example.com');

    // Ensure Slot 0 has bookmarks_slot set
    const slot0 = await client.getSlot<Slot0Payload>(0);
    assert.equal(slot0.data.bookmarks_slot, uploaded.slot);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
