import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHostnameFromUrl,
  filterDomainsForMode,
  getBaseDomain,
} from '../src/lib/domains';
import {
  buildCookieSetDetails,
  buildCookieUrl,
  groupAndSortCookies,
  isValidCookieHostname,
  validateCookieDomain,
} from '../src/lib/cookieValidation';

describe('extractHostnameFromUrl', () => {
  it('extracts lowercase hostname for http/https URLs', () => {
    assert.equal(extractHostnameFromUrl('https://www.Bing.com/search?q=1'), 'www.bing.com');
    assert.equal(extractHostnameFromUrl('http://localhost:3000/test'), 'localhost');
  });

  it('returns null for non-http(s) or invalid URLs', () => {
    assert.equal(extractHostnameFromUrl('chrome://extensions'), null);
    assert.equal(extractHostnameFromUrl('about:blank'), null);
    assert.equal(extractHostnameFromUrl(undefined), null);
    assert.equal(extractHostnameFromUrl('not-a-url'), null);
  });
});

describe('getBaseDomain', () => {
  it('extracts base domain for standard and multi-part TLDs', () => {
    assert.equal(getBaseDomain('www.bing.com'), 'bing.com');
    assert.equal(getBaseDomain('a.b.github.com'), 'github.com');
    assert.equal(getBaseDomain('bing.com'), 'bing.com');
    assert.equal(getBaseDomain('sub.example.co.uk'), 'example.co.uk');
    assert.equal(getBaseDomain('www.tsinghua.edu.cn'), 'tsinghua.edu.cn');
  });

  it('preserves localhost and IP addresses', () => {
    assert.equal(getBaseDomain('localhost'), 'localhost');
    assert.equal(getBaseDomain('127.0.0.1'), '127.0.0.1');
  });

  it('handles full PSL including private and multi-part suffixes', () => {
    assert.equal(getBaseDomain('evil.github.io'), 'evil.github.io');
    assert.equal(getBaseDomain('sub.evil.github.io'), 'evil.github.io');
    assert.equal(getBaseDomain('a.co.il'), 'a.co.il');
    assert.equal(getBaseDomain('foo.com.mx'), 'foo.com.mx');
  });
});

describe('filterDomainsForMode', () => {
  const domains = ['bing.com', 'www.bing.com', 'cn.bing.com', 'github.com', 'notbing.com'];

  it('matches base domain and subdomains in base_domain mode', () => {
    assert.deepEqual(
      filterDomainsForMode(domains, 'base_domain', 'www.bing.com'),
      ['bing.com', 'cn.bing.com', 'www.bing.com'],
    );
  });

  it('matches only exact domain in domain mode', () => {
    assert.deepEqual(
      filterDomainsForMode(domains, 'domain', 'www.bing.com'),
      ['www.bing.com'],
    );
  });

  it('returns all sorted domains in all mode', () => {
    assert.deepEqual(
      filterDomainsForMode(domains, 'all', 'www.bing.com'),
      ['bing.com', 'cn.bing.com', 'github.com', 'notbing.com', 'www.bing.com'],
    );
  });

  it('returns empty array in base_domain/domain mode when activeHostname is null', () => {
    assert.deepEqual(filterDomainsForMode(domains, 'base_domain', null), []);
    assert.deepEqual(filterDomainsForMode(domains, 'domain', null), []);
  });

  it('never expands across public suffixes like github.io or co.il', () => {
    const pslDomains = ['github.io', 'evil.github.io', 'sub.evil.github.io', 'victim.github.io', 'co.il', 'a.co.il', 'b.co.il'];
    assert.deepEqual(
      filterDomainsForMode(pslDomains, 'base_domain', 'evil.github.io'),
      ['evil.github.io', 'sub.evil.github.io'],
    );
    assert.deepEqual(
      filterDomainsForMode(pslDomains, 'base_domain', 'github.io'),
      ['github.io'],
    );
    assert.deepEqual(
      filterDomainsForMode(pslDomains, 'base_domain', 'a.co.il'),
      ['a.co.il'],
    );
    assert.deepEqual(
      filterDomainsForMode(pslDomains, 'base_domain', 'co.il'),
      ['co.il'],
    );
  });
});

describe('cookie domain and schema validation', () => {
  const validCookie = {
    name: 'session',
    value: 'tok',
    domain: 'example.com',
    path: '/app',
    secure: true,
    httpOnly: true,
    hostOnly: true,
    session: false,
    sameSite: 'lax' as const,
    expirationDate: 1800000000,
  };

  it('accepts valid DNS hostnames and IPv4 addresses', () => {
    assert.equal(isValidCookieHostname('example.com'), true);
    assert.equal(isValidCookieHostname('sub.example.co.uk'), true);
    assert.equal(isValidCookieHostname('localhost'), true);
    assert.equal(isValidCookieHostname('127.0.0.1'), true);
    assert.equal(validateCookieDomain('.example.com', 'example.com'), 'example.com');
    assert.equal(
      buildCookieUrl(true, '.example.com', '/login', 'example.com'),
      'https://example.com/login',
    );
  });

  it('rejects @, /, ?, #, ports, whitespace, non-ASCII, and double leading dots', () => {
    const badDomains = [
      'example.com@attacker.com',
      'attacker.com/example.com',
      'example.com?x=1',
      'example.com#frag',
      'example.com:8443',
      'example.com ',
      ' example.com',
      'exámple.com',
      '..example.com',
      '999.0.0.1',
    ];
    for (const bad of badDomains) {
      assert.throws(() => validateCookieDomain(bad, 'example.com'));
    }
  });

  it('rejects cookies whose domain does not match the map key', () => {
    assert.throws(
      () =>
        buildCookieSetDetails(
          'example.com',
          { ...validCookie, domain: 'attacker.com' },
          false,
        ),
      /does not match map key/,
    );
    assert.throws(
      () =>
        buildCookieSetDetails(
          'example.com',
          { ...validCookie, domain: 'example.com@attacker.com' },
          false,
        ),
      /Invalid cookie domain hostname/,
    );
  });

  it('rejects invalid cookie schemas and hostOnly cookies with leading dot', () => {
    assert.throws(
      () =>
        buildCookieSetDetails(
          'example.com',
          { ...validCookie, domain: '.example.com', hostOnly: true },
          false,
        ),
      /must not have a leading dot/,
    );
    assert.throws(
      () => buildCookieSetDetails('example.com', { ...validCookie, path: '/a?b=1' }, false),
      /Invalid cookie path/,
    );
    assert.throws(
      () => buildCookieSetDetails('example.com', { ...validCookie, name: '' }, false),
      /Invalid cookie name/,
    );
    assert.throws(
      () => buildCookieSetDetails('example.com', { ...validCookie, secure: 'yes' }, false),
      /Invalid secure flag/,
    );
  });

  it('builds valid CookieSetDetails for hostOnly and domain cookies', () => {
    const hostOnlyDetails = buildCookieSetDetails('example.com', validCookie, false);
    assert.equal(hostOnlyDetails.url, 'https://example.com/app');
    assert.equal(hostOnlyDetails.domain, undefined);

    const domainDetails = buildCookieSetDetails(
      'example.com',
      { ...validCookie, domain: '.example.com', hostOnly: false },
      false,
    );
    assert.equal(domainDetails.url, 'https://example.com/app');
    assert.equal(domainDetails.domain, '.example.com');
  });

  it('preserves container storeId when target store exists and rejects when missing', () => {
    const containerCookie = { ...validCookie, storeId: 'firefox-container-1' };

    // Preserved when target container store exists
    const preserved = buildCookieSetDetails('example.com', containerCookie, true, {
      availableStoreIds: new Set(['firefox-default', 'firefox-container-1']),
    });
    assert.equal(preserved.storeId, 'firefox-container-1');

    // Rejected when target container store does not exist (never downgraded to default store)
    assert.throws(
      () =>
        buildCookieSetDetails('example.com', containerCookie, false, {
          availableStoreIds: new Set(['0']),
        }),
      /does not exist; refusing to import into default store/,
    );
    assert.throws(
      () => buildCookieSetDetails('example.com', containerCookie, false),
      /does not exist; refusing to import into default store/,
    );

    // Default store IDs omit storeId for cross-browser default-store compatibility
    const defaultChrome = buildCookieSetDetails(
      'example.com',
      { ...validCookie, storeId: '0' },
      false,
    );
    assert.equal(defaultChrome.storeId, undefined);

    const defaultFirefox = buildCookieSetDetails(
      'example.com',
      { ...validCookie, storeId: 'firefox-default' },
      true,
    );
    assert.equal(defaultFirefox.storeId, undefined);
  });

  it('handles Object.prototype keys like constructor and __proto__ without crashing', () => {
    const res = groupAndSortCookies([
      { name: 'a', value: '1', domain: 'constructor', path: '/', hostOnly: true },
      { name: 'b', value: '2', domain: '__proto__', path: '/', hostOnly: true },
      { name: 'c', value: '3', domain: 'toString', path: '/', hostOnly: true },
      { name: 'd', value: '4', domain: 'example.com', path: '/', hostOnly: true },
    ]);

    assert.equal(res.cookieCount, 4);
    assert.equal(res.domainCount, 4);
    assert.equal(res.cookies['constructor']?.[0]?.name, 'a');
    assert.equal(res.cookies['__proto__']?.[0]?.name, 'b');
    assert.equal(res.cookies['tostring']?.[0]?.name, 'c');
    assert.equal(res.cookies['example.com']?.[0]?.name, 'd');
    assert.doesNotThrow(() => JSON.stringify(res.cookies));
  });
});
