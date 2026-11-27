import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractHostnameFromUrl,
  filterDomainsForMode,
  getBaseDomain,
} from '../src/lib/domains';

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
});
