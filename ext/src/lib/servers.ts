import { normalizeServerUrl } from './api';

export interface PresetServer {
  id: string;
  name: string;
  url: string;
  noticeTitle?: string;
  notice?: string;
}

export const OFFICIAL_DEMO_SERVER_URL = 'https://cloudcookie.sagan.me';

export const PRESET_SERVERS: readonly PresetServer[] = [
  {
    id: 'official-demo',
    name: 'Official Demo Server (Public)',
    url: OFFICIAL_DEMO_SERVER_URL,
    noticeTitle: 'Demo / Evaluation / Test Only',
    notice:
      'This is an official public-mode instance for demo, evaluation, and testing purposes only. Data may be deleted or flushed at any time without prior notice.',
  },
];

export function findPresetServer(serverUrl: string): PresetServer | undefined {
  let normalized: string;
  try {
    normalized = normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
  return PRESET_SERVERS.find((preset) => preset.url === normalized);
}
