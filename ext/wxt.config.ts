import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  outDir: 'dist',
  modules: ['@wxt-dev/webextension-polyfill'],
  manifest: {
    name: 'CloudCookie',
    description: 'End-to-end encrypted multi-slot cookie synchronization',
    incognito: 'not_allowed',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      96: '/icon/96.png',
      128: '/icon/128.png',
    },
    permissions: [
      'cookies',
      'bookmarks',
      'storage',
      'alarms',
      'unlimitedStorage',
      'activeTab',
      'clipboardWrite',
    ],
    host_permissions: [
      '<all_urls>',
    ],
  },
  vite: () => ({
    css: {
      postcss: './postcss.config.js',
    },
  }),
});
