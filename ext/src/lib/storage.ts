import browser from 'webextension-polyfill';
import { DEFAULT_LOCAL_STATE, LocalState, SyncSettings } from './types';

const SYNC_KEYS: (keyof SyncSettings)[] = ['server_url', 'root_key'];
const LOCAL_KEYS: (keyof LocalState)[] = Object.keys(DEFAULT_LOCAL_STATE) as (keyof LocalState)[];

export async function getSyncSettings(): Promise<SyncSettings> {
  const result = await browser.storage.sync.get(SYNC_KEYS);
  return {
    server_url: typeof result.server_url === 'string' ? result.server_url : '',
    root_key: typeof result.root_key === 'string' ? result.root_key : '',
  };
}

export async function saveSyncSettings(settings: Partial<SyncSettings>): Promise<void> {
  const toSave: Partial<SyncSettings> = {};
  if (settings.server_url !== undefined) toSave.server_url = settings.server_url;
  if (settings.root_key !== undefined) toSave.root_key = settings.root_key;
  await browser.storage.sync.set(toSave);
}

export async function getLocalState(): Promise<LocalState> {
  const result = await browser.storage.local.get(LOCAL_KEYS);
  return {
    ...DEFAULT_LOCAL_STATE,
    ...result,
    using_slot: typeof result.using_slot === 'number' ? result.using_slot : null,
    using_slot_name: typeof result.using_slot_name === 'string' ? result.using_slot_name : null,
    upload_interval_minutes:
      typeof result.upload_interval_minutes === 'number' && result.upload_interval_minutes >= 1
        ? result.upload_interval_minutes
        : DEFAULT_LOCAL_STATE.upload_interval_minutes,
    auto_upload_enabled:
      typeof result.auto_upload_enabled === 'boolean'
        ? result.auto_upload_enabled
        : DEFAULT_LOCAL_STATE.auto_upload_enabled,
    blacklist_domains: Array.isArray(result.blacklist_domains)
      ? result.blacklist_domains
      : DEFAULT_LOCAL_STATE.blacklist_domains,
  };
}

export async function saveLocalState(patch: Partial<LocalState>): Promise<void> {
  await browser.storage.local.set(patch);
}

export async function clearSlotBinding(): Promise<void> {
  await browser.storage.local.set({
    using_slot: null,
    using_slot_name: null,
    last_upload_hash: null,
    last_upload_at: null,
    last_upload_status: null,
    last_upload_error: null,
    last_slot_version: null,
    last_cookie_count: null,
    last_domain_count: null,
  });
}

export async function clearAllExtensionData(): Promise<void> {
  await Promise.all([
    browser.storage.sync.remove(SYNC_KEYS),
    browser.storage.local.clear(),
  ]);
}
