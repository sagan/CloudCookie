import browser from 'webextension-polyfill';
import { getLocalState } from '../lib/storage';
import {
  invalidateUploads,
  performDeleteAllData,
  performPurgeTombstoneSlot,
  performSoftDeleteSlot,
  performUpload,
} from '../lib/sync';
import type { BackgroundMessage } from '../lib/types';

const ALARM_NAME = 'cloudcookie_auto_upload';

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

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;

    const local = await getLocalState();
    if (!local.auto_upload_enabled) return;
    if (!local.using_slot || local.using_slot < 1) return;

    const intervalMs = Math.max(1, local.upload_interval_minutes) * 60 * 1000;
    const elapsed = local.last_upload_at ? Date.now() - local.last_upload_at : Infinity;

    if (elapsed >= intervalMs) {
      await performUpload({ force: false });
    }
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as BackgroundMessage | undefined;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'UPLOAD_NOW') {
      return performUpload({ force: true });
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
