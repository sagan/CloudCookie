import type { SerializedCookie } from './types';

export type CookieExportFormat = 'json' | 'header' | 'netscape';

export const COOKIE_EXPORT_FORMATS: ReadonlyArray<{
  id: CookieExportFormat;
  label: string;
}> = [
  { id: 'json', label: 'JSON' },
  { id: 'header', label: 'Header String' },
  { id: 'netscape', label: 'Netscape' },
];

export function collectCookiesForDomains(
  cookiesByDomain: Record<string, SerializedCookie[]>,
  targetDomains?: string[],
): SerializedCookie[] {
  const domains = targetDomains
    ? targetDomains.filter((d) => Array.isArray(cookiesByDomain[d]))
    : Object.keys(cookiesByDomain);

  const result: SerializedCookie[] = [];
  for (const domainKey of domains) {
    const list = cookiesByDomain[domainKey];
    if (Array.isArray(list)) {
      result.push(...list);
    }
  }
  return result;
}

export function formatCookiesForExport(
  cookies: SerializedCookie[],
  format: CookieExportFormat,
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(cookies, null, 2);

    case 'header':
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    case 'netscape': {
      const lines = [
        '# Netscape HTTP Cookie File',
        '# https://curl.haxx.se/rfc/cookie_spec.html',
        '# This is a generated file! Do not edit.',
      ];
      for (const cookie of cookies) {
        const domain =
          !cookie.hostOnly && !cookie.domain.startsWith('.')
            ? `.${cookie.domain}`
            : cookie.domain;
        const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const path = cookie.path || '/';
        const secure = cookie.secure ? 'TRUE' : 'FALSE';
        const expiration =
          cookie.expirationDate !== undefined && Number.isFinite(cookie.expirationDate)
            ? Math.round(cookie.expirationDate).toString()
            : '0';
        lines.push(
          `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiration}\t${cookie.name}\t${cookie.value}`,
        );
      }
      return lines.join('\n');
    }
  }
}
