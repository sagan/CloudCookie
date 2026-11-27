import browser from 'webextension-polyfill';
import { ApiError, CloudCookieClient } from './api';
import { collectLocalCookies, hashCookieMap } from './cookies';
import { isValidRootKey } from './crypto';
import { getLocalState, getSyncSettings, saveLocalState } from './storage';
import { SlotDataPayload, UploadResult } from './types';

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

let uploadInFlight: Promise<UploadResult> | null = null;

export async function performUpload(options: { force?: boolean } = {}): Promise<UploadResult> {
  if (uploadInFlight) {
    return uploadInFlight;
  }

  uploadInFlight = (async () => {
    try {
      const [sync, local] = await Promise.all([getSyncSettings(), getLocalState()]);
      if (!sync.server_url || !isValidRootKey(sync.root_key)) {
        return { ok: false, error: 'Server URL or Root Key not configured' };
      }
      if (!local.using_slot || local.using_slot < 1) {
        return { ok: false, error: 'No browser slot selected' };
      }

      const { cookies, cookieCount, domainCount } = await collectLocalCookies(
        local.blacklist_domains,
      );
      const hash = hashCookieMap(cookies);

      if (!options.force && local.last_upload_hash === hash && local.last_upload_status === 'ok') {
        return {
          ok: true,
          skipped: true,
          cookieCount,
          domainCount,
          version: local.last_slot_version ?? undefined,
        };
      }

      const client = new CloudCookieClient(sync.server_url, sync.root_key);
      const payload: SlotDataPayload = {
        schema_version: 1,
        slot: local.using_slot,
        instance_name: local.using_slot_name || `Browser #${local.using_slot}`,
        updated_at: Date.now(),
        cookie_count: cookieCount,
        domain_count: domainCount,
        cookies,
      };

      let expectedVersion = local.last_slot_version ?? 0;

      try {
        const res = await client.updateSlot(local.using_slot, expectedVersion, payload);
        await saveLocalState({
          last_upload_hash: hash,
          last_upload_at: Date.now(),
          last_upload_status: 'ok',
          last_upload_error: null,
          last_slot_version: res.version,
          last_cookie_count: cookieCount,
          last_domain_count: domainCount,
        });
        showBadge('↑', '#16a34a');
        return {
          ok: true,
          cookieCount,
          domainCount,
          version: res.version,
        };
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          let currentVersion = err.currentVersion;
          if (currentVersion === undefined) {
            const slots = await client.listSlots();
            const found = slots.find((s) => s.slot === local.using_slot);
            currentVersion = found?.version ?? 0;
          }
          const res = await client.updateSlot(local.using_slot, currentVersion, payload);
          await saveLocalState({
            last_upload_hash: hash,
            last_upload_at: Date.now(),
            last_upload_status: 'ok',
            last_upload_error: null,
            last_slot_version: res.version,
            last_cookie_count: cookieCount,
            last_domain_count: domainCount,
          });
          showBadge('↑', '#16a34a');
          return {
            ok: true,
            cookieCount,
            domainCount,
            version: res.version,
          };
        }
        throw err;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof ApiError ? err.code : undefined;
      await saveLocalState({
        last_upload_at: Date.now(),
        last_upload_status: 'error',
        last_upload_error: errorMsg,
      });
      showBadge('!', '#dc2626');
      return { ok: false, error: errorMsg, errorCode };
    } finally {
      uploadInFlight = null;
    }
  })();

  return uploadInFlight;
}
