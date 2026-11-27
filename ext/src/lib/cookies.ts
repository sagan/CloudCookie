import browser from 'webextension-polyfill';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildCookieSetDetails, groupAndSortCookies, type RawCookieLike } from './cookieValidation';
import { normalizeDomainKey } from './domains';
import type { SerializedCookie } from './types';

export { normalizeDomainKey };

function isPrivateStoreId(storeId: string | undefined, storeIncognito?: boolean): boolean {
  if (storeIncognito) return true;
  return storeId === 'firefox-private';
}

async function getNonPrivateStoreIds(): Promise<Set<string> | undefined> {
  try {
    const stores = await browser.cookies.getAllCookieStores();
    const ids = new Set<string>();
    for (const s of stores) {
      const inc = (s as unknown as { incognito?: boolean }).incognito;
      if (!isPrivateStoreId(s.id, inc)) {
        ids.add(s.id);
      }
    }
    return ids;
  } catch {
    return undefined;
  }
}

export async function collectLocalCookies(blacklistDomains: string[] = []): Promise<{
  cookies: Record<string, SerializedCookie[]>;
  cookieCount: number;
  domainCount: number;
}> {
  const allowedStores = await getNonPrivateStoreIds();

  // Attempt to include partitioned cookies if supported by the browser, else fallback to standard getAll({})
  let rawCookies: browser.Cookies.Cookie[];
  try {
    rawCookies = await browser.cookies.getAll({ partitionKey: {} } as browser.Cookies.GetAllDetailsType);
  } catch {
    rawCookies = await browser.cookies.getAll({});
  }

  const filtered: RawCookieLike[] = [];
  for (const c of rawCookies) {
    if (!c.domain) continue;
    if (isPrivateStoreId(c.storeId)) continue;
    if (allowedStores && c.storeId !== undefined && !allowedStores.has(c.storeId)) continue;
    filtered.push(c as unknown as RawCookieLike);
  }

  return groupAndSortCookies(filtered, blacklistDomains);
}

export function hashCookieMap(cookies: Record<string, SerializedCookie[]>): string {
  const json = JSON.stringify(cookies);
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

function isFirefox(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox');
}

export async function importCookies(
  cookiesByDomain: Record<string, SerializedCookie[]>,
  targetDomains?: string[],
): Promise<{ imported: number; failed: number; errors: string[] }> {
  const domainsToImport = targetDomains
    ? targetDomains.filter((d) => Array.isArray(cookiesByDomain[d]))
    : Object.keys(cookiesByDomain);

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const firefox = isFirefox();
  const availableStoreIds = await getNonPrivateStoreIds();

  for (const domainKey of domainsToImport) {
    const list = cookiesByDomain[domainKey];
    if (!Array.isArray(list)) continue;

    for (const cookie of list) {
      try {
        const details = buildCookieSetDetails(
          domainKey,
          cookie,
          firefox,
          { availableStoreIds },
        ) as browser.Cookies.SetDetailsType;
        const res = await browser.cookies.set(details);
        if (res) {
          imported++;
        } else {
          failed++;
          errors.push(`${domainKey} (${cookie?.name ?? '?'}): browser.cookies.set returned null`);
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${domainKey} (${(cookie as { name?: string })?.name ?? '?'}): ${msg}`);
      }
    }
  }

  return { imported, failed, errors };
}
