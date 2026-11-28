import type { BrowserMeta, UserAgentBrand, UserAgentDataMeta } from './types';

export interface NavigatorUADataLike {
  brands?: ReadonlyArray<{ brand?: unknown; version?: unknown }>;
  mobile?: unknown;
  platform?: unknown;
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

export interface NavigatorLike {
  userAgent?: unknown;
  platform?: unknown;
  language?: unknown;
  languages?: ReadonlyArray<unknown>;
  userAgentData?: NavigatorUADataLike;
}

export interface BrowserMetaEnv {
  navigator?: NavigatorLike;
  timeZone?: string;
  extensionVersion?: string;
}

function nonEmptyString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBrands(raw: unknown): UserAgentBrand[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UserAgentBrand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const brand = nonEmptyString((item as { brand?: unknown }).brand);
    const version = nonEmptyString((item as { version?: unknown }).version);
    if (brand && version !== undefined) {
      out.push({ brand, version });
    }
  }
  return out.length > 0 ? out : undefined;
}

async function getExtensionVersion(): Promise<string | undefined> {
  try {
    const polyfill = await import('webextension-polyfill');
    const manifest = polyfill.default?.runtime?.getManifest?.();
    return nonEmptyString(manifest?.version);
  } catch {
    return undefined;
  }
}

function getDefaultTimeZone(): string | undefined {
  try {
    return nonEmptyString(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return undefined;
  }
}

/**
 * Collects current browser User-Agent and environment metadata for Slot 1+ payloads.
 * Returns undefined if no metadata fields could be collected.
 */
export async function collectBrowserMeta(env?: BrowserMetaEnv): Promise<BrowserMeta | undefined> {
  const nav: NavigatorLike | undefined =
    env?.navigator ?? (typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined);

  const meta: BrowserMeta = {};

  if (nav) {
    const userAgent = nonEmptyString(nav.userAgent);
    if (userAgent) meta.user_agent = userAgent;

    if (nav.userAgentData && typeof nav.userAgentData === 'object') {
      const uaData: UserAgentDataMeta = {};
      const brands = normalizeBrands(nav.userAgentData.brands);
      if (brands) uaData.brands = brands;
      if (typeof nav.userAgentData.mobile === 'boolean') {
        uaData.mobile = nav.userAgentData.mobile;
      }
      const uaPlatform = nonEmptyString(nav.userAgentData.platform);
      if (uaPlatform) uaData.platform = uaPlatform;

      if (typeof nav.userAgentData.getHighEntropyValues === 'function') {
        try {
          const high = await nav.userAgentData.getHighEntropyValues([
            'platformVersion',
            'architecture',
            'bitness',
            'fullVersionList',
          ]);
          if (high && typeof high === 'object') {
            const platformVersion = nonEmptyString(high.platformVersion);
            if (platformVersion) uaData.platform_version = platformVersion;
            const architecture = nonEmptyString(high.architecture);
            if (architecture) uaData.architecture = architecture;
            const bitness = nonEmptyString(high.bitness);
            if (bitness) uaData.bitness = bitness;
            const fullVersionList = normalizeBrands(high.fullVersionList);
            if (fullVersionList) uaData.full_version_list = fullVersionList;
          }
        } catch {
          // Ignore high-entropy UA-CH failures and keep low-entropy fields.
        }
      }

      if (Object.keys(uaData).length > 0) {
        meta.user_agent_data = uaData;
      }
    }

    const platform = nonEmptyString(nav.platform);
    if (platform) meta.platform = platform;

    const language = nonEmptyString(nav.language);
    if (language) meta.language = language;

    if (Array.isArray(nav.languages)) {
      const langs = nav.languages
        .map((l) => nonEmptyString(l))
        .filter((l): l is string => l !== undefined);
      if (langs.length > 0) meta.languages = langs;
    }
  }

  const timeZone = env && 'timeZone' in env ? nonEmptyString(env.timeZone) : getDefaultTimeZone();
  if (timeZone) meta.timezone = timeZone;

  const extensionVersion =
    env && 'extensionVersion' in env
      ? nonEmptyString(env.extensionVersion)
      : await getExtensionVersion();
  if (extensionVersion) meta.extension_version = extensionVersion;

  return Object.keys(meta).length > 0 ? meta : undefined;
}
