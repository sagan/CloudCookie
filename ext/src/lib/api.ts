import {
  decryptSlot,
  deriveKeys,
  type DerivedKeys,
  encryptSlot,
  generateRequestNonce,
  signSyncRequest,
} from './crypto';
import type { ListSlotEntry, SyncAction } from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  currentVersion?: number;
  serverTime?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: { currentVersion?: number; serverTime?: number },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.currentVersion = extra?.currentVersion;
    this.serverTime = extra?.serverTime;
  }
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Server URL is required');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Server URL must use http or https');
  }
  return url.origin;
}

export interface SlotVersionStore {
  getHighestVersion(clientId: string, slot: number): Promise<number>;
  setHighestVersion(clientId: string, slot: number, version: number): Promise<void>;
}

function createDefaultVersionStore(): SlotVersionStore {
  const memoryFallback = new Map<string, number>();

  const hasBrowserRuntime = (): boolean => {
    const g = globalThis as { chrome?: { runtime?: { id?: string } }; browser?: { storage?: unknown } };
    return Boolean(g.chrome?.runtime?.id || g.browser?.storage);
  };

  return {
    async getHighestVersion(clientId: string, slot: number): Promise<number> {
      if (hasBrowserRuntime()) {
        const { getHighestSlotVersion } = await import('./storage');
        return getHighestSlotVersion(clientId, slot);
      }
      return memoryFallback.get(`${clientId}:${slot}`) ?? 0;
    },
    async setHighestVersion(clientId: string, slot: number, version: number): Promise<void> {
      if (hasBrowserRuntime()) {
        const { recordHighestSlotVersion } = await import('./storage');
        await recordHighestSlotVersion(clientId, slot, version);
        return;
      }
      const key = `${clientId}:${slot}`;
      const prev = memoryFallback.get(key) ?? 0;
      if (version > prev) {
        memoryFallback.set(key, version);
      }
    },
  };
}

export class CloudCookieClient {
  readonly serverUrl: string;
  readonly keys: DerivedKeys;
  private readonly versionStore: SlotVersionStore;
  private clockOffsetSecs = 0;

  constructor(serverUrl: string, rootKeyHex: string, versionStore?: SlotVersionStore) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.keys = deriveKeys(rootKeyHex);
    this.versionStore = versionStore ?? createDefaultVersionStore();
  }

  get clientId(): string {
    return this.keys.clientId;
  }

  async getHighestSeenVersion(slot: number): Promise<number> {
    return this.versionStore.getHighestVersion(this.clientId, slot);
  }

  private nowSecs(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSecs;
  }

  private async postSync<T extends Record<string, unknown>>(
    action: SyncAction,
    buildBody: (timestamp: number, nonce: string) => Record<string, unknown>,
    retryOnClockSkew = true,
  ): Promise<T> {
    const timestamp = this.nowSecs();
    const nonce = generateRequestNonce();
    const body = buildBody(timestamp, nonce);

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(0, 'network_error', `Network error contacting ${this.serverUrl}: ${msg}`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        `Server returned non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok || json.ok !== true) {
      const code = typeof json.error === 'string' ? json.error : `http_${response.status}`;
      const message =
        typeof json.message === 'string' ? json.message : `Request failed with ${code}`;
      const serverTime = typeof json.server_time === 'number' ? json.server_time : undefined;
      const currentVersion =
        typeof json.current_version === 'number' ? json.current_version : undefined;

      if (
        retryOnClockSkew &&
        response.status === 401 &&
        code === 'timestamp_expired' &&
        serverTime !== undefined
      ) {
        this.clockOffsetSecs = serverTime - Math.floor(Date.now() / 1000);
        return this.postSync<T>(action, buildBody, false);
      }

      throw new ApiError(response.status, code, message, { currentVersion, serverTime });
    }

    // Verify response consistency per PROTOCOL.md
    if (json.action !== action) {
      throw new ApiError(response.status, 'protocol_mismatch', 'Response action mismatch');
    }
    if (json.client_id !== undefined && json.client_id !== this.clientId) {
      throw new ApiError(response.status, 'protocol_mismatch', 'Response client_id mismatch');
    }

    return json as T;
  }

  async listSlots(): Promise<ListSlotEntry[]> {
    const res = await this.postSync<{ ok: true; action: 'list'; client_id: string; slots: ListSlotEntry[] }>(
      'list',
      (timestamp, nonce) => ({
        action: 'list',
        client_id: this.clientId,
        timestamp,
        nonce,
        signature: signSyncRequest({
          skAuth: this.keys.skAuth,
          action: 'list',
          clientId: this.clientId,
          slot: '-',
          timestamp,
          nonce,
        }),
      }),
    );
    return Array.isArray(res.slots) ? res.slots : [];
  }

  async getSlot<T = unknown>(slot: number): Promise<{
    slot: number;
    version: number;
    updated_at: string;
    data: T;
  }> {
    const res = await this.postSync<{
      ok: true;
      action: 'get';
      client_id: string;
      slot: number;
      encrypted: string;
      updated_at: string;
      version: number;
    }>('get', (timestamp, nonce) => ({
      action: 'get',
      client_id: this.clientId,
      slot,
      timestamp,
      nonce,
      signature: signSyncRequest({
        skAuth: this.keys.skAuth,
        action: 'get',
        clientId: this.clientId,
        slot,
        timestamp,
        nonce,
      }),
    }));

    if (res.slot !== slot) {
      throw new ApiError(200, 'protocol_mismatch', 'Response slot mismatch');
    }
    if (!Number.isInteger(res.version) || res.version < 1) {
      throw new ApiError(200, 'protocol_mismatch', 'Response version is invalid');
    }

    const highestSeen = await this.versionStore.getHighestVersion(this.clientId, slot);
    if (res.version < highestSeen) {
      throw new ApiError(
        200,
        'rollback_detected',
        `Rollback detected for slot ${slot}: server returned version ${res.version}, which is lower than locally recorded version ${highestSeen}.`,
      );
    }

    // AAD must use locally derived clientId and requested slot
    const plaintext = decryptSlot(this.keys.kEnc, this.clientId, slot, res.version, res.encrypted);
    const data = JSON.parse(plaintext) as T;

    if (res.version > highestSeen) {
      await this.versionStore.setHighestVersion(this.clientId, slot, res.version);
    }

    return {
      slot,
      version: res.version,
      updated_at: res.updated_at,
      data,
    };
  }

  async updateSlot(
    slot: number,
    expectedVersion: number,
    payload: unknown,
  ): Promise<{ slot: number; version: number; updated_at: string }> {
    const highestSeen = await this.versionStore.getHighestVersion(this.clientId, slot);
    if (expectedVersion < highestSeen) {
      throw new ApiError(
        409,
        'rollback_detected',
        `Rollback detected for slot ${slot}: expected version ${expectedVersion} is lower than locally recorded version ${highestSeen}.`,
        { currentVersion: highestSeen },
      );
    }

    const nextVersion = expectedVersion + 1;
    const plaintext = JSON.stringify(payload);
    const encrypted = encryptSlot(this.keys.kEnc, this.clientId, slot, nextVersion, plaintext);

    const res = await this.postSync<{
      ok: true;
      action: 'update';
      slot: number;
      version: number;
      updated_at: string;
    }>('update', (timestamp, nonce) => ({
      action: 'update',
      client_id: this.clientId,
      slot,
      expected_version: expectedVersion,
      timestamp,
      nonce,
      encrypted,
      signature: signSyncRequest({
        skAuth: this.keys.skAuth,
        action: 'update',
        clientId: this.clientId,
        slot,
        expectedVersion,
        timestamp,
        nonce,
        encryptedBase64: encrypted,
      }),
    }));

    if (res.slot !== slot || res.version !== nextVersion) {
      throw new ApiError(200, 'protocol_mismatch', 'Response slot or version mismatch');
    }

    await this.versionStore.setHighestVersion(this.clientId, slot, res.version);

    return {
      slot: res.slot,
      version: res.version,
      updated_at: res.updated_at,
    };
  }

  async deleteSlot(slot: number | 'all'): Promise<void> {
    await this.postSync('delete', (timestamp, nonce) => ({
      action: 'delete',
      client_id: this.clientId,
      slot,
      timestamp,
      nonce,
      signature: signSyncRequest({
        skAuth: this.keys.skAuth,
        action: 'delete',
        clientId: this.clientId,
        slot,
        timestamp,
        nonce,
      }),
    }));
  }
}
