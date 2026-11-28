import React, { useState } from 'react';
import { findPresetServer } from '../../../lib/servers';
import type { ListSlotEntry, Slot0Payload } from '../../../lib/types';

interface SlotSelectViewProps {
  serverUrl: string;
  clientId: string;
  meta: Slot0Payload;
  serverSlots: Map<number, ListSlotEntry>;
  currentSlot: number | null;
  onSelectSlot: (slot: number, name: string) => Promise<void>;
  onCreateSlot: (name: string) => Promise<void>;
  onSoftDeleteSlot: (slot: number) => Promise<void>;
  onPurgeTombstoneSlot: (slot: number) => Promise<void>;
  onRefresh: () => Promise<void>;
  onChangeServer: () => void;
  onCancel?: () => void;
}

export const SlotSelectView: React.FC<SlotSelectViewProps> = ({
  serverUrl,
  clientId,
  meta,
  serverSlots,
  currentSlot,
  onSelectSlot,
  onCreateSlot,
  onSoftDeleteSlot,
  onPurgeTombstoneSlot,
  onRefresh,
  onChangeServer,
  onCancel,
}) => {
  const activePreset = findPresetServer(serverUrl);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDeleteSlot, setConfirmDeleteSlot] = useState<number | null>(null);
  const [confirmPurgeSlot, setConfirmPurgeSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const slotEntries = Object.values(meta.slots)
    .filter((entry) => !entry.deleted && entry.type !== 'bookmarks' && entry.slot !== meta.bookmarks_slot)
    .sort((a, b) => a.slot - b.slot);

  const deletedEntries = Object.values(meta.slots)
    .filter((entry) => entry.deleted && entry.type !== 'bookmarks' && entry.slot !== meta.bookmarks_slot)
    .sort((a, b) => a.slot - b.slot);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setError('Please enter a name to identify this browser instance');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreateSlot(newName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSelect = async (slot: number, name: string) => {
    setBusy(true);
    setError(null);
    try {
      await onSelectSlot(slot, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSoftDelete = async (slot: number) => {
    setBusy(true);
    setError(null);
    try {
      await onSoftDeleteSlot(slot);
      setConfirmDeleteSlot(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePurgeTombstone = async (slot: number) => {
    setBusy(true);
    setError(null);
    try {
      await onPurgeTombstoneSlot(slot);
      setConfirmPurgeSlot(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Select Browser Slot</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Stored locally on this browser only (not synced).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 font-medium"
        >
          Refresh
        </button>
      </div>

      <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Connected Server
          </div>
          {activePreset && (
            <div className="text-xs font-medium text-slate-800 dark:text-slate-100 truncate">
              {activePreset.name}
            </div>
          )}
          <div
            className="text-[11px] font-mono text-slate-600 dark:text-slate-300 truncate"
            title={serverUrl}
          >
            {serverUrl}
          </div>
          <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate" title={clientId}>
            Client ID: <span className="font-mono">{clientId.slice(0, 14)}...</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onChangeServer}
          disabled={busy}
          className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 disabled:opacity-60"
        >
          Change Server
        </button>
      </div>

      {slotEntries.length > 0 ? (
        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
          {slotEntries.map((entry) => {
            const srv = serverSlots.get(entry.slot);
            const isCurrent = entry.slot === currentSlot;
            return (
              <div
                key={entry.slot}
                className={`flex items-center justify-between p-2.5 rounded-lg border ${
                  isCurrent
                    ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/40'
                    : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
                }`}
              >
                <div className="min-w-0 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 font-semibold">
                      #{entry.slot}
                    </span>
                    <span className="text-sm font-medium truncate">{entry.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-600 text-white font-semibold">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {srv
                      ? `Updated ${new Date(srv.updated_at).toLocaleString()} · ${(srv.size_bytes / 1024).toFixed(1)} KB`
                      : 'No cookie data uploaded yet'}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {confirmDeleteSlot === entry.slot ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSoftDelete(entry.slot)}
                        className="px-2 py-1.5 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteSlot(null)}
                        className="px-2 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteSlot(entry.slot)}
                        className="px-2 py-1.5 text-xs font-medium rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60"
                        title="Soft delete slot"
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSelect(entry.slot, entry.name)}
                        className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
                      >
                        {isCurrent ? 'Keep' : 'Use'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="p-3 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-center text-xs text-slate-500 dark:text-slate-400">
          No slots created yet. Create the first slot for this browser below.
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 space-y-2.5"
      >
        <label className="block text-xs font-semibold text-slate-700 dark:text-slate-200">
          Create New Slot for This Browser
        </label>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. Work MacBook Chrome"
          maxLength={64}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium rounded-md border border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex-1 py-1.5 px-3 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
          >
            {busy ? 'Saving...' : 'Create & Bind Slot'}
          </button>
        </div>
      </form>

      {deletedEntries.length > 0 && (
        <div className="p-2.5 rounded-lg bg-slate-100/80 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            Deleted Slots ({deletedEntries.length})
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {deletedEntries.map((entry) => (
              <div
                key={entry.slot}
                className="flex items-center justify-between text-xs py-1 px-2 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
              >
                <span className="truncate text-slate-600 dark:text-slate-300">
                  <span className="font-mono">#{entry.slot}</span> {entry.name}
                </span>
                {confirmPurgeSlot === entry.slot ? (
                  <div className="shrink-0 flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handlePurgeTombstone(entry.slot)}
                      className="px-2 py-0.5 text-[11px] font-semibold rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                    >
                      Confirm Purge
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmPurgeSlot(null)}
                      className="px-2 py-0.5 text-[11px] rounded border border-slate-300 dark:border-slate-600"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmPurgeSlot(entry.slot)}
                    className="shrink-0 px-2 py-0.5 text-[11px] font-medium rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-60"
                    title="Permanently delete server blob and tombstone"
                  >
                    Purge
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
};
