import type { PluginDetail, PluginSummary, PluginUpdateCheckOutput } from '@transcoda/contract';
import { useEffect, useId, useRef, useState } from 'react';
import { api, safe } from '../api/client.ts';
import { Dialog } from '../components/Dialog.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { compareVersions } from './CatalogSection.tsx';
import { pluginFailure } from './errors.ts';
import type { Entry } from './InstallDialog.tsx';
import { IntegrationSettings } from './IntegrationSettings.tsx';
import { type NodeChip, NodeChips, PluginTile } from './PluginTile.tsx';
import {
  blockedText,
  disableConfirmText,
  type PluginStatus,
  removeConfirmText,
  stateLabel,
  statusOf,
  usedByText,
  webLink,
} from './pluginText.ts';
import { TmdbAttribution } from './TmdbAttribution.tsx';
import { UpdateDialog } from './UpdateDialog.tsx';

/** Ticks once a second while `on` (the countdown of a restarting plugin). */
function useNow(on: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

const STATUS_ICON: Record<PluginStatus['tone'], IconName> = {
  ok: 'check',
  error: 'cross',
  warning: 'alert',
  neutral: 'clock',
};

/** Why a plugin does not run, under its name; null while it runs or is only disabled. */
function reasonLine(p: PluginSummary, now: Date): string | null {
  if (p.state === 'stopped' && p.stateReason) return stateLabel(p, now);
  if (p.state === 'restarting' && p.stateReason) return `Last crash: ${p.stateReason}`;
  return null;
}

/**
 * One installed plugin: tile, name, version, the workflows using it and its status, with Update
 * (when the catalog has a newer version) and Settings. Settings open inline: the integration's
 * form with its last test, the plugin's own buttons (disable, restart, remove), the nodes it
 * adds and the other catalog versions it can switch to.
 */
export function PluginRow({
  plugin,
  title,
  entry,
  nodes,
  effect,
  onChanged,
  focusHeading = false,
  onFocused,
}: {
  plugin: PluginSummary;
  /** The catalog's title for it, else its name. */
  title: string;
  /** Its catalog entry (for the other versions), null when no catalog lists it. */
  entry: Entry | null;
  nodes: readonly NodeChip[];
  /** What a failed connection test costs, in words. */
  effect: string;
  onChanged(): void;
  /** Move focus to the row's heading (a plugin that was just installed). */
  focusHeading?: boolean;
  onFocused?(): void;
}) {
  const toast = useToast();
  const now = useNow(plugin.state === 'restarting');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<{
    kind: 'remove' | 'disable';
    text: string;
    /** The workflows using the plugin could not be looked up. */
    unchecked: boolean;
  } | null>(null);
  const [updating, setUpdating] = useState<{
    version: string;
    check: PluginUpdateCheckOutput;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const updateReturn = useRef<HTMLElement | null>(null);
  const id = useId();
  const { name } = plugin;

  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    onFocused?.();
  }, [focusHeading, onFocused]);

  async function act(label: string, call: () => Promise<PluginDetail | { ok: boolean }>) {
    if (pending) return false;
    setPending(label);
    setError(null);
    const [err] = await safe(call());
    setPending(null);
    if (err) {
      setError(pluginFailure(err));
      return false;
    }
    onChanged();
    return true;
  }

  /** Looks up the workflows using the plugin, then asks; a failed lookup says so and still asks. */
  async function ask(kind: 'remove' | 'disable') {
    if (pending) return;
    setPending(kind);
    const [err, detail] = await safe(api.plugins.get({ name }));
    setPending(null);
    const usedBy = err || !detail ? null : detail.usedBy;
    if (kind === 'disable' && usedBy !== null && usedBy.length === 0) {
      void act('toggle', () => api.plugins.disable({ name }));
      return;
    }
    const text =
      kind === 'remove'
        ? removeConfirmText(name, usedBy ?? [])
        : usedBy === null
          ? `Disable ${name}? Workflows that use its nodes will show "plugin not running".`
          : disableConfirmText(name, usedBy);
    setAsking({ kind, text, unchecked: usedBy === null });
  }

  /** Asks what the update would do to workflows; a failed check says why and does not update. */
  async function checkUpdate(version: string) {
    if (pending) return;
    setPending('update');
    setError(null);
    const [err, check] = await safe(api.plugins.updateCheck({ name, version }));
    setPending(null);
    if (err || !check) {
      setError(pluginFailure(err));
      return;
    }
    setUpdating({ version, check });
  }

  async function confirmUpdate() {
    const current = updating;
    if (!current) return;
    const ok = await act('update', async () => {
      const out = await api.plugins.update({ name, version: current.version });
      toast.success(`Updated ${name} to ${out.version}`);
      return out;
    });
    // The Update button is gone once updated: the dialog hands focus to the row's heading.
    if (ok) updateReturn.current = heading.current;
    setUpdating(null);
  }

  async function confirmAsked() {
    const current = asking;
    setAsking(null);
    if (!current) return;
    if (current.kind === 'disable') {
      await act('toggle', () => api.plugins.disable({ name }));
    } else if (await act('remove', () => api.plugins.remove({ name, confirm: true }))) {
      toast.success(`Removed ${name}`);
    }
  }

  const status = statusOf(plugin, now);
  const reason = reasonLine(plugin, now);
  const update = plugin.updateAvailable;
  const busy = pending !== null;
  const others = (entry?.versions ?? [])
    .filter((v) => v.version !== plugin.version)
    .sort((a, b) => compareVersions(b.version, a.version));

  const actions = (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${title}`}
        disabled={busy}
        onClick={(e) => {
          if (!plugin.enabled) return void act('toggle', () => api.plugins.enable({ name }));
          opener.current = e.currentTarget;
          void ask('disable');
        }}
      >
        {plugin.enabled ? 'Disable' : 'Enable'}
      </button>
      {plugin.enabled ? (
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Restart ${title}`}
          disabled={busy}
          onClick={() => void act('restart', () => api.plugins.restart({ name }))}
        >
          Restart
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-danger-outline plugin-remove"
        aria-label={`Remove plugin ${title}`}
        disabled={busy}
        onClick={(e) => {
          opener.current = e.currentTarget;
          void ask('remove');
        }}
      >
        Remove plugin
      </button>
    </>
  );

  return (
    <li className="plugin-row">
      <article aria-labelledby={`${id}-name`}>
        <div className="plugin-row-main">
          <PluginTile title={title} icon={plugin.icon} />
          <div className="plugin-row-text">
            <div className="plugin-row-title">
              <h3 ref={heading} id={`${id}-name`} tabIndex={-1}>
                {title}
              </h3>
              <span className="mono plugin-version">{plugin.version}</span>
              {update ? <span className="plugin-row-update">{`${update} available`}</span> : null}
            </div>
            <span className="plugin-row-used">{usedByText(plugin.usedBy)}</span>
            {reason ? <span className="plugin-row-reason">{reason}</span> : null}
          </div>
          <span className={`plugin-status is-${status.tone}`}>
            <Icon name={STATUS_ICON[status.tone]} size={13} strokeWidth={2.6} round />
            {status.label}
          </span>
          <div className="plugin-row-actions">
            {update ? (
              <button
                type="button"
                className="btn btn-update"
                aria-label={`Update ${title} to ${update}`}
                disabled={busy}
                onClick={(e) => {
                  updateReturn.current = e.currentTarget;
                  void checkUpdate(update);
                }}
              >
                Update
              </button>
            ) : null}
            <button
              type="button"
              className={open ? 'btn btn-secondary is-open' : 'btn btn-secondary'}
              aria-label={`${title} settings`}
              aria-expanded={open}
              aria-controls={`${id}-settings`}
              onClick={() => setOpen((o) => !o)}
            >
              Settings
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} strokeWidth={2.6} />
            </button>
          </div>
        </div>
        {plugin.blocked ? (
          <div className="alert alert-danger plugin-row-alert" role="alert">
            <Icon name="cross" strokeWidth={2.4} round />
            <span>
              {blockedText(plugin.blocked)}
              {webLink(plugin.blocked.url) ? (
                <>
                  {' '}
                  <a
                    href={webLink(plugin.blocked.url) ?? ''}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Advisory
                  </a>
                </>
              ) : null}
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="alert alert-danger plugin-row-alert" role="alert">
            <Icon name="cross" strokeWidth={2.4} round />
            <span>{error}</span>
          </div>
        ) : null}
        {open ? (
          <div id={`${id}-settings`} className="plugin-panel">
            {plugin.hasIntegration ? (
              <IntegrationSettings
                name={name}
                title={title}
                effect={effect}
                actions={actions}
                onTested={onChanged}
              />
            ) : (
              <div className="plugin-settings-actions">{actions}</div>
            )}
            <NodeChips nodes={nodes} label={`Nodes ${title} adds`} />
            {others.length > 0 ? (
              <div className="plugin-versions">
                <h4 id={`${id}-versions`}>Other versions</h4>
                <ul aria-labelledby={`${id}-versions`}>
                  {others.map((v) => (
                    <li key={v.version} className="plugin-version-row">
                      <span className="mono">{v.version}</span>
                      {v.compatible ? null : (
                        <span className="catalog-needs">{`needs SDK ${v.sdk}`}</span>
                      )}
                      {v.blocked ? (
                        <span className="catalog-needs">{`blocklisted: ${v.blocked.reason}`}</span>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={`Switch ${title} to ${v.version}`}
                        disabled={busy || !v.compatible || v.blocked !== null}
                        onClick={(e) => {
                          updateReturn.current = e.currentTarget;
                          void checkUpdate(v.version);
                        }}
                      >
                        Switch
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {name === 'tmdb' ? <TmdbAttribution /> : null}
          </div>
        ) : null}
        {updating ? (
          <UpdateDialog
            name={name}
            version={updating.version}
            check={updating.check}
            returnFocusTo={updateReturn}
            onConfirm={() => void confirmUpdate()}
            onCancel={() => setUpdating(null)}
          />
        ) : null}
        <Dialog
          open={asking !== null}
          tone="danger"
          showClose
          title={`${asking?.kind === 'disable' ? 'Disable' : 'Remove'} ${name}?`}
          returnFocusTo={opener.current}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={() => void confirmAsked()}>
                <Icon name={asking?.kind === 'disable' ? 'pause' : 'trash'} size={16} />
                {asking?.kind === 'disable' ? 'Disable' : 'Remove'}
              </button>
            </>
          }
        >
          {asking?.unchecked ? (
            <div className="alert alert-warning" role="alert">
              <Icon name="alert" size={16} round />
              <span>{`Couldn't check which workflows use ${name}`}</span>
            </div>
          ) : null}
          <p>{asking?.text}</p>
        </Dialog>
      </article>
    </li>
  );
}
