import browser from 'webextension-polyfill';
import { getLocalState, saveLocalState } from '../lib/storage';
import {
  invalidateUploads,
  performBookmarksUpload,
  performDeleteAllData,
  performPurgeTombstoneSlot,
  performSoftDeleteSlot,
  performUpload,
} from '../lib/sync';
import type { BackgroundMessage } from '../lib/types';

const ALARM_NAME = 'cloudcookie_auto_upload';
const BOOKMARKS_DEBOUNCE_MS = 5000;

let bookmarksDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let bookmarksImportInProgress = false;

async function scheduleBookmarksUploadFromEvent(): Promise<void> {
  const local = await getLocalState();
  if (!local.bookmarks_upload_enabled) return;

  await saveLocalState({ bookmarks_dirty: true });
  if (bookmarksImportInProgress) return;

  if (bookmarksDebounceTimer !== null) {
    clearTimeout(bookmarksDebounceTimer);
  }
  bookmarksDebounceTimer = setTimeout(() => {
    bookmarksDebounceTimer = null;
    void performBookmarksUpload({ force: false });
  }, BOOKMARKS_DEBOUNCE_MS);
}

async function ensureAlarm(): Promise<void> {
  const existing = await browser.alarms.get(ALARM_NAME);
  if (!existing) {
    await browser.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  }
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void ensureAlarm();
  });

  browser.runtime.onStartup.addListener(() => {
    void ensureAlarm();
  });

  void ensureAlarm();

  const onBookmarkChange = () => {
    void scheduleBookmarksUploadFromEvent();
  };
  const bookmarksApi = browser.bookmarks as typeof browser.bookmarks & {
    onChildrenReordered?: { addListener: (cb: () => void) => void };
    onImportBegan?: { addListener: (cb: () => void) => void };
    onImportEnded?: { addListener: (cb: () => void) => void };
  };
  bookmarksApi?.onCreated?.addListener(onBookmarkChange);
  bookmarksApi?.onRemoved?.addListener(onBookmarkChange);
  bookmarksApi?.onChanged?.addListener(onBookmarkChange);
  bookmarksApi?.onMoved?.addListener(onBookmarkChange);
  bookmarksApi?.onChildrenReordered?.addListener(onBookmarkChange);
  bookmarksApi?.onImportBegan?.addListener(() => {
    bookmarksImportInProgress = true;
  });
  bookmarksApi?.onImportEnded?.addListener(() => {
    bookmarksImportInProgress = false;
    void scheduleBookmarksUploadFromEvent();
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;

    const local = await getLocalState();
    const intervalMs = Math.max(1, local.upload_interval_minutes) * 60 * 1000;

    if (local.auto_upload_enabled && local.using_slot && local.using_slot >= 1) {
      const elapsed = local.last_upload_at ? Date.now() - local.last_upload_at : Infinity;
      if (elapsed >= intervalMs) {
        await performUpload({ force: false });
      }
    }

    // Bookmarks are event-driven; the alarm only retries if dirty or never uploaded yet.
    if (
      local.auto_upload_enabled &&
      local.bookmarks_upload_enabled &&
      (local.bookmarks_dirty || local.last_bookmarks_upload_at === null)
    ) {
      await performBookmarksUpload({ force: false });
    }
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as BackgroundMessage | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'UPLOAD_NOW') {
      return performUpload({ force: true });
    }
    if (msg.type === 'UPLOAD_BOOKMARKS_NOW') {
      return performBookmarksUpload({ force: true });
    }
    if (msg.type === 'GET_STATUS') {
      return getLocalState();
    }
    if (msg.type === 'RESCHEDULE_ALARM') {
      return ensureAlarm().then(() => ({ ok: true }));
    }
    if (msg.type === 'INVALIDATE_UPLOADS') {
      invalidateUploads();
      return Promise.resolve({ ok: true });
    }
    if (msg.type === 'SOFT_DELETE_SLOT') {
      return performSoftDeleteSlot(msg.slot);
    }
    if (msg.type === 'PURGE_TOMBSTONE_SLOT') {
      return performPurgeTombstoneSlot(msg.slot);
    }
    if (msg.type === 'DELETE_ALL_DATA') {
      return performDeleteAllData();
    }
  });
});
