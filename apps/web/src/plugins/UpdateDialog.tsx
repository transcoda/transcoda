import type { PluginUpdateCheckOutput } from '@transcoda/contract';
import { type RefObject, useId } from 'react';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { NetworkHosts } from './NetworkHosts.tsx';
import { type NetworkEntry, networkEntryText } from './pluginText.ts';

/**
 * What an update would do to workflows, before it happens: the check's answer in words, with
 * `Update` (a danger button whenever an active version would stop running) and `Cancel`.
 */
export function UpdateDialog({
  name,
  version,
  check,
  onConfirm,
  onCancel,
  returnFocusTo,
  network,
  added = [],
}: {
  name: string;
  version: string;
  check: PluginUpdateCheckOutput;
  onConfirm(): void;
  onCancel(): void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** The hosts this version connects to (null: it predates the list); absent: not shown. */
  network?: readonly NetworkEntry[] | null | undefined;
  /** The entries of `network` the installed version does not have. */
  added?: readonly NetworkEntry[];
}) {
  const id = useId();
  const addedWords = added.map((e) => {
    const t = networkEntryText(e);
    return 'setting' in e ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  });
  const dropped = check.wouldBreak.filter((w) => w.reason === 'dropped');
  const held = check.wouldBreak.filter((w) => w.reason === 'behaviour');
  const breaks = check.wouldBreak.length > 0;
  const nothing = !breaks && check.needsReview.length === 0 && !check.unknown;
  const note = (key: string) => `${id}-${key}`;
  const described = [
    dropped.length > 0 ? 'dropped' : null,
    held.length > 0 ? 'held' : null,
    check.needsReview.length > 0 ? 'review' : null,
    check.unknown ? 'unknown' : null,
    added.length > 0 ? 'hosts' : null,
    nothing ? 'none' : null,
  ]
    .filter((k): k is string => k !== null)
    .map(note)
    .join(' ');
  return (
    <Dialog
      open
      tone={breaks ? 'danger' : 'default'}
      showClose
      title={`Update ${name} to ${version}`}
      describedBy={described}
      returnFocusTo={returnFocusTo ?? null}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={breaks ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            Update
          </button>
        </>
      }
    >
      {dropped.length > 0 ? (
        <div id={note('dropped')} className="alert alert-danger update-block" role="note">
          <Icon name="cross" strokeWidth={2.4} round />
          <div>
            <p>{`These workflows' active versions use a node version ${name} ${version} no longer provides. They stop running after the update until you activate a version without it:`}</p>
            <ul className="update-list" aria-label="Workflows that would stop running">
              {dropped.map((w) => (
                <li key={w.id}>{`${w.name} (active v${w.version})`}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {held.length > 0 ? (
        <div id={note('held')} className="alert alert-danger update-block" role="note">
          <Icon name="cross" strokeWidth={2.4} round />
          <div>
            <p>{`${name} ${version} changes the behavior of nodes in these workflows' active versions. They stop running after the update until you review and activate the new version written for them:`}</p>
            <ul className="update-list" aria-label="Workflows held for review">
              {held.map((w) => (
                <li key={w.id}>{`${w.name} (active v${w.version})`}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {check.needsReview.length > 0 ? (
        <div id={note('review')} className="alert update-block" role="note">
          <Icon name="alert" size={16} round />
          <div>
            <p>
              The newest version of these workflows is affected and is written for review where an
              upgrade exists. Their active versions are not affected:
            </p>
            <ul className="update-list" aria-label="Workflows with a version to review">
              {check.needsReview.map((w) => (
                <li key={w.id}>{w.name}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      {check.unknown ? (
        <div id={note('unknown')} className="alert alert-warning update-block" role="note">
          <Icon name="alert" size={16} round />
          <span>
            This release does not say which node versions it serves; workflows pinned to older
            versions may stop running.
          </span>
        </div>
      ) : null}
      {added.length > 0 ? (
        <div id={note('hosts')} className="alert alert-warning update-block" role="note">
          <Icon name="alert" size={16} round />
          <span>
            {`${name} ${version} connects to ${added.length === 1 ? 'a host' : 'hosts'} the installed version does not: ${addedWords.join(', ')}.`}
          </span>
        </div>
      ) : null}
      {nothing ? <p id={note('none')}>No workflow is affected.</p> : null}
      {network !== undefined ? <NetworkHosts network={network} added={added} /> : null}
    </Dialog>
  );
}
