import browser from 'webextension-polyfill';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { normalizeDomainKey } from './domains';
import { SerializedCookie } from './types';

export { normalizeDomainKey };

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

export async function collectLocalCookies(blacklistDomains: string[] = []): Promise<{
  cookies: Record<string, SerializedCookie[]>;
  cookieCount: number;
  domainCount: number;
}> {
  // Attempt to include partitioned cookies if supported by the browser, else fallback to standard getAll({})
  let rawCookies: browser.Cookies.Cookie[];
  try {
    rawCookies = await browser.cookies.getAll({ partitionKey: {} } as browser.Cookies.GetAllDetailsType);
  } catch {
    rawCookies = await browser.cookies.getAll({});
  }

  const grouped: Record<string, SerializedCookie[]> = {};
  let cookieCount = 0;

  for (const c of rawCookies) {
    if (!c.domain) continue;
    if (isDomainBlacklisted(c.domain, blacklistDomains)) continue;

    const key = normalizeDomainKey(c.domain);
    if (!grouped[key]) {
      grouped[key] = [];
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
    if ((c as unknown as { partitionKey?: SerializedCookie['partitionKey'] }).partitionKey) {
      serialized.partitionKey = (c as unknown as { partitionKey: SerializedCookie['partitionKey'] }).partitionKey;
    }

    grouped[key].push(serialized);
    cookieCount++;
  }

  // Sort domain keys and cookies within each domain for deterministic hashing
  const sortedGrouped: Record<string, SerializedCookie[]> = {};
  const sortedKeys = Object.keys(grouped).sort();
  for (const key of sortedKeys) {
    sortedGrouped[key] = grouped[key].sort((a, b) => {
      if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.name.localeCompare(b.name);
    });
  }

  return {
    cookies: sortedGrouped,
    cookieCount,
    domainCount: sortedKeys.length,
  };
}

export function hashCookieMap(cookies: Record<string, SerializedCookie[]>): string {
  const json = JSON.stringify(cookies);
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}

function buildCookieUrl(secure: boolean, domain: string, path: string): string {
  const cleanDomain = domain.replace(/^\.+/, '');
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return `http${secure ? 's' : ''}://${cleanDomain}${cleanPath}`;
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

  for (const domainKey of domainsToImport) {
    const list = cookiesByDomain[domainKey] || [];
    for (const cookie of list) {
      const details: browser.Cookies.SetDetailsType = {
        url: buildCookieUrl(cookie.secure, cookie.domain, cookie.path || '/'),
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
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
        (details as unknown as { partitionKey?: SerializedCookie['partitionKey'] }).partitionKey =
          cookie.partitionKey;
      }

      try {
        const res = await browser.cookies.set(details);
        if (res) {
          imported++;
        } else {
          failed++;
          errors.push(`${domainKey} (${cookie.name}): browser.cookies.set returned null`);
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${domainKey} (${cookie.name}): ${msg}`);
      }
    }
  }

  return { imported, failed, errors };
}
