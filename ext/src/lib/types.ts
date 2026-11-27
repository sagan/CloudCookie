export interface SyncSettings {
  server_url: string;
  root_key: string;
}

export interface SlotUploadState {
  last_upload_hash: string | null;
  last_upload_at: number | null;
  last_upload_status: 'ok' | 'error' | null;
  last_upload_error: string | null;
  last_slot_version: number | null;
  last_cookie_count: number | null;
  last_domain_count: number | null;
}

export interface LocalState {
  using_slot: number | null;
  using_slot_name: string | null;
  upload_interval_minutes: number;
  auto_upload_enabled: boolean;
  blacklist_domains: string[];
  last_upload_hash: string | null;
  last_upload_at: number | null;
  last_upload_status: 'ok' | 'error' | null;
  last_upload_error: string | null;
  last_slot_version: number | null;
  last_cookie_count: number | null;
  last_domain_count: number | null;
  highest_slot_versions: Record<string, Record<string, number>>;
  upload_states: Record<string, SlotUploadState>;
}

export const DEFAULT_LOCAL_STATE: LocalState = {
  using_slot: null,
  using_slot_name: null,
  upload_interval_minutes: 5,
  auto_upload_enabled: true,
  blacklist_domains: [],
  last_upload_hash: null,
  last_upload_at: null,
  last_upload_status: null,
  last_upload_error: null,
  last_slot_version: null,
  last_cookie_count: null,
  last_domain_count: null,
  highest_slot_versions: {},
  upload_states: {},
};

/** Slot 0 (Meta Slot) schema */
export interface SlotMetaEntry {
  slot: number;
  name: string;
  created_at: number;
  updated_at: number;
  deleted?: boolean;
}

export interface Slot0Payload {
  schema_version: 1;
  updated_at: number;
  slots: Record<string, SlotMetaEntry>;
}

/** Slot 1+ (Cookie Data Slot) schema */
export interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
  hostOnly: boolean;
  session: boolean;
  storeId?: string;
  partitionKey?: {
    topLevelSite?: string;
    hasCrossSiteAncestor?: boolean;
  } | null;
}

export interface SlotDataPayload {
  schema_version: 1;
  slot: number;
  instance_name: string;
  updated_at: number;
  cookie_count: number;
  domain_count: number;
  cookies: Record<string, SerializedCookie[]>;
}

export type SyncAction = 'get' | 'update' | 'delete' | 'list';

export interface ListSlotEntry {
  slot: number;
  version: number;
  updated_at: string;
  size_bytes: number;
}

export type BackgroundMessage =
  | { type: 'UPLOAD_NOW' }
  | { type: 'GET_STATUS' }
  | { type: 'RESCHEDULE_ALARM' }
  | { type: 'INVALIDATE_UPLOADS' }
  | { type: 'SOFT_DELETE_SLOT'; slot: number }
  | { type: 'PURGE_TOMBSTONE_SLOT'; slot: number }
  | { type: 'DELETE_ALL_DATA' };

export interface SoftDeleteResult {
  ok: boolean;
  meta?: Slot0Payload;
  error?: string;
}

export interface DeleteAllResult {
  ok: boolean;
  error?: string;
}

export interface UploadResult {
  ok: boolean;
  skipped?: boolean;
  cookieCount?: number;
  domainCount?: number;
  version?: number;
  error?: string;
  errorCode?: string;
}
