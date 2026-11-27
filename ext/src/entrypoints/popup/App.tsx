import React, { useCallback, useEffect, useMemo, useState } from 'react';
import browser from 'webextension-polyfill';
import { ApiError, CloudCookieClient } from '../../lib/api';
import { extractHostnameFromUrl } from '../../lib/domains';
import { isValidRootKey } from '../../lib/crypto';
import {
  createNewSlot,
  deleteAllServerData,
  fetchSlotsWithServerInfo,
  renameSlot,
  softDeleteSlot,
} from '../../lib/slots';
import {
  clearAllExtensionData,
  clearSlotBinding,
  getLocalState,
  getSyncSettings,
  saveLocalState,
  saveSyncSettings,
} from '../../lib/storage';
import {
  DEFAULT_LOCAL_STATE,
  ListSlotEntry,
  LocalState,
  Slot0Payload,
  SyncSettings,
  UploadResult,
} from '../../lib/types';
import { ImportView } from './components/ImportView';
import { SettingsView } from './components/SettingsView';
import { SetupConnectView } from './components/SetupConnectView';
import { SlotSelectView } from './components/SlotSelectView';

type Screen = 'loading' | 'setup' | 'slot_select' | 'main';
type MainTab = 'import' | 'settings';
type AuthStatus = 'idle' | 'checking' | 'pending' | 'unauthorized' | 'revoked' | 'error';

const App: React.FC = () => {
  const [screen, setScreen] = useState<Screen>('loading');
  const [tab, setTab] = useState<MainTab>('import');

  const [syncSettings, setSyncSettings] = useState<SyncSettings>({ server_url: '', root_key: '' });
  const [localState, setLocalState] = useState<LocalState>(DEFAULT_LOCAL_STATE);

  const [authStatus, setAuthStatus] = useState<AuthStatus>('idle');
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const [meta, setMeta] = useState<Slot0Payload>({ schema_version: 1, updated_at: 0, slots: {} });
  const [serverSlots, setServerSlots] = useState<Map<number, ListSlotEntry>>(new Map());
  const [uploading, setUploading] = useState(false);
  const [uploadBanner, setUploadBanner] = useState<string | null>(null);
  const [activeHostname, setActiveHostname] = useState<string | null>(null);

  const client = useMemo(() => {
    if (!syncSettings.server_url || !isValidRootKey(syncSettings.root_key)) return null;
    try {
      return new CloudCookieClient(syncSettings.server_url, syncSettings.root_key);
    } catch {
      return null;
    }
  }, [syncSettings]);

  const connectAndFetchSlots = useCallback(
    async (url: string, key: string, currentUsingSlot: number | null) => {
      setAuthStatus('checking');
      setAuthMessage(null);
      try {
        const c = new CloudCookieClient(url, key);
        await saveSyncSettings({ server_url: url, root_key: key });
        setSyncSettings({ server_url: url, root_key: key });

        const { meta: fetchedMeta, serverSlots: fetchedServerSlots } =
          await fetchSlotsWithServerInfo(c);

        setMeta(fetchedMeta);
        setServerSlots(fetchedServerSlots);
        setAuthStatus('idle');

        const currentMetaEntry = currentUsingSlot
          ? fetchedMeta.slots[String(currentUsingSlot)]
          : undefined;

        if (currentUsingSlot && currentMetaEntry && !currentMetaEntry.deleted) {
          setScreen('main');
        } else {
          if (currentUsingSlot && currentMetaEntry?.deleted) {
            await clearSlotBinding();
            setLocalState(await getLocalState());
          }
          setScreen('slot_select');
        }
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.code === 'client_pending_approval') {
            setAuthStatus('pending');
          } else if (err.code === 'client_unauthorized') {
            setAuthStatus('unauthorized');
          } else if (err.code === 'client_revoked') {
            setAuthStatus('revoked');
          } else {
            setAuthStatus('error');
          }
          setAuthMessage(err.message);
        } else {
          setAuthStatus('error');
          setAuthMessage(err instanceof Error ? err.message : String(err));
        }
        setScreen('setup');
      }
    },
    [],
  );

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        setActiveHostname(extractHostnameFromUrl(tabs[0]?.url));
      })
      .catch(() => {
        setActiveHostname(null);
      });

    const init = async () => {
      const [sync, local] = await Promise.all([getSyncSettings(), getLocalState()]);
      setSyncSettings(sync);
      setLocalState(local);

      if (!sync.server_url || !isValidRootKey(sync.root_key)) {
        setScreen('setup');
        return;
      }

      await connectAndFetchSlots(sync.server_url, sync.root_key, local.using_slot);
    };
    void init();
  }, [connectAndFetchSlots]);

  const refreshSlots = async () => {
    if (!client) return;
    const { meta: fetchedMeta, serverSlots: fetchedServerSlots } =
      await fetchSlotsWithServerInfo(client);
    setMeta(fetchedMeta);
    setServerSlots(fetchedServerSlots);
  };

  const triggerUploadNow = async () => {
    setUploading(true);
    setUploadBanner(null);
    try {
      const res = (await browser.runtime.sendMessage({ type: 'UPLOAD_NOW' })) as UploadResult;
      const updatedLocal = await getLocalState();
      setLocalState(updatedLocal);
      if (res?.ok) {
        setUploadBanner(
          `Uploaded ${res.cookieCount ?? 0} cookies (${res.domainCount ?? 0} domains) · v${res.version ?? '?'}`,
        );
      } else {
        setUploadBanner(`Upload failed: ${res?.error || 'Unknown error'}`);
      }
    } catch (err) {
      setUploadBanner(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleSelectSlot = async (slot: number, name: string) => {
    const srv = serverSlots.get(slot);
    await saveLocalState({
      using_slot: slot,
      using_slot_name: name,
      last_slot_version: srv?.version ?? 0,
      last_upload_hash: null,
    });
    setLocalState(await getLocalState());
    setScreen('main');
    void triggerUploadNow();
  };

  const handleCreateSlot = async (name: string) => {
    if (!client) return;
    const res = await createNewSlot(client, name);
    setMeta(res.meta);
    await saveLocalState({
      using_slot: res.slot,
      using_slot_name: name,
      last_slot_version: 0,
      last_upload_hash: null,
    });
    setLocalState(await getLocalState());
    setScreen('main');
    void triggerUploadNow();
  };

  const handleSaveLocalSettings = async (patch: Partial<LocalState>) => {
    await saveLocalState(patch);
    setLocalState(await getLocalState());
    await browser.runtime.sendMessage({ type: 'RESCHEDULE_ALARM' });
  };

  const handleRenameCurrentSlot = async (newName: string) => {
    if (!client || !localState.using_slot) return;
    const updatedMeta = await renameSlot(client, localState.using_slot, newName);
    setMeta(updatedMeta);
    await saveLocalState({ using_slot_name: newName });
    setLocalState(await getLocalState());
  };

  const handleSoftDeleteSlot = async (slot: number) => {
    if (!client) return;
    const updatedMeta = await softDeleteSlot(client, slot);
    setMeta(updatedMeta);

    const refreshedSlots = await client.listSlots();
    const nextServerSlots = new Map<number, ListSlotEntry>();
    for (const entry of refreshedSlots) {
      nextServerSlots.set(entry.slot, entry);
    }
    setServerSlots(nextServerSlots);

    if (localState.using_slot === slot) {
      await clearSlotBinding();
      setLocalState(await getLocalState());
      setUploadBanner(null);
      setScreen('slot_select');
    }
  };

  const handleDeleteAllData = async () => {
    if (!client) return;
    await deleteAllServerData(client);
    await clearAllExtensionData();
    setSyncSettings({ server_url: '', root_key: '' });
    setLocalState(DEFAULT_LOCAL_STATE);
    setMeta({ schema_version: 1, updated_at: 0, slots: {} });
    setServerSlots(new Map());
    setAuthStatus('idle');
    setAuthMessage(null);
    setUploadBanner(null);
    setScreen('setup');
  };

  return (
    <div className="min-h-[480px] flex flex-col bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100">
      <header className="px-4 py-3 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src="/icon/logo.svg" alt="CloudCookie" className="w-6 h-6" />
          <div>
            <h1 className="text-sm font-bold leading-tight">CloudCookie</h1>
            <p className="text-[10px] text-slate-500 dark:text-slate-400">
              E2E Encrypted Multi-Slot Sync
            </p>
          </div>
        </div>
        {screen === 'main' && localState.using_slot && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-200 font-medium truncate max-w-[160px]">
            #{localState.using_slot} {localState.using_slot_name}
          </span>
        )}
      </header>

      <main className="flex-1 p-4 space-y-4">
        {screen === 'loading' && (
          <div className="py-16 text-center text-xs text-slate-500">Connecting to server...</div>
        )}

        {screen === 'setup' && (
          <SetupConnectView
            initialServerUrl={syncSettings.server_url}
            initialRootKey={syncSettings.root_key}
            authStatus={authStatus}
            authMessage={authMessage}
            onConnect={(url, key) => connectAndFetchSlots(url, key, localState.using_slot)}
            onCancel={
              client && localState.using_slot ? () => setScreen('main') : undefined
            }
          />
        )}

        {screen === 'slot_select' && client && (
          <SlotSelectView
            meta={meta}
            serverSlots={serverSlots}
            currentSlot={localState.using_slot}
            onSelectSlot={handleSelectSlot}
            onCreateSlot={handleCreateSlot}
            onSoftDeleteSlot={handleSoftDeleteSlot}
            onRefresh={refreshSlots}
            onCancel={localState.using_slot ? () => setScreen('main') : undefined}
          />
        )}

        {screen === 'main' && client && localState.using_slot && (
          <>
            <div className="p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                    Auto-Upload {localState.auto_upload_enabled ? 'Active' : 'Paused'}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {localState.last_upload_at
                      ? `Last: ${new Date(localState.last_upload_at).toLocaleTimeString()} · ${localState.last_cookie_count ?? 0} cookies`
                      : 'Not uploaded yet'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => void triggerUploadNow()}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
                >
                  {uploading ? 'Uploading...' : 'Upload Now'}
                </button>
              </div>
              {uploadBanner && (
                <div className="text-[11px] px-2.5 py-1.5 rounded bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-200">
                  {uploadBanner}
                </div>
              )}
              {localState.last_upload_status === 'error' && localState.last_upload_error && (
                <div className="text-[11px] px-2.5 py-1.5 rounded bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-200">
                  Last error: {localState.last_upload_error}
                </div>
              )}
            </div>

            <div className="flex border-b border-slate-200 dark:border-slate-700 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setTab('import')}
                className={`flex-1 py-2 border-b-2 transition-colors ${
                  tab === 'import'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                Import Cookies
              </button>
              <button
                type="button"
                onClick={() => setTab('settings')}
                className={`flex-1 py-2 border-b-2 transition-colors ${
                  tab === 'settings'
                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                Settings
              </button>
            </div>

            {tab === 'import' && (
              <ImportView
                client={client}
                meta={meta}
                serverSlots={serverSlots}
                currentSlot={localState.using_slot}
                activeHostname={activeHostname}
                onRefreshSlots={refreshSlots}
              />
            )}

            {tab === 'settings' && (
              <SettingsView
                syncSettings={syncSettings}
                localState={localState}
                clientId={client.clientId}
                onSaveLocalSettings={handleSaveLocalSettings}
                onRenameCurrentSlot={handleRenameCurrentSlot}
                onSoftDeleteCurrentSlot={() => handleSoftDeleteSlot(localState.using_slot!)}
                onDeleteAllData={handleDeleteAllData}
                onEditConnection={() => setScreen('setup')}
                onSwitchSlot={() => setScreen('slot_select')}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default App;
