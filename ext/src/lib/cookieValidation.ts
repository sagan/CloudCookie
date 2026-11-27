import { normalizeDomainKey } from './domains';
import type { SerializedCookie } from './types';

const VALID_SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);
const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a normalized ASCII hostname (no leading dot, no port, no userinfo,
 * no path/query/fragment, no whitespace or non-ASCII characters).
 */
export function isValidCookieHostname(host: string): boolean {
  if (!host || host.length > 253) return false;
  // Reject non-ASCII, whitespace, control chars, and URL delimiters
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;

  const lower = host.toLowerCase();
  const ipv4Match = IPV4_REGEX.exec(lower);
  if (ipv4Match) {
    return ipv4Match.slice(1, 5).every((octet) => {
      const n = Number(octet);
      return n >= 0 && n <= 255 && String(n) === octet;
    });
  }

  if (lower.startsWith('.') || lower.endsWith('.') || lower.includes('..')) {
    return false;
  }

  const labels = lower.split('.');
  return labels.every((label) => DNS_LABEL_REGEX.test(label));
}

/**
 * Validates `cookie.domain` against strict hostname grammar and ensures it
 * matches the map key `domainKey`. Returns the normalized clean hostname.
 */
export function validateCookieDomain(cookieDomain: string, expectedDomainKey: string): string {
  if (typeof cookieDomain !== 'string' || typeof expectedDomainKey !== 'string') {
    throw new Error('Cookie domain must be a string');
  }

  const normalizedKey = normalizeDomainKey(expectedDomainKey);
  if (!isValidCookieHostname(normalizedKey)) {
    throw new Error(`Invalid domain key: ${expectedDomainKey}`);
  }

  // Allow at most one optional leading dot for domain cookies (e.g. ".example.com")
  const trimmed = cookieDomain.trim();
  if (trimmed !== cookieDomain) {
    throw new Error(`Cookie domain contains leading/trailing whitespace`);
  }
  if (cookieDomain.startsWith('..')) {
    throw new Error(`Invalid cookie domain: ${cookieDomain}`);
  }

  const cleanDomain = (cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain).toLowerCase();
  if (!isValidCookieHostname(cleanDomain)) {
    throw new Error(`Invalid cookie domain hostname: ${cookieDomain}`);
  }

  if (cleanDomain !== normalizedKey) {
    throw new Error(`Cookie domain "${cookieDomain}" does not match map key "${expectedDomainKey}"`);
  }

  return cleanDomain;
}

export function buildCookieUrl(
  secure: boolean,
  cookieDomain: string,
  path: string,
  expectedDomainKey: string,
): string {
  const cleanDomain = validateCookieDomain(cookieDomain, expectedDomainKey);

  if (typeof path !== 'string' || /[\r\n\0]/.test(path)) {
    throw new Error('Invalid cookie path');
  }
  const cleanPath = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
  if (cleanPath.includes('?') || cleanPath.includes('#')) {
    throw new Error(`Cookie path must not contain query or fragment delimiters: ${path}`);
  }

  const expectedProtocol = secure ? 'https:' : 'http:';
  const url = new URL(`${expectedProtocol}//${cleanDomain}${cleanPath}`);

  if (url.protocol !== expectedProtocol) {
    throw new Error(`Unexpected URL protocol: ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    throw new Error(`Cookie URL must not contain credentials or port`);
  }
  if (url.hostname.toLowerCase() !== cleanDomain) {
    throw new Error(`Cookie URL hostname mismatch: ${url.hostname} !== ${cleanDomain}`);
  }

  return url.href;
}

export function validateSerializedCookie(raw: unknown, expectedDomainKey: string): SerializedCookie {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Cookie entry must be an object');
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.name !== 'string' || c.name.length === 0 || /[\r\n\0]/.test(c.name)) {
    throw new Error('Invalid cookie name');
  }
  if (typeof c.value !== 'string') {
    throw new Error(`Invalid cookie value for "${c.name}"`);
  }
  if (typeof c.domain !== 'string') {
    throw new Error(`Invalid cookie domain for "${c.name}"`);
  }
  validateCookieDomain(c.domain, expectedDomainKey);

  const path = c.path === undefined ? '/' : c.path;
  if (typeof path !== 'string' || /[\r\n\0]/.test(path) || path.includes('?') || path.includes('#')) {
    throw new Error(`Invalid cookie path for "${c.name}"`);
  }
  if (typeof c.secure !== 'boolean') {
    throw new Error(`Invalid secure flag for "${c.name}"`);
  }
  if (typeof c.httpOnly !== 'boolean') {
    throw new Error(`Invalid httpOnly flag for "${c.name}"`);
  }
  if (typeof c.hostOnly !== 'boolean') {
    throw new Error(`Invalid hostOnly flag for "${c.name}"`);
  }
  if (c.hostOnly && c.domain.startsWith('.')) {
    throw new Error(`hostOnly cookie "${c.name}" must not have a leading dot in domain`);
  }
  if (typeof c.session !== 'boolean') {
    throw new Error(`Invalid session flag for "${c.name}"`);
  }
  if (c.sameSite !== undefined && (typeof c.sameSite !== 'string' || !VALID_SAME_SITE.has(c.sameSite))) {
    throw new Error(`Invalid sameSite value for "${c.name}"`);
  }
  if (c.expirationDate !== undefined && (typeof c.expirationDate !== 'number' || !Number.isFinite(c.expirationDate))) {
    throw new Error(`Invalid expirationDate for "${c.name}"`);
  }
  if (c.storeId !== undefined && typeof c.storeId !== 'string') {
    throw new Error(`Invalid storeId for "${c.name}"`);
  }
  if (c.partitionKey !== undefined && c.partitionKey !== null) {
    if (typeof c.partitionKey !== 'object' || Array.isArray(c.partitionKey)) {
      throw new Error(`Invalid partitionKey for "${c.name}"`);
    }
    const pk = c.partitionKey as Record<string, unknown>;
    if (pk.topLevelSite !== undefined && typeof pk.topLevelSite !== 'string') {
      throw new Error(`Invalid partitionKey.topLevelSite for "${c.name}"`);
    }
    if (pk.hasCrossSiteAncestor !== undefined && typeof pk.hasCrossSiteAncestor !== 'boolean') {
      throw new Error(`Invalid partitionKey.hasCrossSiteAncestor for "${c.name}"`);
    }
  }

  return c as unknown as SerializedCookie;
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  domain?: string;
  storeId?: string;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
  partitionKey?: SerializedCookie['partitionKey'];
}

export function isDefaultStoreId(storeId?: string): boolean {
  return !storeId || storeId === '0' || storeId === 'firefox-default';
}

export function buildCookieSetDetails(
  domainKey: string,
  rawCookie: unknown,
  firefox: boolean,
  options?: { availableStoreIds?: Set<string> },
): CookieSetDetails {
  const cookie = validateSerializedCookie(rawCookie, domainKey);
  const path = cookie.path || '/';
  const url = buildCookieUrl(cookie.secure, cookie.domain, path, domainKey);

  const details: CookieSetDetails = {
    url,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };

  // __Host- cookies and hostOnly cookies MUST omit `domain`
  const isHostPrefix = cookie.name.startsWith('__Host-');
  if (!cookie.hostOnly && !isHostPrefix && cookie.domain) {
    details.domain = cookie.domain;
  }

  if (cookie.sameSite) {
    if (cookie.sameSite === 'unspecified' && firefox) {
      details.sameSite = 'no_restriction';
    } else if (cookie.sameSite !== 'unspecified') {
      details.sameSite = cookie.sameSite;
    }
  }

  if (!cookie.session && typeof cookie.expirationDate === 'number') {
    details.expirationDate = cookie.expirationDate;
  }

  if (cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }

  if (!isDefaultStoreId(cookie.storeId)) {
    if (!options?.availableStoreIds || !options.availableStoreIds.has(cookie.storeId!)) {
      throw new Error(
        `Target cookie store "${cookie.storeId}" does not exist; refusing to import into default store`,
      );
    }
    details.storeId = cookie.storeId;
  }

  return details;
}

export interface RawCookieLike {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string;
  partitionKey?: SerializedCookie['partitionKey'];
}

function isDomainBlacklisted(cookieDomain: string, blacklist: string[]): boolean {
  const normalized = normalizeDomainKey(cookieDomain);
  for (const raw of blacklist) {
    const pattern = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (!pattern) continue;
    if (normalized === pattern || normalized.endsWith('.' + pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Groups and sorts cookies by normalized domain key using a Map to avoid
 * Object.prototype collisions (e.g. `constructor`, `__proto__`, `toString`).
 */
export function groupAndSortCookies(
  rawCookies: RawCookieLike[],
  blacklistDomains: string[] = [],
): {
  cookies: Record<string, SerializedCookie[]>;
  cookieCount: number;
  domainCount: number;
} {
  const grouped = new Map<string, SerializedCookie[]>();
  let cookieCount = 0;

  for (const c of rawCookies) {
    if (!c.domain) continue;
    if (isDomainBlacklisted(c.domain, blacklistDomains)) continue;

    const key = normalizeDomainKey(c.domain);
    let list = grouped.get(key);
    if (!list) {
      list = [];
      grouped.set(key, list);
    }

    const serialized: SerializedCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      sameSite: c.sameSite as SerializedCookie['sameSite'],
      hostOnly: Boolean(c.hostOnly),
      session: Boolean(c.session),
    };

    if (!c.session && typeof c.expirationDate === 'number') {
      serialized.expirationDate = c.expirationDate;
    }
    if (c.storeId !== undefined) {
      serialized.storeId = c.storeId;
    }
    if (c.partitionKey) {
      serialized.partitionKey = c.partitionKey;
    }

    list.push(serialized);
    cookieCount++;
  }

  const sortedGrouped = Object.create(null) as Record<string, SerializedCookie[]>;
  const sortedKeys = Array.from(grouped.keys()).sort();
  for (const key of sortedKeys) {
    const sortedList = grouped.get(key)!.sort((a, b) => {
      if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.name.localeCompare(b.name);
    });
    Object.defineProperty(sortedGrouped, key, {
      value: sortedList,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return {
    cookies: sortedGrouped,
    cookieCount,
    domainCount: sortedKeys.length,
  };
}
