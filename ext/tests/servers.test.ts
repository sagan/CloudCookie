import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findPresetServer,
  OFFICIAL_DEMO_SERVER_URL,
  PRESET_SERVERS,
} from '../src/lib/servers.ts';

describe('preset servers', () => {
  it('includes the official demo server with a test/demo notice', () => {
    const official = PRESET_SERVERS.find((s) => s.url === OFFICIAL_DEMO_SERVER_URL);
    assert.ok(official);
    assert.equal(official.url, 'https://cloudcookie.sagan.me');
    assert.ok(official.notice && official.notice.length > 0);
  });

  it('matches preset server regardless of trailing slash or scheme omission', () => {
    assert.equal(findPresetServer('https://cloudcookie.sagan.me/')?.id, 'official-demo');
    assert.equal(findPresetServer('https://cloudcookie.sagan.me')?.id, 'official-demo');
    assert.equal(findPresetServer('cloudcookie.sagan.me')?.id, 'official-demo');
  });

  it('returns undefined for custom or invalid server URLs', () => {
    assert.equal(findPresetServer('https://cookie.example.com'), undefined);
    assert.equal(findPresetServer(''), undefined);
    assert.equal(findPresetServer('ftp://cloudcookie.sagan.me'), undefined);
  });
});
