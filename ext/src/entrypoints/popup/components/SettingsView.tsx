import React, { useState } from 'react';
import { findPresetServer } from '../../../lib/servers';
import type { LocalState, SyncSettings } from '../../../lib/types';

interface SettingsViewProps {
  syncSettings: SyncSettings;
  localState: LocalState;
  clientId: string;
  onSaveLocalSettings: (patch: Partial<LocalState>) => Promise<void>;
  onRenameCurrentSlot: (newName: string) => Promise<void>;
  onSoftDeleteCurrentSlot: () => Promise<void>;
  onDeleteAllData: () => Promise<void>;
  onEditConnection: () => void;
  onSwitchSlot: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  syncSettings,
  localState,
  clientId,
  onSaveLocalSettings,
  onRenameCurrentSlot,
  onSoftDeleteCurrentSlot,
  onDeleteAllData,
  onEditConnection,
  onSwitchSlot,
}) => {
  const [autoUpload, setAutoUpload] = useState(localState.auto_upload_enabled);
  const [interval, setInterval] = useState(localState.upload_interval_minutes);
  const [blacklistText, setBlacklistText] = useState(localState.blacklist_domains.join('\n'));
  const [slotName, setSlotName] = useState(localState.using_slot_name || '');
  const [copied, setCopied] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSoftDelete, setConfirmSoftDelete] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [dangerBusy, setDangerBusy] = useState(false);
  const activePreset = findPresetServer(syncSettings.server_url);

  const copy = async (label: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSavedMsg(null);
    try {
      const parsedBlacklist = blacklistText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      await onSaveLocalSettings({
        auto_upload_enabled: autoUpload,
        upload_interval_minutes: Math.max(1, Number(interval) || 5),
        blacklist_domains: parsedBlacklist,
      });

      if (slotName.trim() && slotName.trim() !== localState.using_slot_name) {
        await onRenameCurrentSlot(slotName.trim());
      }

      setSavedMsg('Settings saved');
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSoftDeleteSlot = async () => {
    setError(null);
    setDangerBusy(true);
    try {
      await onSoftDeleteCurrentSlot();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDangerBusy(false);
      setConfirmSoftDelete(false);
    }
  };

  const handleDeleteAll = async () => {
    setError(null);
    setDangerBusy(true);
    try {
      await onDeleteAllData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDangerBusy(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-3.5 text-xs">
      <div className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            Synced Connection (browser.storage.sync)
          </span>
          <button
            type="button"
            onClick={onEditConnection}
            className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            Edit
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600 dark:text-slate-300 truncate">
            Server: <span className="font-mono">{syncSettings.server_url}</span>
          </span>
          <button
            type="button"
            onClick={() => void copy('url', syncSettings.server_url)}
            className="shrink-0 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-medium"
          >
            {copied === 'url' ? '✓ Copied' : 'Copy URL'}
          </button>
        </div>
        {activePreset?.notice && (
          <div className="p-2 rounded bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-200">
            <span className="font-semibold">{activePreset.name}:</span> {activePreset.notice}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600 dark:text-slate-300 truncate">
            Root Key: <span className="font-mono">••••••••{syncSettings.root_key.slice(-8)}</span>
          </span>
          <button
            type="button"
            onClick={() => void copy('root', syncSettings.root_key)}
            className="shrink-0 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-medium"
          >
            {copied === 'root' ? '✓ Copied' : 'Copy Key'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-600 dark:text-slate-300 truncate">
            Client ID: <span className="font-mono">{clientId.slice(0, 14)}...</span>
          </span>
          <button
            type="button"
            onClick={() => void copy('cid', clientId)}
            className="shrink-0 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-medium"
          >
            {copied === 'cid' ? '✓ Copied' : 'Copy ID'}
          </button>
        </div>
      </div>

      <div className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            This Browser Slot (#{localState.using_slot})
          </span>
          <button
            type="button"
            onClick={onSwitchSlot}
            className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            Switch Slot
          </button>
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">
            Instance Name (stored encrypted in Slot 0)
          </label>
          <input
            type="text"
            value={slotName}
            onChange={(e) => setSlotName(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900"
          />
        </div>
      </div>

      <div className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2.5">
        <div className="flex items-center justify-between">
          <label className="font-semibold text-slate-700 dark:text-slate-200">
            Background Auto-Upload
          </label>
          <input
            type="checkbox"
            checked={autoUpload}
            onChange={(e) => setAutoUpload(e.target.checked)}
            className="h-4 w-4 accent-blue-600"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="text-slate-600 dark:text-slate-300">Upload Interval (minutes)</label>
          <input
            type="number"
            min={1}
            max={1440}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            className="w-20 px-2 py-1 rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-right"
          />
        </div>
        <div>
          <label className="block text-slate-600 dark:text-slate-300 mb-1">
            Exclude Domains (one per line)
          </label>
          <textarea
            rows={2}
            value={blacklistText}
            onChange={(e) => setBlacklistText(e.target.value)}
            placeholder="localhost&#10;internal.example.com"
            className="w-full px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 font-mono"
          />
        </div>
      </div>

      {error && (
        <div className="p-2 rounded bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-800">
          {error}
        </div>
      )}
      {savedMsg && (
        <div className="p-2 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800">
          {savedMsg}
        </div>
      )}

      <button
        type="submit"
        disabled={dangerBusy}
        className="w-full py-2 px-4 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
      >
        Save Settings
      </button>

      <div className="p-3 rounded-lg bg-red-50/70 dark:bg-red-950/30 border border-red-200 dark:border-red-900 space-y-2.5">
        <div className="font-semibold text-red-700 dark:text-red-300">Danger Zone</div>

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-600 dark:text-slate-300">
            Soft delete slot #{localState.using_slot} (hides slot &amp; clears its cookies)
          </div>
          {confirmSoftDelete ? (
            <div className="shrink-0 flex items-center gap-1.5">
              <button
                type="button"
                disabled={dangerBusy}
                onClick={() => void handleSoftDeleteSlot()}
                className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-60"
              >
                {dangerBusy ? 'Deleting...' : 'Confirm'}
              </button>
              <button
                type="button"
                disabled={dangerBusy}
                onClick={() => setConfirmSoftDelete(false)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={dangerBusy}
              onClick={() => setConfirmSoftDelete(true)}
              className="shrink-0 px-2.5 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 font-medium disabled:opacity-60"
            >
              Soft Delete Slot
            </button>
          )}
        </div>

        <div className="pt-2 border-t border-red-200 dark:border-red-900/60 flex items-center justify-between gap-2">
          <div className="text-[11px] text-slate-600 dark:text-slate-300">
            Delete all data for this Client ID from server &amp; extension
          </div>
          {confirmDeleteAll ? (
            <div className="shrink-0 flex items-center gap-1.5">
              <button
                type="button"
                disabled={dangerBusy}
                onClick={() => void handleDeleteAll()}
                className="px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-60"
              >
                {dangerBusy ? 'Deleting...' : 'Confirm Delete'}
              </button>
              <button
                type="button"
                disabled={dangerBusy}
                onClick={() => setConfirmDeleteAll(false)}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={dangerBusy}
              onClick={() => setConfirmDeleteAll(true)}
              className="shrink-0 px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold disabled:opacity-60"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </form>
  );
};
