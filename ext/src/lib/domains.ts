import { getDomain, parse } from 'tldts';

export function normalizeDomainKey(domain: string): string {
  return domain.replace(/^\.+/, '').toLowerCase();
}

export function extractHostnameFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function getRegistrableDomain(hostname: string): string | null {
  const clean = normalizeDomainKey(hostname);
  if (!clean) return null;
  const parsed = parse(clean, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain) {
    return null;
  }
  return parsed.domain.toLowerCase();
}

export function getBaseDomain(hostname: string): string {
  const clean = normalizeDomainKey(hostname);
  if (!clean) return '';
  return getRegistrableDomain(clean) ?? clean;
}

export function filterDomainsForMode(
  domainKeys: string[],
  mode: 'base_domain' | 'domain' | 'all',
  activeHostname: string | null,
): string[] {
  if (mode === 'all') {
    return [...domainKeys].sort((a, b) => a.localeCompare(b));
  }
  if (!activeHostname) {
    return [];
  }
  const exact = normalizeDomainKey(activeHostname);
  if (mode === 'domain') {
    return domainKeys
      .filter((d) => normalizeDomainKey(d) === exact)
      .sort((a, b) => a.localeCompare(b));
  }
  const registrable = getRegistrableDomain(exact);
  if (!registrable) {
    // IP, localhost, or a public suffix itself: never expand across subdomains
    return domainKeys
      .filter((d) => normalizeDomainKey(d) === exact)
      .sort((a, b) => a.localeCompare(b));
  }
  return domainKeys
    .filter((d) => {
      const norm = normalizeDomainKey(d);
      return norm === registrable || norm.endsWith('.' + registrable);
    })
    .sort((a, b) => a.localeCompare(b));
}
