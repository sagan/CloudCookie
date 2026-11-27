import { ApiError, CloudCookieClient, normalizeServerUrl } from './api';
import { isValidRootKey } from './crypto';
import { deleteAllServerData, deleteSlotAndMeta, softDeleteSlot } from './slots';
import type {
  DeleteAllResult,
  LocalState,
  SerializedCookie,
  SlotDataPayload,
  SlotUploadState,
  SoftDeleteResult,
  SyncSettings,
  UploadResult,
} from './types';

export function makeUploadTargetKey(serverUrl: string, clientId: string, slot: number): string {
  return `${normalizeServerUrl(serverUrl)}|${clientId}|${slot}`;
}

export interface SyncDependencies {
  getSyncSettings(): Promise<SyncSettings>;
  getLocalState(): Promise<LocalState>;
  saveLocalState(patch: Partial<LocalState>): Promise<void>;
  clearSlotBinding(): Promise<void>;
  clearAllExtensionData(): Promise<void>;
  collectLocalCookies(blacklistDomains: string[]): Promise<{
    cookies: Record<string, SerializedCookie[]>;
    cookieCount: number;
    domainCount: number;
  }>;
  hashCookieMap(cookies: Record<string, SerializedCookie[]>): string;
  createClient(serverUrl: string, rootKey: string): CloudCookieClient;
  showBadge(text: string, color: string, durationMs?: number): void;
}

export interface SyncCoordinator {
  performUpload(options?: { force?: boolean }): Promise<UploadResult>;
  performSoftDeleteSlot(slot: number): Promise<SoftDeleteResult>;
  performPurgeTombstoneSlot(slot: number): Promise<SoftDeleteResult>;
  performDeleteAllData(): Promise<DeleteAllResult>;
  invalidateUploads(): void;
}

export function createSyncCoordinator(deps: SyncDependencies): SyncCoordinator {
  let syncEpoch = 0;
  let opQueue: Promise<unknown> = Promise.resolve();
  const inFlightByTarget = new Map<string, Promise<UploadResult>>();

  function enqueueExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = opQueue.then(fn, fn);
    opQueue = next.catch(() => {});
    return next;
  }

  function invalidateUploads(): void {
    syncEpoch += 1;
    inFlightByTarget.clear();
  }

  async function isSuperseded(expectedEpoch: number, expectedTargetKey: string): Promise<boolean> {
    if (syncEpoch !== expectedEpoch) {
      return true;
    }
    const [sync, local] = await Promise.all([deps.getSyncSettings(), deps.getLocalState()]);
    if (!sync.server_url || !isValidRootKey(sync.root_key) || !local.using_slot || local.using_slot < 1) {
      return true;
    }
    try {
      const client = deps.createClient(sync.server_url, sync.root_key);
      return makeUploadTargetKey(client.serverUrl, client.clientId, local.using_slot) !== expectedTargetKey;
    } catch {
      return true;
    }
  }

  async function performUpload(options: { force?: boolean } = {}): Promise<UploadResult> {
    const [initialSync, initialLocal] = await Promise.all([
      deps.getSyncSettings(),
      deps.getLocalState(),
    ]);
    if (!initialSync.server_url || !isValidRootKey(initialSync.root_key)) {
      return { ok: false, error: 'Server URL or Root Key not configured' };
    }
    if (!initialLocal.using_slot || initialLocal.using_slot < 1) {
      return { ok: false, error: 'No browser slot selected' };
    }

    const initialClient = deps.createClient(initialSync.server_url, initialSync.root_key);
    const targetKey = makeUploadTargetKey(
      initialClient.serverUrl,
      initialClient.clientId,
      initialLocal.using_slot,
    );

    const existing = inFlightByTarget.get(targetKey);
    if (existing) {
      return existing;
    }

    const epochAtStart = syncEpoch;

    const promise = enqueueExclusive(async (): Promise<UploadResult> => {
      try {
        if (await isSuperseded(epochAtStart, targetKey)) {
          return { ok: false, error: 'Upload superseded by slot or connection change' };
        }

        const [sync, local] = await Promise.all([deps.getSyncSettings(), deps.getLocalState()]);
        if (!sync.server_url || !isValidRootKey(sync.root_key)) {
          return { ok: false, error: 'Server URL or Root Key not configured' };
        }
        if (!local.using_slot || local.using_slot < 1) {
          return { ok: false, error: 'No browser slot selected' };
        }

        const client = deps.createClient(sync.server_url, sync.root_key);
        const currentKey = makeUploadTargetKey(client.serverUrl, client.clientId, local.using_slot);
        if (currentKey !== targetKey || syncEpoch !== epochAtStart) {
          return { ok: false, error: 'Upload superseded by slot or connection change' };
        }

        const slot = local.using_slot;
        const slotState: SlotUploadState | undefined = local.upload_states?.[targetKey];

        const { cookies, cookieCount, domainCount } = await deps.collectLocalCookies(
          local.blacklist_domains,
        );
        const hash = deps.hashCookieMap(cookies);

        if (await isSuperseded(epochAtStart, targetKey)) {
          return { ok: false, error: 'Upload superseded by slot or connection change' };
        }

        if (
          !options.force &&
          slotState?.last_upload_hash === hash &&
          slotState?.last_upload_status === 'ok' &&
          slotState?.last_slot_version !== null
        ) {
          const remoteSlots = await client.listSlots();
          const found = remoteSlots.find((s) => s.slot === slot);
          const highestSeen = await client.getHighestSeenVersion(slot);
          if (found && found.version < highestSeen) {
            throw new ApiError(
              200,
              'rollback_detected',
              `Rollback detected for slot ${slot}: server listed version ${found.version}, which is lower than locally recorded version ${highestSeen}.`,
            );
          }
          if (found && found.version === slotState.last_slot_version) {
            if (await isSuperseded(epochAtStart, targetKey)) {
              return { ok: false, error: 'Upload superseded by slot or connection change' };
            }
            return {
              ok: true,
              skipped: true,
              cookieCount,
              domainCount,
              version: found.version,
            };
          }
        }

        if (await isSuperseded(epochAtStart, targetKey)) {
          return { ok: false, error: 'Upload superseded by slot or connection change' };
        }

        const payload: SlotDataPayload = {
          schema_version: 1,
          slot,
          instance_name: local.using_slot_name || `Browser #${slot}`,
          updated_at: Date.now(),
          cookie_count: cookieCount,
          domain_count: domainCount,
          cookies,
        };

        const highestSeen = await client.getHighestSeenVersion(slot);
        const expectedVersion = Math.max(slotState?.last_slot_version ?? 0, highestSeen);

        let res: { slot: number; version: number; updated_at: string };
        try {
          res = await client.updateSlot(slot, expectedVersion, payload);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'version_conflict') {
            let currentVersion = err.currentVersion;
            if (currentVersion === undefined) {
              const slots = await client.listSlots();
              const found = slots.find((s) => s.slot === slot);
              currentVersion = found?.version ?? 0;
            }
            if (currentVersion < expectedVersion) {
              throw new ApiError(
                409,
                'rollback_detected',
                `Rollback detected for slot ${slot}: server reported version ${currentVersion}, which is lower than locally recorded version ${expectedVersion}.`,
                { currentVersion },
              );
            }
            if (await isSuperseded(epochAtStart, targetKey)) {
              return { ok: false, error: 'Upload superseded by slot or connection change' };
            }
            res = await client.updateSlot(slot, currentVersion, payload);
          } else {
            throw err;
          }
        }

        const now = Date.now();
        const nextSlotState: SlotUploadState = {
          last_upload_hash: hash,
          last_upload_at: now,
          last_upload_status: 'ok',
          last_upload_error: null,
          last_slot_version: res.version,
          last_cookie_count: cookieCount,
          last_domain_count: domainCount,
        };

        const latestLocal = await deps.getLocalState();
        const nextUploadStates = {
          ...(latestLocal.upload_states ?? {}),
          [targetKey]: nextSlotState,
        };

        if (await isSuperseded(epochAtStart, targetKey)) {
          await deps.saveLocalState({ upload_states: nextUploadStates });
          return {
            ok: true,
            cookieCount,
            domainCount,
            version: res.version,
          };
        }

        await deps.saveLocalState({
          ...nextSlotState,
          upload_states: nextUploadStates,
        });
        deps.showBadge('↑', '#16a34a');
        return {
          ok: true,
          cookieCount,
          domainCount,
          version: res.version,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorCode = err instanceof ApiError ? err.code : undefined;

        if (!(await isSuperseded(epochAtStart, targetKey))) {
          const latestLocal = await deps.getLocalState();
          const prevSlotState = latestLocal.upload_states?.[targetKey];
          const nextSlotState: SlotUploadState = {
            last_upload_hash: prevSlotState?.last_upload_hash ?? null,
            last_upload_at: Date.now(),
            last_upload_status: 'error',
            last_upload_error: errorMsg,
            last_slot_version: prevSlotState?.last_slot_version ?? null,
            last_cookie_count: prevSlotState?.last_cookie_count ?? null,
            last_domain_count: prevSlotState?.last_domain_count ?? null,
          };
          await deps.saveLocalState({
            last_upload_at: nextSlotState.last_upload_at,
            last_upload_status: 'error',
            last_upload_error: errorMsg,
            upload_states: {
              ...(latestLocal.upload_states ?? {}),
              [targetKey]: nextSlotState,
            },
          });
          deps.showBadge('!', '#dc2626', errorCode === 'rollback_detected' ? 0 : 4000);
        }

        return { ok: false, error: errorMsg, errorCode };
      } finally {
        if (inFlightByTarget.get(targetKey) === promise) {
          inFlightByTarget.delete(targetKey);
        }
      }
    });

    inFlightByTarget.set(targetKey, promise);
    return promise;
  }

  async function performSoftDeleteSlot(slot: number): Promise<SoftDeleteResult> {
    invalidateUploads();
    return enqueueExclusive(async () => {
      try {
        const [sync, local] = await Promise.all([deps.getSyncSettings(), deps.getLocalState()]);
        if (!sync.server_url || !isValidRootKey(sync.root_key)) {
          return { ok: false, error: 'Server URL or Root Key not configured' };
        }
        const client = deps.createClient(sync.server_url, sync.root_key);
        const meta = await softDeleteSlot(client, slot);

        const targetKey = makeUploadTargetKey(client.serverUrl, client.clientId, slot);
        const latestLocal = await deps.getLocalState();
        const nextUploadStates = { ...(latestLocal.upload_states ?? {}) };
        delete nextUploadStates[targetKey];
        await deps.saveLocalState({ upload_states: nextUploadStates });

        if (local.using_slot === slot) {
          await deps.clearSlotBinding();
        }
        return { ok: true, meta };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async function performPurgeTombstoneSlot(slot: number): Promise<SoftDeleteResult> {
    invalidateUploads();
    return enqueueExclusive(async () => {
      try {
        const [sync, local] = await Promise.all([deps.getSyncSettings(), deps.getLocalState()]);
        if (!sync.server_url || !isValidRootKey(sync.root_key)) {
          return { ok: false, error: 'Server URL or Root Key not configured' };
        }
        const client = deps.createClient(sync.server_url, sync.root_key);
        const meta = await deleteSlotAndMeta(client, slot);

        const targetKey = makeUploadTargetKey(client.serverUrl, client.clientId, slot);
        const latestLocal = await deps.getLocalState();
        const nextUploadStates = { ...(latestLocal.upload_states ?? {}) };
        delete nextUploadStates[targetKey];
        await deps.saveLocalState({ upload_states: nextUploadStates });

        if (local.using_slot === slot) {
          await deps.clearSlotBinding();
        }
        return { ok: true, meta };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  async function performDeleteAllData(): Promise<DeleteAllResult> {
    invalidateUploads();
    return enqueueExclusive(async () => {
      try {
        const sync = await deps.getSyncSettings();
        if (sync.server_url && isValidRootKey(sync.root_key)) {
          const client = deps.createClient(sync.server_url, sync.root_key);
          await deleteAllServerData(client);
        }
        await deps.clearAllExtensionData();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  return {
    performUpload,
    performSoftDeleteSlot,
    performPurgeTombstoneSlot,
    performDeleteAllData,
    invalidateUploads,
  };
}
