import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginSummary } from '@transcoda/contract';
import { describe, expect, it } from 'vitest';
import { plugin } from '../test/fixtures/plugins.ts';
import {
  blockedText,
  CUSTOM_CATALOG_WARNING,
  removeConfirmText,
  SECURITY_PROMISE,
  stateLabel,
  statusOf,
  testEffect,
  testSentence,
  usedByText,
} from './pluginText.ts';

const now = new Date('2026-10-17T09:00:00.000Z');

describe('stateLabel', () => {
  it('words every state', () => {
    expect(stateLabel(plugin({ state: 'running' }), now)).toBe('running');
    expect(stateLabel(plugin({ state: 'starting' }), now)).toBe('starting');
    expect(stateLabel(plugin({ state: 'disabled', enabled: false }), now)).toBe('disabled');
    expect(
      stateLabel(
        plugin({ state: 'stopped', stateReason: 'exited with code 3 (3 crashes in 10 min)' }),
        now,
      ),
    ).toBe('stopped: exited with code 3 (3 crashes in 10 min)');
    expect(stateLabel(plugin({ state: 'stopped', stateReason: null }), now)).toBe('stopped');
  });

  it('counts down to the next restart, never below zero', () => {
    const restarting = plugin({ state: 'restarting', nextRestartAt: '2026-10-17T09:00:04.200Z' });
    expect(stateLabel(restarting, now)).toBe('restarting in 5 s');
    expect(stateLabel(restarting, new Date('2026-10-17T09:00:09.000Z'))).toBe('restarting in 0 s');
    expect(stateLabel(plugin({ state: 'restarting', nextRestartAt: null }), now)).toBe(
      'restarting in 0 s',
    );
  });
});

describe('removeConfirmText', () => {
  it('says only that settings go when no workflow uses the plugin', () => {
    expect(removeConfirmText('example', [])).toBe('Remove example? Its settings are deleted too.');
  });

  it('names the workflows and, separately, the active ones', () => {
    expect(
      removeConfirmText('example', [
        { name: 'TV cleanup', active: true },
        { name: 'Movies', active: false },
      ]),
    ).toBe(
      'Remove example? Its settings are deleted too. 2 workflows use its nodes and will show "plugin missing": TV cleanup, Movies. TV cleanup is active and will stop running until a version without these nodes is activated.',
    );
    expect(removeConfirmText('example', [{ name: 'Movies', active: false }])).toBe(
      'Remove example? Its settings are deleted too. 1 workflow uses its nodes and will show "plugin missing": Movies.',
    );
  });
});

/** The blockquote under "What the sandbox does and does not do" in docs/plugin-sdk.md, unquoted. */
function promiseInSdkDoc(): string {
  const doc = readFileSync(join(import.meta.dirname, '../../../../docs/plugin-sdk.md'), 'utf8');
  const lines = doc.split('\n');
  const heading = lines.indexOf('## What the sandbox does and does not do');
  expect(heading).toBeGreaterThan(-1);
  const quote: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith('>')) quote.push(line.replace(/^> ?/, ''));
    else if (quote.length > 0) break;
  }
  return quote.join('\n');
}

describe('fixed copy', () => {
  it('pins the install warning', () => {
    expect(CUSTOM_CATALOG_WARNING).toBe(
      'Plugins are code that runs inside Transcoda. Only install from sources you trust. The sandbox stops file writes and new processes, not the network; an unsigned catalog is only as trustworthy as whoever controls its URL.',
    );
  });

  it('keeps the security promise identical in plugin-sdk.md and the UI', () => {
    expect(promiseInSdkDoc()).toBe(SECURITY_PROMISE);
  });

  it('carries the hardening text', () => {
    const paragraphs = SECURITY_PROMISE.split('\n\n');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toMatch(
      /^Plugins are code that runs inside Transcoda\. Treat installing one/,
    );
    expect(paragraphs[1]).toBe(
      "This is accident protection, not a wall. A malicious plugin could still use the network freely (Transcoda offers a controlled HTTP client, but cannot block raw sockets: the network is outside Node's permission model) or exhaust memory the heap limit does not count. In the Docker image every plugin process runs as a separate unprivileged user, shared by all plugins, so it cannot signal Transcoda's own process or read `/config` (plugins can still signal each other); outside the image, when the container is started with `--user`, or with `TRANSCODA_PLUGIN_ISOLATION=off`, plugins share Transcoda's user and can do both. The official catalog only lists builds made by our CI from the public source, signed with a key this version of Transcoda knows; the signature and checksum are verified before every start, and a blocklist we publish stops known-bad builds within an hour. Custom catalogs are unsigned unless you pin their key, and show a warning for this reason. Install only what you would run on the server yourself.",
    );
  });
});

describe('blockedText', () => {
  it('says Blocklisted with the reason', () => {
    expect(blockedText({ reason: 'Exfiltrates tokens' })).toBe('Blocklisted: Exfiltrates tokens');
  });
});

describe('docs/plugins.md', () => {
  const guide = readFileSync(join(import.meta.dirname, '../../../../docs/plugins.md'), 'utf8');

  it('quotes the security promise verbatim', () => {
    const quoted = SECURITY_PROMISE.split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n');
    expect(guide).toContain(quoted);
  });

  it('quotes the custom catalog warning verbatim', () => {
    expect(guide).toContain(`> ${CUSTOM_CATALOG_WARNING}`);
  });
});

describe('statusOf', () => {
  it('says how the last connection test went for a running plugin with settings', () => {
    const at = '2026-10-17T08:58:00.000Z';
    const passed = plugin({ hasIntegration: true, lastTest: { at, ok: true, kind: null } });
    expect(statusOf(passed, now)).toEqual({ tone: 'ok', label: 'Connected' });
    type Kind = NonNullable<NonNullable<PluginSummary['lastTest']>['kind']>;
    const failed = (kind: Kind) =>
      statusOf(plugin({ hasIntegration: true, lastTest: { at, ok: false, kind } }), now);
    expect(failed('unreachable')).toEqual({ tone: 'error', label: "Can't reach server" });
    expect(failed('unauthorized')).toEqual({ tone: 'error', label: 'Access refused' });
    expect(failed('wrong-product')).toEqual({ tone: 'error', label: 'Wrong server' });
    expect(failed('too-old')).toEqual({ tone: 'error', label: 'Server too old' });
    expect(failed('other')).toEqual({ tone: 'error', label: 'Test failed' });
    expect(statusOf(plugin({ hasIntegration: true, lastTest: null }), now)).toEqual({
      tone: 'warning',
      label: 'Not tested',
    });
    expect(statusOf(plugin(), now)).toEqual({ tone: 'ok', label: 'Running' });
  });

  it('a plugin that does not run says so first; a blocked one says Blocked', () => {
    const ok = { at: '2026-10-17T08:58:00.000Z', ok: true, kind: null };
    const p = (over: Partial<PluginSummary>) =>
      statusOf(plugin({ hasIntegration: true, lastTest: ok, ...over }), now);
    expect(p({ state: 'stopped', stateReason: 'x' })).toEqual({ tone: 'error', label: 'Stopped' });
    expect(p({ state: 'disabled', enabled: false })).toEqual({
      tone: 'neutral',
      label: 'Disabled',
    });
    expect(p({ state: 'starting' })).toEqual({ tone: 'neutral', label: 'Starting' });
    expect(p({ state: 'restarting', nextRestartAt: '2026-10-17T09:00:12.000Z' })).toEqual({
      tone: 'warning',
      label: 'Restarting in 12 s',
    });
    expect(p({ blocked: { reason: 'x', url: null }, state: 'stopped' })).toEqual({
      tone: 'error',
      label: 'Blocked',
    });
  });
});

describe('usedByText', () => {
  it('names up to three workflows, then counts the rest', () => {
    const w = (name: string) => ({ id: name, name, active: false });
    expect(usedByText([])).toBe('Not used by any workflow yet');
    expect(usedByText([w('TV cleanup'), w('Movie shrink')])).toBe(
      'Used by TV cleanup, Movie shrink',
    );
    expect(usedByText(['A', 'B', 'C', 'D', 'E'].map(w))).toBe('Used by A, B, C and 2 more');
  });
});

describe('testSentence and testEffect', () => {
  it('says when the test ran and what it found', () => {
    const at = '2026-10-17T08:58:00.000Z';
    expect(
      testSentence(
        { at, result: { ok: false, kind: 'unreachable', message: 'connection refused' } },
        now,
      ),
    ).toBe('Test failed 2 min ago: connection refused');
    expect(testSentence({ at, result: { ok: true, message: 'Jellyfin 10.9.1' } }, now)).toBe(
      'Test passed 2 min ago: Jellyfin 10.9.1',
    );
  });

  it("explains what a failed connection costs, from the plugin's nodes", () => {
    const finish = (finishPhase: 'library-manager' | 'media-server' | 'notify') => ({
      kind: 'finish' as const,
      finishPhase,
    });
    expect(testEffect('Jellyfin', [finish('media-server')])).toBe(
      'Files are still replaced; only the library refresh is skipped.',
    );
    expect(testEffect('Sonarr', [finish('library-manager')])).toBe(
      'Files are still replaced; only the rescan in Sonarr is skipped.',
    );
    expect(testEffect('ntfy', [finish('notify')])).toBe(
      'Jobs still finish; only the ntfy notification is skipped.',
    );
    expect(
      testEffect('Sonarr', [{ kind: 'data', finishPhase: null }, finish('library-manager')]),
    ).toBe("Steps that need Sonarr won't work until it connects.");
    expect(testEffect('Thing', [])).toBe("Steps that need Thing won't work until it connects.");
  });
});
