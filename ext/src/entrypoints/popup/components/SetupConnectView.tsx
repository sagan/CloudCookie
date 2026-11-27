import React, { useMemo, useState } from 'react';
import { deriveKeys, generateRootKey, isValidRootKey, normalizeRootKey } from '../../../lib/crypto';
import { normalizeServerUrl } from '../../../lib/api';

interface SetupConnectViewProps {
  initialServerUrl: string;
  initialRootKey: string;
  authStatus: 'idle' | 'checking' | 'pending' | 'unauthorized' | 'revoked' | 'error';
  authMessage: string | null;
  onConnect: (serverUrl: string, rootKey: string) => Promise<void>;
  onCancel?: () => void;
}

export const SetupConnectView: React.FC<SetupConnectViewProps> = ({
  initialServerUrl,
  initialRootKey,
  authStatus,
  authMessage,
  onConnect,
  onCancel,
}) => {
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [rootKey, setRootKey] = useState(initialRootKey);
  const [showKey, setShowKey] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const clientId = useMemo(() => {
    if (!isValidRootKey(rootKey)) return null;
    try {
      return deriveKeys(rootKey).clientId;
    } catch {
      return null;
    }
  }, [rootKey]);

  const copyText = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 1800);
    } catch {
      setLocalError('Clipboard write failed');
    }
  };

  const handleGenerate = () => {
    setRootKey(generateRootKey());
    setShowKey(true);
    setLocalError(null);
  };

  const handlePasteKey = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!isValidRootKey(text)) {
        setLocalError('Clipboard does not contain a valid 64-char hex root key');
        return;
      }
      setRootKey(normalizeRootKey(text));
      setLocalError(null);
    } catch {
      setLocalError('Unable to read from clipboard');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeServerUrl(serverUrl);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Invalid server URL');
      return;
    }

    if (!isValidRootKey(rootKey)) {
      setLocalError('Root key must be 64 hexadecimal characters (generate or paste one)');
      return;
    }

    await onConnect(normalizedUrl, normalizeRootKey(rootKey));
  };

  const isBusy = authStatus === 'checking';

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300 mb-1">
          Server URL
        </label>
        <input
          type="text"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://cookie.example.com"
          className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            Root Key (256-bit hex)
          </label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleGenerate}
              className="text-xs px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 font-medium"
            >
              Generate
            </button>
            <button
              type="button"
              onClick={handlePasteKey}
              className="text-xs px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 font-medium"
            >
              Paste
            </button>
            {isValidRootKey(rootKey) && (
              <button
                type="button"
                onClick={() => copyText('rootKey', normalizeRootKey(rootKey))}
                className="text-xs px-2 py-0.5 rounded bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 font-medium"
              >
                {copiedField === 'rootKey' ? 'Copied!' : 'Copy'}
              </button>
            )}
          </div>
        </div>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={rootKey}
            onChange={(e) => setRootKey(e.target.value)}
            placeholder="64-char hex key"
            className="w-full pr-14 pl-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400"
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {clientId && (
        <div className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Derived Client ID
            </span>
            <button
              type="button"
              onClick={() => copyText('clientId', clientId)}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              {copiedField === 'clientId' ? 'Copied!' : 'Copy ID'}
            </button>
          </div>
          <p className="text-[11px] font-mono break-all text-slate-700 dark:text-slate-300 select-all">
            {clientId}
          </p>
        </div>
      )}

      {(localError || authMessage) && (
        <div
          className={`p-3 rounded-lg text-xs border ${
            authStatus === 'pending' || authStatus === 'unauthorized'
              ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200'
              : 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/50 dark:border-red-800 dark:text-red-200'
          }`}
        >
          <p className="font-semibold mb-0.5">
            {authStatus === 'pending'
              ? 'Pending Admin Approval'
              : authStatus === 'unauthorized'
                ? 'Client Not Authorized'
                : authStatus === 'revoked'
                  ? 'Client Revoked'
                  : 'Connection Error'}
          </p>
          <p>{localError || authMessage}</p>
          {(authStatus === 'pending' || authStatus === 'unauthorized') && clientId && (
            <p className="mt-1.5 opacity-90">
              Share the Client ID above with your server admin to approve it, then click Connect again.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isBusy}
          className="flex-1 py-2 px-4 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors"
        >
          {isBusy
            ? 'Checking Server...'
            : authStatus === 'pending' || authStatus === 'unauthorized'
              ? 'Retry Authorization Check'
              : 'Connect & Check Authorization'}
        </button>
      </div>
    </form>
  );
};
