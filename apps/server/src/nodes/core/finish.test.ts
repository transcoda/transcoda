import type { DecideContext, FinishContext } from '@transcoda/sdk';
import {
  CHECK_SOURCE_TYPE,
  type JsonValue,
  portShown,
  RENDER_DAMAGED_PORT,
  RENDER_DONE_PORT,
  RENDER_TYPE,
} from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { modelFromProbe } from '../../engine/model/model.ts';
import { probeOf } from '../../engine/testing/builders.ts';
import type { CheckSourceResult, CoreTools } from '../core-tools.ts';
import { checkSource } from './check-source.ts';
import { moveCopy, notifyWebhook, render, replaceOriginal, sizeGate } from './finish.ts';
import { decide, decideCtx, finish } from './testing.ts';

describe('finish nodes', () => {
  it('finish nodes return their actions', async () => {
    const probe = probeOf([{}]);
    const ctx: FinishContext = { ...decideCtx(probe), model: modelFromProbe(probe) };
    expect(await finish(sizeGate, ctx)).toEqual({
      actions: [{ kind: 'size-gate', minSavingPercent: 10 }],
      reason: 'size gate: at least 10% smaller',
    });
    expect(
      await finish(sizeGate, ctx, { minSavingPercent: 20, belowMinimum: 'write-track-changes' }),
    ).toEqual({
      actions: [{ kind: 'size-gate', minSavingPercent: 20, belowMinimum: 'write-track-changes' }],
      reason: 'size gate: at least 20% smaller; else write the track changes only',
    });
    expect(await finish(replaceOriginal, ctx)).toEqual({
      actions: [{ kind: 'replace', recycleFolder: null }],
      reason: 'replace the original (recycle folder: library default)',
    });
    expect((await finish(replaceOriginal, ctx, { recycleFolder: '/r' })).actions).toEqual([
      { kind: 'replace', recycleFolder: '/r' },
    ]);
    expect(await finish(moveCopy, ctx, { outputRoot: '/out' })).toEqual({
      actions: [{ kind: 'move-copy', mode: 'copy', outputRoot: '/out' }],
      reason: 'copy the result to /out',
    });
    // The webhook URL may carry a token, so the reason never shows it.
    expect(await finish(notifyWebhook, ctx, { url: 'https://hooks.example/t?token=abc' })).toEqual({
      actions: [{ kind: 'notify', url: 'https://hooks.example/t?token=abc', method: 'POST' }],
      reason: 'notify webhook (POST)',
    });
  });

  it('render: Quality check off → one render action, Damaged hidden; on → the action carries qualityCheck true and Damaged is shown', async () => {
    const probe = probeOf([{}]);
    const ctx: FinishContext = { ...decideCtx(probe), model: modelFromProbe(probe) };
    expect(render).toMatchObject({ kind: 'finish', finishPhase: 'render', type: RENDER_TYPE });
    const shown = (settings: JsonValue) =>
      render.outputs.filter((p) => portShown(p, settings)).map((p) => p.id);
    expect(await finish(render, ctx)).toEqual({
      actions: [{ kind: 'render', qualityCheck: false }],
      reason: 'render',
    });
    expect(shown(render.settings.parse({}) as JsonValue)).toEqual([RENDER_DONE_PORT]);
    expect(await finish(render, ctx, { qualityCheck: true })).toEqual({
      actions: [{ kind: 'render', qualityCheck: true }],
      reason: 'render; a damaged source continues on Damaged',
    });
    expect(shown({ qualityCheck: true })).toEqual([RENDER_DONE_PORT, RENDER_DAMAGED_PORT]);
  });

  it('check-source: ok → port ok; damaged → port damaged with findings; error → throws retryable (not when final)', async () => {
    const probe = probeOf([{}]);
    const asked: boolean[] = [];
    const withCore = (r: CheckSourceResult): DecideContext => {
      const core: CoreTools = {
        async checkSource({ decodeVideo }) {
          asked.push(decodeVideo);
          return r;
        },
        alreadyProcessed: async () => {
          throw new Error('not asked');
        },
      };
      return { ...decideCtx(probe), core } as DecideContext;
    };
    expect(checkSource).toMatchObject({ kind: 'condition', type: CHECK_SOURCE_TYPE });
    expect(checkSource.outputs.map((p) => p.id)).toEqual(['ok', 'damaged']);
    expect(await decide(checkSource, withCore({ kind: 'ok', warnings: [] }))).toEqual({
      port: 'ok',
      reason: 'source reads clean',
      findings: { warnings: [] },
    });
    expect(
      await decide(
        checkSource,
        withCore({ kind: 'ok', warnings: ['ends 5 s short of the declared 1:40'] }),
        { decodeVideo: true },
      ),
    ).toMatchObject({
      port: 'ok',
      reason: 'source reads clean; ends 5 s short of the declared 1:40',
    });
    expect(asked).toEqual([false, true]);
    expect(
      await decide(
        checkSource,
        withCore({
          kind: 'damaged',
          reason: 'audio #1 (DTS): Invalid LFE scale factor index',
          stream: 'audio #1 (DTS)',
        }),
      ),
    ).toEqual({
      port: 'damaged',
      reason: 'audio #1 (DTS): Invalid LFE scale factor index',
      findings: {
        reason: 'audio #1 (DTS): Invalid LFE scale factor index',
        stream: 'audio #1 (DTS)',
      },
    });
    const failed = decide(checkSource, withCore({ kind: 'error', message: 'Input/output error' }));
    await expect(failed).rejects.toMatchObject({
      message: 'check source failed: Input/output error',
      retryable: true,
    });
    // Stopped by the memory guard: another try would buffer the same way.
    const final = decide(
      checkSource,
      withCore({
        kind: 'error',
        message: 'ffmpeg used more than 4.00 GB of memory and was stopped',
        final: true,
      }),
    );
    await expect(final).rejects.toMatchObject({
      message: 'check source failed: ffmpeg used more than 4.00 GB of memory and was stopped',
      retryable: false,
    });
    await expect(decide(checkSource, decideCtx(probe))).rejects.toThrow(
      'check source is not available here',
    );
  });
});
