import { type AnyNodeDefinition, type BuildModel, defineNode, FetchRefused } from '@transcoda/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { filePort } from '../../nodes/core/common.ts';
import { type RemoteHooks, remoteNodeDefinition } from '../../nodes/remote.ts';
import { edge, node } from '../../workflows/test-helpers.ts';
import { withSidecar } from '../testing/builders.ts';
import { input, mainGraph, setup } from './testing.ts';
import { walk } from './walk.ts';

describe('walk', () => {
  describe('plugin nodes', () => {
    const meta = {
      type: 'example:notify',
      version: 1,
      kind: 'finish' as const,
      title: 'Example notify',
      description: 'A plugin finish node.',
      icon: 'bell',
      inputs: [filePort],
      outputs: [filePort],
      settingsSchema: { type: 'object', properties: { room: { type: 'string', default: 'a' } } },
      onNodeSettings: [],
      requires: {},
      migrations: [],
      finishPhase: 'notify' as const,
      hooks: ['finish' as const],
    };

    function pluginSetup(hooks: RemoteHooks) {
      const s = setup();
      const def = remoteNodeDefinition(
        meta,
        { kind: 'plugin', name: 'example', version: '1.0.0' },
        hooks,
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source: { kind: 'plugin', name: 'example', version: '1.0.0' } }]);
      return s;
    }
    const graph = mainGraph(
      [
        node('in', 'core:input-manual'),
        node('ro', 'core:replace-original'),
        node('pn', 'example:notify', { room: 'b' }),
      ],
      [edge('in', 'ro'), edge('ro', 'pn')],
    );

    it('stamps a plugin finish action with its phase and origin and marks the trace entry', async () => {
      const { deps, trace } = pluginSetup({
        async call() {
          return {
            ok: true,
            result: {
              actions: [{ kind: 'plugin', description: 'tell room b', required: false }],
              reason: 'queued',
            },
          };
        },
      });
      const result = await walk(deps, input(graph));
      if (result.kind !== 'built') throw new Error(JSON.stringify(result));
      expect(result.actions).toEqual([
        { kind: 'replace', recycleFolder: null, nodeId: 'ro', workflowPath: [] },
        {
          kind: 'plugin',
          description: 'tell room b',
          required: false,
          phase: 'notify',
          nodeType: 'example:notify',
          nodeVersion: 1,
          nodeId: 'pn',
          workflowPath: [],
          settings: { room: 'b' },
        },
      ]);
      expect(trace.filter((e) => e.nodeId === 'pn').map((e) => e.source)).toEqual(['plugin']);
      expect(trace.filter((e) => e.nodeId === 'ro').map((e) => e.source)).toEqual(['core']);
    });

    it('a plugin node pinned to an older version goes to the host as stored, with its version, and is not parsed against the new schema', async () => {
      const seen: Array<{ version: number; settings: unknown }> = [];
      const s = setup();
      const source = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
      const def = remoteNodeDefinition(
        {
          ...meta,
          version: 3,
          migrations: [
            { from: 1, to: 2, risk: 'safe' as const, note: 'a' },
            { from: 2, to: 3, risk: 'safe' as const, note: 'b' },
          ],
        },
        source,
        {
          async call(_hook, _type, version, _ctx, settings) {
            seen.push({ version, settings });
            return {
              ok: true,
              result: {
                actions: [{ kind: 'plugin', description: 'd', required: false }],
                reason: 'ok',
              },
            };
          },
        },
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source }]);
      // `room: 5` is not a string: the v3 schema would refuse it before the host could migrate it.
      const old = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ro', 'core:replace-original'),
          node('pn', 'example:notify', { room: 5 }, { typeVersion: 1 }),
        ],
        [edge('in', 'ro'), edge('ro', 'pn')],
      );
      const result = await walk(s.deps, input(old));
      expect(result.kind).toBe('built');
      expect(seen).toEqual([{ version: 1, settings: { room: 5 } }]);
      if (result.kind !== 'built') return;
      expect(result.actions[1]).toMatchObject({ nodeVersion: 1, settings: { room: 5 } });
    });

    it('a pinned older plugin node whose path has a behaviour step fails the node (defence in depth: validation holds it first)', async () => {
      const s = setup();
      const source = { kind: 'plugin', name: 'example', version: '1.0.0' } as const;
      let called = false;
      const def = remoteNodeDefinition(
        {
          ...meta,
          version: 2,
          migrations: [{ from: 1, to: 2, risk: 'behaviour' as const, note: 'b' }],
        },
        source,
        {
          async call() {
            called = true;
            return { ok: true, result: { actions: [], reason: 'ok' } };
          },
        },
        { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
      );
      s.deps.registry.add([{ def, source }]);
      const old = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('ro', 'core:replace-original'),
          node('pn', 'example:notify', { room: 'b' }, { typeVersion: 1 }),
        ],
        [edge('in', 'ro'), edge('ro', 'pn')],
      );
      // Like invalid settings of a core node: the walk throws, the node never runs.
      await expect(walk(s.deps, input(old))).rejects.toThrow('plugin update changes behavior');
      expect(called).toBe(false);
    });

    it('a retryable remote failure is a retryable walk failure; a plain one is not', async () => {
      for (const retryable of [true, false]) {
        const { deps } = pluginSetup({
          async call() {
            return { ok: false, error: { message: 'plugin example crashed', retryable } };
          },
        });
        const result = await walk(deps, input(graph));
        expect(result).toMatchObject({
          kind: 'failed',
          nodeId: 'pn',
          reason: 'plugin example crashed',
          retryable,
        });
      }
    });

    describe('input files', () => {
      const actionMeta = {
        type: 'example:subs',
        version: 1,
        kind: 'action' as const,
        title: 'Example subs',
        description: 'A plugin build node.',
        icon: 'cc',
        inputs: [filePort],
        outputs: [filePort],
        settingsSchema: { type: 'object', properties: {} },
        onNodeSettings: [],
        requires: {},
        migrations: [],
        finishPhase: null,
        hooks: ['build' as const],
      };
      const buildGraph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('pa', 'example:subs'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'pa'), edge('pa', 'ro')],
      );
      const WRONG = 'plugin build hooks cannot change input files';

      /** A plugin whose build hook returns the model it was given, changed by `edit`. */
      function pluginBuild(edit: (model: BuildModel) => BuildModel) {
        const s = setup();
        const def = remoteNodeDefinition(
          actionMeta,
          { kind: 'plugin', name: 'example', version: '1.0.0' },
          {
            async call(_hook, _type, _version, ctx) {
              const { model } = ctx as unknown as { model: BuildModel };
              return {
                ok: true,
                result: JSON.parse(JSON.stringify({ model: edit(model), reason: 'changed' })),
              };
            },
          },
          { callTimeoutMs: 1000, finishRunTimeoutMs: 2000 },
        );
        s.deps.registry.add([
          { def, source: { kind: 'plugin', name: 'example', version: '1.0.0' } },
        ]);
        return s;
      }

      it('a plugin build hook cannot change input files', async () => {
        const evil = (model: BuildModel): BuildModel =>
          withSidecar(model, 1, 'passwd.srt', { add: false, afterReplace: 'keep' });
        const { deps, trace } = pluginBuild((m) => {
          const out = evil(m);
          (out.extraInputs?.[0] as { path: string }).path = '/etc/passwd';
          return out;
        });
        const result = await walk(deps, input(buildGraph));
        expect(result).toMatchObject({
          kind: 'failed',
          nodeId: 'pa',
          reason: WRONG,
          retryable: false,
        });
        expect(trace.at(-1)).toMatchObject({ nodeId: 'pa', reason: `failed: ${WRONG}` });
      });

      it('a plugin build hook cannot add or re-point an extra stream either', async () => {
        for (const edit of [
          (m: BuildModel) => withSidecar(m, 1, 'x.srt'),
          (m: BuildModel) => ({
            ...m,
            streams: m.streams.map((s, i) => (i === 1 ? { ...s, input: 1 } : s)),
          }),
        ]) {
          const { deps } = pluginBuild(edit);
          expect(await walk(deps, input(buildGraph))).toMatchObject({
            kind: 'failed',
            nodeId: 'pa',
            reason: WRONG,
          });
        }
      });

      it('a plugin build hook that leaves the input files alone passes', async () => {
        const { deps } = pluginBuild((m) => ({ ...m, globalArgs: [...m.globalArgs, '-x'] }));
        expect(await walk(deps, input(buildGraph))).toMatchObject({ kind: 'built' });
      });

      it('a plugin build hook may edit a stream that comes from an extra input', async () => {
        const addSub = defineNode({
          type: 'test:add-sub',
          version: 1,
          kind: 'action',
          title: 'Add sub',
          description: 'Adds a sidecar like core:embed-sidecar-subtitles will.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'Show.de.srt'), reason: 'added a sidecar' };
          },
        });
        const s = pluginBuild((m) => ({
          ...m,
          streams: m.streams.map((st) => (st.input === 1 ? { ...st, default: true } : st)),
        }));
        s.deps.registry.add([{ def: addSub, source: { kind: 'core' } }]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('cs', 'test:add-sub'),
            node('pa', 'example:subs'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'cs'), edge('cs', 'pa'), edge('pa', 'ro')],
        );
        const result = await walk(s.deps, input(graph));
        if (result.kind !== 'built') throw new Error(JSON.stringify(result));
        expect(result.model.extraInputs).toHaveLength(1);
        expect(result.model.streams.find((st) => st.input === 1)?.default).toBe(true);
      });

      const addTwo = defineNode({
        type: 'test:add-two',
        version: 1,
        kind: 'action',
        title: 'Add two',
        description: 'Adds two sidecars and leaves a dropped source stream.',
        icon: 'test',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          let model = withSidecar(ctx.model, 1, 'Show.de.srt');
          model = withSidecar(model, 2, 'Show.en.srt', { language: 'eng' });
          return {
            model: {
              ...model,
              streams: model.streams.map((st) =>
                st.sourceIndex === 1 ? { ...st, keep: false } : st,
              ),
            },
            reason: 'added sidecars',
          };
        },
      });
      const twoGraph = mainGraph(
        [
          node('in', 'core:input-manual'),
          node('cs', 'test:add-two'),
          node('pa', 'example:subs'),
          node('ro', 'core:replace-original'),
        ],
        [edge('in', 'cs'), edge('cs', 'pa'), edge('pa', 'ro')],
      );

      it('a plugin that re-sorts the streams, or removes a dropped source stream, is not a change', async () => {
        for (const edit of [
          (m: BuildModel): BuildModel => ({ ...m, streams: [...m.streams].reverse() }),
          (m: BuildModel): BuildModel => ({
            ...m,
            streams: m.streams.filter((st) => st.keep || st.input !== undefined),
          }),
        ]) {
          const s = pluginBuild(edit);
          s.deps.registry.add([{ def: addTwo, source: { kind: 'core' } }]);
          expect(await walk(s.deps, input(twoGraph))).toMatchObject({ kind: 'built' });
        }
      });

      it('a non-core node is guarded even when its definition has no settingsJsonSchema', async () => {
        const sneaky = defineNode({
          type: 'example:sneaky',
          version: 1,
          kind: 'action',
          title: 'Sneaky',
          description: 'A plugin-sourced local definition.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'x.srt'), reason: 'added' };
          },
        });
        const { deps } = setup();
        deps.registry.add([
          { def: sneaky, source: { kind: 'plugin', name: 'example', version: '1.0.0' } },
        ]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('pa', 'example:sneaky'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'pa'), edge('pa', 'ro')],
        );
        expect(await walk(deps, input(graph))).toMatchObject({
          kind: 'failed',
          nodeId: 'pa',
          reason: WRONG,
        });
      });

      it('a core build hook may add input files', async () => {
        const addSub = defineNode({
          type: 'test:add-sub',
          version: 1,
          kind: 'action',
          title: 'Add sub',
          description: 'Adds a sidecar like core:embed-sidecar-subtitles will.',
          icon: 'test',
          inputs: [filePort],
          outputs: [filePort],
          settings: z.object({}),
          async build(ctx) {
            return { model: withSidecar(ctx.model, 1, 'Show.de.srt'), reason: 'added a sidecar' };
          },
        });
        const { deps } = setup();
        deps.registry.add([{ def: addSub, source: { kind: 'core' } }]);
        const graph = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('cs', 'test:add-sub'),
            node('ro', 'core:replace-original'),
          ],
          [edge('in', 'cs'), edge('cs', 'ro')],
        );
        const result = await walk(deps, input(graph));
        if (result.kind !== 'built') throw new Error(JSON.stringify(result));
        expect(result.model.extraInputs?.map((e) => e.label.file)).toEqual(['Show.de.srt']);
        expect(result.model.streams.filter((st) => st.input === 1)).toHaveLength(1);
      });
    });

    describe('an unavailable plugin entry', () => {
      const unavailableEntry = (def: AnyNodeDefinition) => ({
        def,
        source: { kind: 'plugin', name: 'example', version: '1.0.0' } as const,
        unavailable: () => 'plugin example is not running: exited with code 3',
      });
      const pluginAct = defineNode({
        type: 'example:act',
        version: 1,
        kind: 'action',
        title: 'Example act',
        description: 'd',
        icon: 'x',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          return { model: ctx.model, reason: 'ran' };
        },
      });
      const pluginData = defineNode({
        type: 'example:lang',
        version: 1,
        kind: 'data',
        title: 'Example lang',
        description: 'd',
        icon: 'x',
        inputs: [],
        outputs: [{ id: 'language', label: 'Language', type: 'data:language' }],
        settings: z.object({}),
        async data() {
          return { value: 'jpn', reason: 'ran' };
        },
      });

      it('fails an action node instead of running it', async () => {
        const { deps, trace } = setup();
        deps.registry.add([unavailableEntry(pluginAct)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('x', 'example:act'),
            node('f', 'test:fin', { percent: 1 }),
          ],
          [edge('in', 'x'), edge('x', 'f')],
        );
        const r = await walk(deps, input(g));
        expect(r).toMatchObject({
          kind: 'failed',
          nodeId: 'x',
          reason: "Example act can't run: plugin example is not running: exited with code 3",
          retryable: false,
        });
        expect(trace.at(-1)?.reason).toContain("failed: Example act can't run");
      });

      it('fails the walk at a data node, never resolving it to unknown', async () => {
        const { deps } = setup();
        deps.registry.add([unavailableEntry(pluginData)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            node('d', 'example:lang'),
            node('c', 'test:cond'),
            node('f', 'test:fin', { percent: 1 }),
          ],
          [
            edge('in', 'c'),
            edge('c', 'f', { from: 'pass' }),
            edge('d', 'c', { from: 'language', to: 'language' }),
          ],
        );
        const r = await walk(deps, input(g));
        expect(r).toMatchObject({
          kind: 'failed',
          nodeId: 'd',
          reason: "Example lang can't run: plugin example is not running: exited with code 3",
        });
      });

      it('a bypassed unavailable node is skipped, and the trace says why', async () => {
        const { deps, trace } = setup();
        deps.registry.add([unavailableEntry(pluginAct)]);
        const g = mainGraph(
          [
            node('in', 'core:input-manual'),
            { ...node('x', 'example:act'), bypassed: true },
            node('f', 'test:fin', { percent: 1 }),
          ],
          [edge('in', 'x'), edge('x', 'f')],
        );
        const r = await walk(deps, input(g));
        expect(r.kind).toBe('built');
        expect(trace.find((e) => e.nodeId === 'x')?.reason).toBe(
          'bypassed (plugin example is not running: exited with code 3)',
        );
      });
    });

    it('a core node gets an inert plugin context; hooks see dryRun and the job', async () => {
      const seen: unknown[] = [];
      const probing = defineNode({
        type: 'test:ctx',
        version: 1,
        kind: 'action',
        title: 'Ctx',
        description: 'Records its plugin context.',
        icon: 'test',
        inputs: [filePort],
        outputs: [filePort],
        settings: z.object({}),
        async build(ctx) {
          seen.push(ctx.plugin.settings, ctx.plugin.dryRun, ctx.plugin.job);
          await expect(ctx.plugin.fetch({ url: 'https://example.test/' })).rejects.toBeInstanceOf(
            FetchRefused,
          );
          return { model: ctx.model, reason: 'ok' };
        },
      });
      const { deps } = setup();
      deps.registry.add([{ def: probing, source: { kind: 'core' } }]);
      const g = mainGraph(
        [node('in', 'core:input-manual'), node('x', 'test:ctx')],
        [edge('in', 'x')],
      );
      const r = await walk(deps, { ...input(g), dryRun: true, jobId: 'job-1' });
      expect(r.kind).toBe('built');
      expect(seen).toEqual([{}, true, { id: 'job-1', attempt: 2 }]);
    });
  });
});
