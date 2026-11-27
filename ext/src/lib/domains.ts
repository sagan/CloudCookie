export function normalizeDomainKey(domain: string): string {
  return domain.replace(/^\.+/, '').toLowerCase();
}

const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk',
  'co.kr', 'or.kr', 'ne.kr', 're.kr',
  'com.br', 'org.br', 'net.br',
  'com.sg', 'org.sg', 'edu.sg',
  'co.in', 'net.in', 'org.in',
  'co.nz', 'org.nz', 'net.nz',
  'co.za', 'org.za', 'net.za',
]);

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

export function getBaseDomain(hostname: string): string {
  const clean = normalizeDomainKey(hostname);
  if (!clean) return '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean) || clean.includes(':') || !clean.includes('.')) {
    return clean;
  }
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) {
    return parts.join('.');
  }
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
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
  const base = getBaseDomain(exact);
  return domainKeys
    .filter((d) => {
      const norm = normalizeDomainKey(d);
      return norm === base || norm.endsWith('.' + base);
    })
    .sort((a, b) => a.localeCompare(b));
}
