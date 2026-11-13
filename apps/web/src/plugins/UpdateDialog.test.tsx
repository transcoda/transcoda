import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';
import { UpdateDialog } from './UpdateDialog.tsx';

afterEach(cleanup);

type Props = Parameters<typeof UpdateDialog>[0];

function show(check: Props['check'], hosts: Pick<Props, 'network' | 'added'> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  renderAt(
    '/plugins',
    <UpdateDialog
      name="sonarr"
      version="1.1.0"
      check={check}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...hosts}
    />,
  );
  return {
    onConfirm,
    onCancel,
    dialog: screen.getByRole('dialog', { name: 'Update sonarr to 1.1.0' }),
  };
}

describe('UpdateDialog', () => {
  it('dropped version: the danger block lists the workflows with their active version; Update is the danger button; notices are notes the dialog is described by', () => {
    const { dialog, onConfirm, onCancel } = show({
      wouldBreak: [
        { id: 'a', name: 'TV cleanup', active: true, version: 3, reason: 'dropped' },
        { id: 'b', name: 'Movies', active: true, version: 7, reason: 'dropped' },
      ],
      needsReview: [],
      unknown: false,
    });
    expect(
      within(dialog).getByText(
        "These workflows' active versions use a node version sonarr 1.1.0 no longer provides. They stop running after the update until you activate a version without it:",
      ),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['TV cleanup (active v3)', 'Movies (active v7)']);
    expect(within(dialog).queryByRole('alert')).toBeNull();
    const note = within(dialog).getByRole('note');
    expect(dialog.getAttribute('aria-describedby')).toBe(note.id);
    const update = within(dialog).getByRole('button', { name: 'Update' });
    expect(update.className).toContain('btn-danger');
    fireEvent.click(update);
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('behaviour hold: its own copy, never "keeps running", and the danger button', () => {
    const { dialog } = show({
      wouldBreak: [{ id: 'a', name: 'TV cleanup', active: true, version: 3, reason: 'behaviour' }],
      needsReview: [],
      unknown: false,
    });
    expect(dialog.textContent).toContain(
      "sonarr 1.1.0 changes the behavior of nodes in these workflows' active versions. They stop running after the update until you review and activate the new version written for them:",
    );
    expect(dialog.textContent).toContain('TV cleanup (active v3)');
    expect(dialog.textContent).not.toContain('keeps running');
    expect(dialog.textContent).not.toContain('no longer provides');
    expect(within(dialog).getByRole('button', { name: 'Update' }).className).toContain(
      'btn-danger',
    );
  });

  it('needsReview: only newest versions, the active ones are said to be unaffected; Update is not a danger button', () => {
    const { dialog } = show({
      wouldBreak: [],
      needsReview: [{ id: 'a', name: 'TV cleanup' }],
      unknown: false,
    });
    expect(dialog.textContent).toContain(
      'The newest version of these workflows is affected and is written for review where an upgrade exists. Their active versions are not affected:',
    );
    expect(within(dialog).getByRole('listitem').textContent).toBe('TV cleanup');
    expect(within(dialog).getByRole('button', { name: 'Update' }).className).not.toContain(
      'btn-danger',
    );
    expect(dialog.textContent).not.toContain('No workflow is affected.');
  });

  it('unknown: says the release does not list its node versions', () => {
    const { dialog } = show({ wouldBreak: [], needsReview: [], unknown: true });
    expect(dialog.textContent).toContain(
      'This release does not say which node versions it serves; workflows pinned to older versions may stop running.',
    );
    expect(dialog.textContent).not.toContain('No workflow is affected.');
  });

  it('nothing affected: says so', () => {
    const { dialog } = show({ wouldBreak: [], needsReview: [], unknown: false });
    expect(within(dialog).getByText('No workflow is affected.')).toBeTruthy();
    expect(within(dialog).queryByRole('list')).toBeNull();
  });

  it('lists the hosts the version connects to and marks the ones it adds, in a note the dialog is described by', () => {
    const sonarr = { setting: 'url', label: 'Sonarr URL' };
    const tvdb = { origin: 'https://api.thetvdb.example' };
    const { dialog } = show(
      { wouldBreak: [], needsReview: [], unknown: false },
      { network: [sonarr, tvdb], added: [tvdb] },
    );
    const hosts = within(dialog).getByRole('list', { name: 'Connects to' });
    expect(
      within(hosts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['The Sonarr URL you enter in its settings', 'api.thetvdb.examplenew']);
    const note = within(dialog).getByText(
      'sonarr 1.1.0 connects to a host the installed version does not: api.thetvdb.example.',
    );
    expect(note.closest('[role="note"]')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toContain(
      note.closest('[role="note"]')?.id ?? 'missing',
    );
    // Nothing breaks, so Update stays the primary button.
    expect(within(dialog).getByRole('button', { name: 'Update' }).className).toContain(
      'btn-primary',
    );
  });

  it('with no added host there is no note; a version without a list says so', () => {
    let { dialog } = show(
      { wouldBreak: [], needsReview: [], unknown: false },
      { network: [{ origin: 'https://discord.com' }], added: [] },
    );
    expect(
      within(dialog).queryByText(/connects to a host the installed version does not/),
    ).toBeNull();
    expect(dialog.textContent).not.toContain('new');
    cleanup();
    ({ dialog } = show({ wouldBreak: [], needsReview: [], unknown: false }, { network: null }));
    expect(within(dialog).getByText('Not listed: this build predates host lists.')).toBeTruthy();
  });
});
