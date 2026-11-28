import browser from 'webextension-polyfill';
import { CloudCookieClient } from './api';
import { collectLocalBookmarks, hashBookmarks } from './bookmarks';
import { collectLocalCookies, hashCookieMap } from './cookies';
import {
  clearAllExtensionData,
  clearSlotBinding,
  getLocalState,
  getSyncSettings,
  saveLocalState,
} from './storage';
import { createSyncCoordinator } from './syncCore';
import type {
  BookmarksUploadResult,
  DeleteAllResult,
  SoftDeleteResult,
  UploadResult,
} from './types';

function showBadge(text: string, color: string, durationMs = 4000): void {
  const actionApi = browser.action ?? browser.browserAction;
  if (!actionApi) return;
  actionApi.setBadgeText({ text }).catch(() => {});
  actionApi.setBadgeBackgroundColor({ color }).catch(() => {});
  if (durationMs > 0) {
    setTimeout(() => {
      actionApi.setBadgeText({ text: '' }).catch(() => {});
    }, durationMs);
  }
}

const coordinator = createSyncCoordinator({
  getSyncSettings,
  getLocalState,
  saveLocalState,
  clearSlotBinding,
  clearAllExtensionData,
  collectLocalCookies,
  hashCookieMap,
  collectLocalBookmarks,
  hashBookmarks,
  createClient: (serverUrl, rootKey) => new CloudCookieClient(serverUrl, rootKey),
  showBadge,
});

export function performUpload(options: { force?: boolean } = {}): Promise<UploadResult> {
  return coordinator.performUpload(options);
}

export function performBookmarksUpload(
  options: { force?: boolean } = {},
): Promise<BookmarksUploadResult> {
  return coordinator.performBookmarksUpload(options);
}

export function performSoftDeleteSlot(slot: number): Promise<SoftDeleteResult> {
  return coordinator.performSoftDeleteSlot(slot);
}

export function performPurgeTombstoneSlot(slot: number): Promise<SoftDeleteResult> {
  return coordinator.performPurgeTombstoneSlot(slot);
}

export function performDeleteAllData(): Promise<DeleteAllResult> {
  return coordinator.performDeleteAllData();
}

export function invalidateUploads(): void {
  coordinator.invalidateUploads();
}
