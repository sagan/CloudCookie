import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, CloudCookieClient } from '../../../lib/api';
import { importCookies } from '../../../lib/cookies';
import { filterDomainsForMode, getBaseDomain } from '../../../lib/domains';
import { fetchSlotCookies } from '../../../lib/slots';
import { ListSlotEntry, Slot0Payload, SlotDataPayload } from '../../../lib/types';

type ImportMode = 'base_domain' | 'domain' | 'all';

interface ImportViewProps {
  client: CloudCookieClient;
  meta: Slot0Payload;
  serverSlots: Map<number, ListSlotEntry>;
  currentSlot: number;
  activeHostname: string | null;
  onRefreshSlots: () => Promise<void>;
}

export const ImportView: React.FC<ImportViewProps> = ({
  client,
  meta,
  serverSlots,
  currentSlot,
  activeHostname,
  onRefreshSlots,
}) => {
  const [mode, setMode] = useState<ImportMode>('base_domain');
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [slotData, setSlotData] = useState<SlotDataPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);

  const otherSlots = useMemo(
    () =>
      Object.values(meta.slots)
        .filter((s) => !s.deleted && s.slot !== currentSlot)
        .sort((a, b) => a.slot - b.slot),
    [meta, currentSlot],
  );

  const baseDomain = useMemo(
    () => (activeHostname ? getBaseDomain(activeHostname) : null),
    [activeHostname],
  );

  const loadSlot = useCallback(
    async (slot: number) => {
      setSelectedSlot(slot);
      setSlotData(null);
      setError(null);
      setImportResult(null);
      setLoading(true);
      try {
        const res = await fetchSlotCookies(client, slot);
        setSlotData(res.payload);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'no_data') {
          setError('This slot has not uploaded any cookies yet.');
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // Auto-select the best available source slot on open so cookies load immediately
  useEffect(() => {
    if (otherSlots.length === 0) {
      setSelectedSlot(null);
      setSlotData(null);
      return;
    }
    const stillValid = selectedSlot !== null && otherSlots.some((s) => s.slot === selectedSlot);
    if (!stillValid) {
      const slotsWithData = otherSlots.filter((s) => serverSlots.has(s.slot));
      const preferred =
        slotsWithData.sort((a, b) => {
          const tA = Date.parse(serverSlots.get(a.slot)?.updated_at ?? '') || 0;
          const tB = Date.parse(serverSlots.get(b.slot)?.updated_at ?? '') || 0;
          return tB - tA;
        })[0] ?? otherSlots[0];
      void loadSlot(preferred.slot);
    }
  }, [otherSlots, serverSlots, selectedSlot, loadSlot]);

  const modeDomainKeys = useMemo(() => {
    if (!slotData?.cookies) return [];
    return filterDomainsForMode(Object.keys(slotData.cookies), mode, activeHostname);
  }, [slotData, mode, activeHostname]);

  const filteredDomains = useMemo(() => {
    if (!slotData?.cookies) return [];
    const q = mode === 'all' ? search.trim().toLowerCase() : '';
    return modeDomainKeys
      .filter((domain) => !q || domain.toLowerCase().includes(q))
      .map((domain) => [domain, slotData.cookies[domain] || []] as const);
  }, [slotData, modeDomainKeys, mode, search]);

  const matchedCookieCount = useMemo(
    () => filteredDomains.reduce((sum, [, cookies]) => sum + cookies.length, 0),
    [filteredDomains],
  );

  const handleImportDomains = async (domains?: string[]) => {
    if (!slotData?.cookies) return;
    setImporting(true);
    setImportResult(null);
    setError(null);
    try {
      const res = await importCookies(slotData.cookies, domains);
      const scope =
        domains && domains.length <= 3
          ? domains.join(', ')
          : domains
            ? `${domains.length} domains`
            : 'all websites';
      setImportResult(
        `Imported ${res.imported} cookie(s) for ${scope}${res.failed > 0 ? ` (${res.failed} failed)` : ''}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const targetLabel =
    mode === 'base_domain' ? baseDomain : mode === 'domain' ? activeHostname : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
          Import From Slot
        </span>
        <button
          type="button"
          onClick={() => void onRefreshSlots()}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
        >
          Refresh List
        </button>
      </div>

      {otherSlots.length === 0 ? (
        <div className="p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-center text-xs text-slate-500 dark:text-slate-400">
          No other browser slots found. Install CloudCookie on another browser with the same Root Key to import cookies from it.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {otherSlots.map((s) => {
            const active = selectedSlot === s.slot;
            const hasData = serverSlots.has(s.slot);
            return (
              <button
                key={s.slot}
                type="button"
                onClick={() => void loadSlot(s.slot)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-600 hover:border-blue-400'
                } ${!hasData ? 'opacity-60' : ''}`}
              >
                #{s.slot} {s.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Mode Switcher */}
      {otherSlots.length > 0 && (
        <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-slate-200/80 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-medium">
          <button
            type="button"
            onClick={() => setMode('base_domain')}
            className={`py-1.5 px-2 rounded-md transition-colors ${
              mode === 'base_domain'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Base Domain
          </button>
          <button
            type="button"
            onClick={() => setMode('domain')}
            className={`py-1.5 px-2 rounded-md transition-colors ${
              mode === 'domain'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            Domain
          </button>
          <button
            type="button"
            onClick={() => setMode('all')}
            className={`py-1.5 px-2 rounded-md transition-colors ${
              mode === 'all'
                ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-300 shadow-sm font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            All
          </button>
        </div>
      )}

      {loading && (
        <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
          Fetching &amp; decrypting cookies...
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-200">
          {error}
        </div>
      )}

      {importResult && (
        <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 font-medium">
          {importResult}
        </div>
      )}

      {slotData && !loading && (
        <div className="space-y-2.5">
          {mode !== 'all' ? (
            <>
              <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">
                      {targetLabel ? (
                        <>
                          {mode === 'base_domain' ? 'Base: ' : 'Exact: '}
                          <span className="font-mono text-blue-600 dark:text-blue-400">
                            {targetLabel}
                          </span>
                        </>
                      ) : (
                        'No active website tab'
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {targetLabel
                        ? `${matchedCookieCount} cookie${matchedCookieCount === 1 ? '' : 's'} across ${filteredDomains.length} domain${filteredDomains.length === 1 ? '' : 's'}`
                        : 'Open a website tab or switch to All mode'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={importing || matchedCookieCount === 0}
                    onClick={() => void handleImportDomains(modeDomainKeys)}
                    className="shrink-0 px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                  >
                    {importing
                      ? 'Importing...'
                      : `Import${matchedCookieCount > 0 ? ` (${matchedCookieCount})` : ''}`}
                  </button>
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400">
                  Snapshot: {new Date(slotData.updated_at).toLocaleString()}
                </div>
              </div>

              {filteredDomains.length === 0 ? (
                <div className="p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 text-center text-xs text-slate-500 dark:text-slate-400 space-y-2">
                  <p>
                    {targetLabel
                      ? `No cookies matching ${targetLabel} in this slot.`
                      : 'Current tab does not have an HTTP/HTTPS domain.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setMode('all')}
                    className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                  >
                    Switch to All mode
                  </button>
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
                  {filteredDomains.map(([domain, cookies]) => {
                    const rawDomains = Array.from(new Set(cookies.map((c) => c.domain))).join(', ');
                    return (
                      <div key={domain} className="flex items-center justify-between px-3 py-2">
                        <div className="min-w-0 pr-2">
                          <div className="text-xs font-medium truncate">{domain}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                            {cookies.length} cookie{cookies.length === 1 ? '' : 's'} ({rawDomains})
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={importing}
                          onClick={() => void handleImportDomains([domain])}
                          className="shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-slate-200 hover:bg-blue-600 hover:text-white dark:bg-slate-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-60"
                        >
                          Import
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                <div className="text-xs">
                  <div className="font-semibold">
                    {slotData.cookie_count} cookies · {slotData.domain_count} websites
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Snapshot: {new Date(slotData.updated_at).toLocaleString()}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={importing || slotData.cookie_count === 0}
                  onClick={() => void handleImportDomains(undefined)}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
                >
                  {importing ? 'Importing...' : 'Import All'}
                </button>
              </div>

              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter website domain (e.g. github.com)..."
                className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <div className="max-h-52 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800">
                {filteredDomains.length === 0 ? (
                  <div className="p-3 text-center text-xs text-slate-500">No matching domains</div>
                ) : (
                  filteredDomains.map(([domain, cookies]) => (
                    <div key={domain} className="flex items-center justify-between px-3 py-2">
                      <div className="min-w-0 pr-2">
                        <div className="text-xs font-medium truncate">{domain}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {cookies.length} cookie{cookies.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={importing}
                        onClick={() => void handleImportDomains([domain])}
                        className="shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-slate-200 hover:bg-blue-600 hover:text-white dark:bg-slate-700 dark:hover:bg-blue-600 transition-colors disabled:opacity-60"
                      >
                        Import
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
