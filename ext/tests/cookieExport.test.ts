import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCookiesForDomains,
  formatCookiesForExport,
} from '../src/lib/cookieExport.ts';
import type { SerializedCookie } from '../src/lib/types.ts';

const sampleCookies: Record<string, SerializedCookie[]> = {
  'example.com': [
    {
      name: 'sid',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: 1790000000.4,
      hostOnly: false,
      session: false,
    },
    {
      name: 'prefs',
      value: 'dark=1',
      domain: 'example.com',
      path: '/app',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      hostOnly: true,
      session: true,
    },
  ],
  'other.org': [
    {
      name: 'token',
      value: 'xyz',
      domain: 'other.org',
      path: '/',
      secure: true,
      httpOnly: false,
      hostOnly: false,
      session: true,
    },
  ],
};

describe('collectCookiesForDomains', () => {
  it('collects cookies for specified domains or all domains when omitted', () => {
    const selected = collectCookiesForDomains(sampleCookies, ['example.com']);
    assert.equal(selected.length, 2);
    assert.deepEqual(
      selected.map((c) => c.name),
      ['sid', 'prefs'],
    );

    const all = collectCookiesForDomains(sampleCookies);
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map((c) => c.name),
      ['sid', 'prefs', 'token'],
    );
  });
});

describe('formatCookiesForExport', () => {
  it('formats cookies as pretty-printed JSON', () => {
    const cookies = collectCookiesForDomains(sampleCookies, ['example.com']);
    const json = formatCookiesForExport(cookies, 'json');
    const parsed = JSON.parse(json) as SerializedCookie[];
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]?.name, 'sid');
    assert.equal(parsed[1]?.name, 'prefs');
  });

  it('formats cookies as HTTP Header String', () => {
    const cookies = collectCookiesForDomains(sampleCookies, ['example.com']);
    const header = formatCookiesForExport(cookies, 'header');
    assert.equal(header, 'sid=abc123; prefs=dark=1');
  });

  it('formats cookies as Netscape HTTP Cookie File', () => {
    const cookies = collectCookiesForDomains(sampleCookies);
    const netscape = formatCookiesForExport(cookies, 'netscape');
    const lines = netscape.split('\n');
    assert.equal(lines[0], '# Netscape HTTP Cookie File');
    assert.equal(
      lines[3],
      '.example.com\tTRUE\t/\tTRUE\t1790000000\tsid\tabc123',
    );
    assert.equal(
      lines[4],
      'example.com\tFALSE\t/app\tFALSE\t0\tprefs\tdark=1',
    );
    // hostOnly: false without leading dot gets prefixed with '.' and TRUE
    assert.equal(
      lines[5],
      '.other.org\tTRUE\t/\tTRUE\t0\ttoken\txyz',
    );
  });
});
