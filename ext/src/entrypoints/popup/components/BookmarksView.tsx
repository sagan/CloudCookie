import React, { useCallback, useEffect, useMemo, useState } from 'react';
import browser from 'webextension-polyfill';
import { CloudCookieClient } from '../../../lib/api';
import { importBookmarks } from '../../../lib/bookmarks';
import { fetchBookmarksSlot } from '../../../lib/slots';
import type {
  BookmarkSlotPayload,
  BookmarksUploadResult,
  LocalState,
  SerializedBookmarkNode,
} from '../../../lib/types';

interface BookmarksViewProps {
  client: CloudCookieClient;
  localState: LocalState;
  onBookmarksUploaded: () => Promise<void>;
  onOpenSettings: () => void;
}

interface FlatBookmarkItem {
  title: string;
  url: string;
  folderPath: string;
}

function flattenBookmarks(
  nodes: SerializedBookmarkNode[],
  prefix = '',
  out: FlatBookmarkItem[] = [],
): FlatBookmarkItem[] {
  for (const node of nodes) {
    if (typeof node.url === 'string') {
      out.push({
        title: node.title || node.url,
        url: node.url,
        folderPath: prefix || 'Bookmarks',
      });
    } else if (Array.isArray(node.children)) {
      const nextPrefix = prefix ? `${prefix} / ${node.title || 'Folder'}` : node.title || 'Folder';
      flattenBookmarks(node.children, nextPrefix, out);
    }
  }
  return out;
}

export const BookmarksView: React.FC<BookmarksViewProps> = ({
  client,
  localState,
  onBookmarksUploaded,
  onOpenSettings,
}) => {
  const [remoteSlot, setRemoteSlot] = useState<{
    slot: number;
    version: number;
    payload: BookmarkSlotPayload;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const loadRemoteBookmarks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBookmarksSlot(client);
      setRemoteSlot(res ? { slot: res.slot, version: res.version, payload: res.payload } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadRemoteBookmarks();
  }, [loadRemoteBookmarks]);

  const flatBookmarks = useMemo(() => {
    if (!remoteSlot?.payload?.roots) return [];
    return flattenBookmarks(remoteSlot.payload.roots);
  }, [remoteSlot]);

  const filteredBookmarks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return flatBookmarks.slice(0, 100);
    return flatBookmarks
      .filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.url.toLowerCase().includes(q) ||
          b.folderPath.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [flatBookmarks, search]);

  const handleUploadNow = async () => {
    setUploading(true);
    setError(null);
    setActionResult(null);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'UPLOAD_BOOKMARKS_NOW',
      })) as BookmarksUploadResult;
      await onBookmarksUploaded();
      if (res?.ok) {
        setActionResult(
          `Uploaded ${res.bookmarkCount ?? 0} bookmarks (${res.folderCount ?? 0} folders) to slot #${res.slot ?? '?'} · v${res.version ?? '?'}`,
        );
        await loadRemoteBookmarks();
      } else {
        setError(res?.error || 'Bookmark upload failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleImportAll = async () => {
    if (!remoteSlot?.payload?.roots) return;
    setImporting(true);
    setError(null);
    setActionResult(null);
    try {
      const res = await importBookmarks(remoteSlot.payload.roots);
      const parts = [`Imported ${res.imported} bookmark(s)`];
      if (res.skipped > 0) parts.push(`${res.skipped} already existed`);
      if (res.foldersCreated > 0) parts.push(`${res.foldersCreated} folder(s) created`);
      if (res.failed > 0) parts.push(`${res.failed} failed`);
      setActionResult(parts.join(', ') + '.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-semibold text-slate-800 dark:text-slate-100">
              Bookmark Uploading:{' '}
              <span
                className={
                  localState.bookmarks_upload_enabled
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-slate-500 dark:text-slate-400'
                }
              >
                {localState.bookmarks_upload_enabled ? 'Enabled' : 'Disabled (Opt-In)'}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {localState.bookmarks_upload_enabled
                ? localState.last_bookmarks_upload_at
                  ? `Last: ${new Date(localState.last_bookmarks_upload_at).toLocaleTimeString()} · ${localState.last_bookmarks_count ?? 0} bookmarks`
                  : 'Enabled · Not uploaded yet'
                : 'Enable in Settings on one browser only if needed.'}
            </div>
          </div>
          {localState.bookmarks_upload_enabled ? (
            <button
              type="button"
              disabled={uploading}
              onClick={() => void handleUploadNow()}
              className="shrink-0 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-60"
            >
              {uploading ? 'Uploading...' : 'Upload Bookmarks'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenSettings}
              className="shrink-0 px-2.5 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 font-medium"
            >
              Settings
            </button>
          )}
        </div>
        {localState.last_bookmarks_upload_status === 'error' &&
          localState.last_bookmarks_upload_error && (
            <div className="text-[11px] px-2 py-1 rounded bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-200">
              Last error: {localState.last_bookmarks_upload_error}
            </div>
          )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Remote Bookmarks
        </span>
        <button
          type="button"
          onClick={() => void loadRemoteBookmarks()}
          disabled={loading}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium disabled:opacity-60"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="p-2 rounded bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-800">
          {error}
        </div>
      )}

      {actionResult && (
        <div className="p-2 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800">
          {actionResult}
        </div>
      )}

      {loading && !remoteSlot ? (
        <div className="py-8 text-center text-slate-500">Loading remote bookmarks...</div>
      ) : !remoteSlot ? (
        <div className="p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-center text-slate-500 dark:text-slate-400">
          No bookmarks have been uploaded to this CloudCookie account yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="p-2.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
            <div>
              <div className="font-semibold text-slate-800 dark:text-slate-100">
                {remoteSlot.payload.bookmark_count} bookmark(s) · {remoteSlot.payload.folder_count}{' '}
                folder(s)
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Slot #{remoteSlot.slot} · v{remoteSlot.version} · Updated{' '}
                {new Date(remoteSlot.payload.updated_at).toLocaleString()}
              </div>
            </div>
            <button
              type="button"
              disabled={importing || flatBookmarks.length === 0}
              onClick={() => void handleImportAll()}
              className="shrink-0 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-60"
            >
              {importing ? 'Importing...' : 'Import All'}
            </button>
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search bookmarks by title, URL, or folder..."
            className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800"
          />

          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 divide-y divide-slate-100 dark:divide-slate-700/60">
            {filteredBookmarks.length === 0 ? (
              <div className="p-4 text-center text-slate-500">No matching bookmarks.</div>
            ) : (
              filteredBookmarks.map((b, idx) => (
                <div key={`${b.url}-${idx}`} className="px-2.5 py-1.5 space-y-0.5">
                  <div className="font-medium text-slate-800 dark:text-slate-100 truncate">
                    {b.title}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                    <span className="truncate font-mono">{b.url}</span>
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700">
                      {b.folderPath}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
          {flatBookmarks.length > 100 && (
            <div className="text-[11px] text-slate-500 text-center">
              Showing up to 100 matching bookmarks. Import All imports all {flatBookmarks.length}.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
