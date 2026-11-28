import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectBrowserMeta } from '../src/lib/meta';

describe('collectBrowserMeta', () => {
  it('collects User-Agent, UA-CH high-entropy hints, and environment metadata', async () => {
    const meta = await collectBrowserMeta({
      navigator: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        language: 'en-US',
        languages: ['en-US', 'en'],
        userAgentData: {
          brands: [{ brand: 'Google Chrome', version: '131' }],
          mobile: false,
          platform: 'macOS',
          async getHighEntropyValues() {
            return {
              platformVersion: '15.1.0',
              architecture: 'arm',
              bitness: '64',
              fullVersionList: [{ brand: 'Google Chrome', version: '131.0.6778.86' }],
            };
          },
        },
      },
      timeZone: 'America/Los_Angeles',
      extensionVersion: '1.1.0',
    });

    assert.deepEqual(meta, {
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36',
      user_agent_data: {
        brands: [{ brand: 'Google Chrome', version: '131' }],
        mobile: false,
        platform: 'macOS',
        platform_version: '15.1.0',
        architecture: 'arm',
        bitness: '64',
        full_version_list: [{ brand: 'Google Chrome', version: '131.0.6778.86' }],
      },
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US', 'en'],
      timezone: 'America/Los_Angeles',
      extension_version: '1.1.0',
    });
  });

  it('falls back gracefully when getHighEntropyValues throws or is absent', async () => {
    const meta = await collectBrowserMeta({
      navigator: {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
        platform: 'Linux x86_64',
        language: 'en-GB',
        userAgentData: {
          brands: [{ brand: 'Chromium', version: '131' }],
          mobile: false,
          platform: 'Linux',
          async getHighEntropyValues() {
            throw new Error('denied');
          },
        },
      },
      timeZone: '',
      extensionVersion: undefined,
    });

    assert.deepEqual(meta, {
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      user_agent_data: {
        brands: [{ brand: 'Chromium', version: '131' }],
        mobile: false,
        platform: 'Linux',
      },
      platform: 'Linux x86_64',
      language: 'en-GB',
    });
  });

  it('returns undefined when no metadata fields are available', async () => {
    const meta = await collectBrowserMeta({
      navigator: {},
      timeZone: undefined,
      extensionVersion: undefined,
    });
    assert.equal(meta, undefined);
  });
});
