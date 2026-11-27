import { defineNode } from '@transcoda/sdk';
import { emptyGraph, type JsonValue, type WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bumpNoPath,
  bumpV2,
  chain,
  childGraph,
  edge,
  mainGraph,
  node,
  subGraph,
  testRegistry,
  withExtraNode,
} from '../test-helpers.ts';
import { caps, codes, ctx, find, mainWith } from './testing.ts';
import { validateWorkflow } from './validate.ts';

describe('validateWorkflow', () => {
  it('a connected main workflow (manual → keep-languages → set-default-track → size-gate → replace-original) has no issues', () => {
    expect(
      validateWorkflow(
        chain(
          'workflow',
          node('in', 'core:input-manual'),
          node('kl', 'core:keep-languages'),
          node('sd', 'core:set-default-track'),
          node('sg', 'core:size-gate'),
          node('ro', 'core:replace-original'),
        ),
        ctx(),
      ),
    ).toEqual([]);
  });

  it('a data node feeding keep-languages is reachable; an orphan data node is not', () => {
    const g = chain(
      'workflow',
      node('in', 'core:input-manual'),
      node('kl', 'core:keep-languages'),
      node('ro', 'core:replace-original'),
    );
    const withData = {
      ...g,
      nodes: [...g.nodes, node('d', 'test:data-language'), node('d2', 'test:data-language')],
      edges: [...g.edges, edge('d', 'kl', { from: 'language', to: 'language' })],
    };
    expect(validateWorkflow(withData, ctx()).map((i) => [i.code, i.nodeId])).toEqual([
      ['NODE_UNREACHABLE', 'd2'],
    ]);
    expect(find(validateWorkflow(withData, ctx()), 'NODE_UNREACHABLE')[0]?.severity).toBe(
      'warning',
    );
  });

  it('a data node feeding a reachable data consumer through another data node is reachable', () => {
    const g = mainWith(node('kl', 'core:keep-languages'));
    const ports = { from: 'language', to: 'language' };
    const g2 = {
      ...g,
      nodes: [...g.nodes, node('d', 'test:data-language'), node('p', 'test:data-language-pass')],
      edges: [...g.edges, edge('d', 'p', ports), edge('p', 'kl', ports)],
    };
    expect(validateWorkflow(g2, ctx())).toEqual([]);
    // without the second hop the first data node is unreachable
    const cut = { ...g2, edges: g2.edges.filter((e) => e.id !== 'p-kl') };
    expect(find(validateWorkflow(cut, ctx()), 'NODE_UNREACHABLE').map((i) => i.nodeId)).toEqual([
      'd',
      'p',
    ]);
  });

  it('a 499-node chain validates without throwing; a cycle in it is still found', () => {
    // in, 496 actions, Render, Replace original
    const middle = Array.from({ length: 496 }, (_, i) => node(`k${i}`, 'core:keep-languages'));
    const g = mainWith(...middle);
    expect(g.nodes).toHaveLength(499);
    expect(validateWorkflow(g, ctx())).toEqual([]);
    const cyclic = { ...g, edges: [...g.edges, edge('k495', 'k0')] };
    expect(find(validateWorkflow(cyclic, ctx()), 'GRAPH_CYCLE')).toHaveLength(1);
  });

  it('a settings schema that throws → INVALID_SETTINGS at the root', () => {
    const throwing = defineNode({
      type: 'test:throwing',
      version: 1,
      kind: 'action',
      title: 'Throwing',
      description: 'Settings schema throws.',
      icon: 'test',
      inputs: [{ id: 'file', label: 'File', type: 'file' }],
      outputs: [{ id: 'file', label: 'File', type: 'file' }],
      settings: z.object({}).superRefine(() => {
        throw new Error('boom');
      }) as unknown as z.ZodObject<z.ZodRawShape>,
    });
    const issues = validateWorkflow(
      mainWith(node('t', 'test:throwing')),
      ctx({ registry: testRegistry(throwing) }),
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Settings could not be checked: boom',
        nodeId: 't',
      },
    ]);
  });

  it('unknown type, newer version, outdated with a path, outdated without a path', () => {
    const unknown = validateWorkflow(
      mainWith(node('zz', 'zz:nope', { anything: 5 }), node('x', 'core:keep-languages')),
      ctx(),
    );
    // the edge from the unknown node still connects keep-languages' input
    expect(find(unknown, 'INPUT_UNCONNECTED')).toEqual([]);
    expect(find(unknown, 'UNKNOWN_NODE_TYPE')).toEqual([
      {
        severity: 'error',
        code: 'UNKNOWN_NODE_TYPE',
        message: 'Unknown node type zz:nope',
        nodeId: 'zz',
      },
    ]);

    const newer = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' }, { typeVersion: 9 })),
      ctx(),
    );
    expect(codes(newer)).toEqual(['error:UNKNOWN_NODE_VERSION']);
    expect(newer[0]?.nodeId).toBe('b');

    const outdated = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' })),
      ctx({ registry: testRegistry(bumpV2()) }),
    );
    expect(codes(outdated)).toEqual(['error:NODE_OUTDATED']);
    expect(outdated[0]?.message).toBe('Bump is at version 1; this server has version 2');

    const noPath = validateWorkflow(
      mainWith(node('b', 'test:bump', { level: 'bad' }, { label: 'My bump' })),
      ctx({ registry: testRegistry(bumpNoPath()) }),
    );
    expect(codes(noPath)).toEqual(['error:NODE_OUTDATED']);
    expect(noPath[0]?.message).toBe(
      'My bump is at version 1; this server has version 2, and no upgrade path exists',
    );
  });

  it('missing required setting → INVALID_SETTINGS "Needs a setting" with settingPath; non-object settings → INVALID_SETTINGS', () => {
    const missing = validateWorkflow(
      chain('workflow', node('in', 'core:input-manual'), node('mc', 'core:move-copy')),
      ctx(),
    );
    expect(missing).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'Needs a setting',
        nodeId: 'mc',
        settingPath: 'outputRoot',
      },
    ]);

    const wrongType = validateWorkflow(mainWith(node('b', 'test:bump', { level: 'high' })), ctx());
    expect(wrongType).toEqual([
      expect.objectContaining({ code: 'INVALID_SETTINGS', nodeId: 'b', settingPath: 'level' }),
    ]);
    expect(wrongType[0]?.message).not.toBe('Needs a setting');

    for (const settings of [5, null, ['x']] as JsonValue[]) {
      const issues = validateWorkflow(mainWith(node('kl', 'core:keep-languages', settings)), ctx());
      expect(codes(issues)).toEqual(['error:INVALID_SETTINGS']);
      expect(issues[0]).toMatchObject({ nodeId: 'kl' });
      expect(issues[0]?.settingPath).toBeUndefined();
    }
  });

  it('edges: dangling, unknown port, wrong direction, type mismatch, double input, required input unconnected', () => {
    const base = mainWith(node('vi', 'core:video-is'), node('kl', 'core:keep-languages'));
    // base edges: in→vi (file→file, ok), vi→kl (vi has no 'file' output), kl→Render→ro
    const fixed: WorkflowGraph = {
      ...base,
      edges: [
        edge('in', 'vi'),
        edge('vi', 'kl', { from: 'pass' }),
        ...base.edges.filter((e) => [e.from.node, e.to.node].includes('render-1')),
      ],
    };
    // vi's else output stays unconnected: only the port-aware write-path warning
    expect(validateWorkflow(fixed, ctx()).map((i) => `${i.code}:${i.nodeId}`)).toEqual([
      'NO_WRITE_PATH:vi',
    ]);

    const withEdges = (...extra: WorkflowGraph['edges']) =>
      validateWorkflow({ ...fixed, edges: [...fixed.edges, ...extra] }, ctx());

    // dangling
    const dangling = withEdges(edge('kl', 'ghost'));
    expect(find(dangling, 'DANGLING_EDGE')).toEqual([
      expect.objectContaining({ severity: 'error', edgeId: 'kl-ghost' }),
    ]);

    // wrong direction: 'file' is vi's INPUT, not an output
    const fromInput = withEdges({ ...edge('vi', 'ro'), id: 'wrong-from' });
    expect(find(fromInput, 'UNKNOWN_PORT')).toEqual([
      expect.objectContaining({ edgeId: 'wrong-from' }),
    ]);

    // wrong direction: 'pass' is vi's OUTPUT, not an input
    const toOutput = withEdges({ ...edge('kl', 'vi', { to: 'pass' }), id: 'wrong-to' });
    expect(find(toOutput, 'UNKNOWN_PORT')).toEqual([
      expect.objectContaining({ edgeId: 'wrong-to' }),
    ]);

    // non-existent port
    const nope = withEdges({ ...edge('vi', 'ro', { from: 'nope' }), id: 'nope' });
    expect(find(nope, 'UNKNOWN_PORT')).toHaveLength(1);

    // type mismatch: data:language output into a file input
    const g = {
      ...fixed,
      nodes: [...fixed.nodes, node('d', 'test:data-language'), node('kl2', 'core:keep-languages')],
      edges: [...fixed.edges, edge('d', 'kl2', { from: 'language', to: 'file' })],
    };
    const mismatch = validateWorkflow(g, ctx());
    expect(find(mismatch, 'PORT_TYPE_MISMATCH')).toEqual([
      expect.objectContaining({ edgeId: 'd-kl2' }),
    ]);
    // the mismatched edge still counts as a connection: no INPUT_UNCONNECTED for kl2
    expect(find(mismatch, 'INPUT_UNCONNECTED')).toEqual([]);

    // two edges into a file input (kl.file from vi's pass and else): branches that never both
    // run merge there, so that is fine
    const fileFanIn = withEdges({ ...edge('vi', 'kl', { from: 'else' }), id: 'second' });
    expect(find(fileFanIn, 'INPUT_MULTIPLE_EDGES')).toEqual([]);
    expect(fileFanIn.map((i) => `${i.code}:${i.nodeId}`)).toEqual([]);

    // two edges into a data input (kl.language) are still an error
    const dataTwice = validateWorkflow(
      {
        ...fixed,
        nodes: [...fixed.nodes, node('d1', 'test:data-language'), node('d2', 'test:data-language')],
        edges: [
          ...fixed.edges,
          edge('d1', 'kl', { from: 'language', to: 'language' }),
          edge('d2', 'kl', { from: 'language', to: 'language' }),
        ],
      },
      ctx(),
    );
    expect(find(dataTwice, 'INPUT_MULTIPLE_EDGES')).toEqual([
      {
        severity: 'error',
        code: 'INPUT_MULTIPLE_EDGES',
        message: 'Keep languages: data input Original language takes one connection, not 2',
        nodeId: 'kl',
      },
    ]);

    // required input unconnected (kl.file); kl.language is optional
    const unconnected = validateWorkflow(
      { ...fixed, edges: fixed.edges.filter((e) => e.to.node !== 'kl') },
      ctx(),
    );
    expect(find(unconnected, 'INPUT_UNCONNECTED')).toEqual([
      {
        severity: 'error',
        code: 'INPUT_UNCONNECTED',
        message: 'Keep languages: input File is not connected',
        nodeId: 'kl',
      },
    ]);
  });

  it('an edge touching an unknown-type node gets only the existence check', () => {
    const g = mainGraph(
      [node('in', 'core:input-manual'), node('zz', 'zz:nope')],
      [edge('in', 'zz', { to: 'whatever' }), edge('zz', 'ghost')],
    );
    expect(codes(validateWorkflow(g, ctx()))).toEqual([
      'error:DANGLING_EDGE',
      'error:NO_FINISH_PATH',
      'error:UNKNOWN_NODE_TYPE',
      'warning:NO_WRITE_PATH',
    ]);
  });

  it('cycle → GRAPH_CYCLE', () => {
    const g = mainWith(node('kl', 'core:keep-languages'), node('sd', 'core:set-default-track'));
    const cyclic = { ...g, edges: [...g.edges, edge('sd', 'kl')] };
    const cycles = find(validateWorkflow(cyclic, ctx()), 'GRAPH_CYCLE');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.severity).toBe('error');
    expect(cycles[0]?.message).toContain('kl');
    expect(cycles[0]?.message).toContain('sd');
    expect(cycles[0]?.message).not.toContain('ro');
    expect(find(validateWorkflow(g, ctx()), 'GRAPH_CYCLE')).toEqual([]);
  });

  it('main workflow: zero or two triggers → TRIGGER_COUNT; no finish → NO_FINISH_PATH; start node → NODE_NOT_ALLOWED_HERE; orphan node → warning NODE_UNREACHABLE', () => {
    const none = validateWorkflow(
      chain('workflow', node('kl', 'core:keep-languages'), node('ro', 'core:replace-original')),
      ctx(),
    );
    expect(find(none, 'TRIGGER_COUNT')).toHaveLength(1);
    expect(find(none, 'NODE_UNREACHABLE')).toEqual([]); // no root, no reachability check

    const two = mainWith(node('kl', 'core:keep-languages'));
    const twoTriggers = validateWorkflow(
      withExtraNode(two, node('in2', 'core:input-webhook')),
      ctx(),
    );
    expect(codes(twoTriggers)).toEqual(['error:TRIGGER_COUNT']);

    expect(
      codes(
        validateWorkflow(
          chain('workflow', node('in', 'core:input-manual'), node('kl', 'core:keep-languages')),
          ctx(),
        ),
      ),
    ).toEqual(['error:NO_FINISH_PATH', 'warning:NO_WRITE_PATH']);
    expect(codes(validateWorkflow(emptyGraph('workflow'), ctx()))).toEqual([
      'error:NO_FINISH_PATH',
      'error:TRIGGER_COUNT',
    ]);

    // a finish node exists but is not reachable from the trigger
    const cut = mainWith(node('kl', 'core:keep-languages'));
    const disconnected = validateWorkflow(
      { ...cut, edges: cut.edges.filter((e) => e.to.node !== 'render-1') },
      ctx(),
    );
    expect(codes(disconnected)).toEqual([
      'error:INPUT_UNCONNECTED',
      'error:NO_FINISH_PATH',
      'warning:NODE_UNREACHABLE',
      'warning:NODE_UNREACHABLE',
      'warning:NO_WRITE_PATH',
    ]);

    const withStart = validateWorkflow(
      withExtraNode(mainWith(), node('s', 'core:subworkflow-start')),
      ctx(),
    );
    expect(find(withStart, 'NODE_NOT_ALLOWED_HERE')).toEqual([
      expect.objectContaining({ severity: 'error', nodeId: 's' }),
    ]);

    const orphan = validateWorkflow(withExtraNode(mainWith(), node('o', 'core:remux')), ctx());
    expect(orphan.map((i) => [i.severity, i.code, i.nodeId])).toEqual([
      ['error', 'INPUT_UNCONNECTED', 'o'],
      ['warning', 'NODE_UNREACHABLE', 'o'],
    ]);
  });

  it('sub-workflow: trigger/finish → NODE_NOT_ALLOWED_HERE; two starts → SUBWORKFLOW_IO_COUNT; emptyGraph("subworkflow") is valid', () => {
    expect(validateWorkflow(emptyGraph('subworkflow'), ctx())).toEqual([]);
    expect(validateWorkflow(childGraph(), ctx())).toEqual([]);

    const withTrigger = validateWorkflow(
      chain('subworkflow', node('in', 'core:input-manual'), node('ro', 'core:replace-original')),
      ctx(),
    );
    expect(
      find(withTrigger, 'NODE_NOT_ALLOWED_HERE')
        .map((i) => i.nodeId)
        .sort(),
    ).toEqual(['in', 'ro']);

    const twoStarts = validateWorkflow(
      subGraph(
        [node('start2', 'core:subworkflow-start')],
        [edge('start', 'end'), { ...edge('start2', 'end'), id: 'x' }],
      ),
      ctx(),
    );
    expect(find(twoStarts, 'SUBWORKFLOW_IO_COUNT')).toHaveLength(1);
    expect(find(twoStarts, 'NODE_UNREACHABLE')).toEqual([]); // no single root

    const noEnd: WorkflowGraph = {
      ...emptyGraph('subworkflow'),
      nodes: emptyGraph('subworkflow').nodes.filter((n) => n.id !== 'end'),
      edges: [],
    };
    expect(codes(validateWorkflow(noEnd, ctx()))).toEqual(['error:SUBWORKFLOW_IO_COUNT']);

    const orphan = validateWorkflow(withExtraNode(childGraph(), node('o', 'core:remux')), ctx());
    expect(find(orphan, 'NODE_UNREACHABLE').map((i) => i.nodeId)).toEqual(['o']);
  });

  it('a node whose groupId names no group → warning GROUP_MISSING', () => {
    const g = mainWith(node('kl', 'core:keep-languages', {}, { groupId: 'ghost' }));
    expect(validateWorkflow(g, ctx())).toEqual([
      {
        severity: 'warning',
        code: 'GROUP_MISSING',
        message: 'Keep languages is in group ghost, which does not exist',
        nodeId: 'kl',
      },
    ]);
    const grouped = {
      ...g,
      groups: [
        {
          id: 'ghost',
          name: 'Group',
          collapsed: false,
          position: { x: 0, y: 0 },
          size: { width: 1, height: 1 },
        },
      ],
    };
    expect(validateWorkflow(grouped, ctx())).toEqual([]);
  });

  it('a setting linked to a value that does not exist → warning VALUE_MISSING', () => {
    const g = mainWith(node('kl', 'core:keep-languages', {}, { links: { languages: 'Langs' } }));
    expect(validateWorkflow(g, ctx())).toEqual([
      {
        severity: 'warning',
        code: 'VALUE_MISSING',
        message: 'Keep languages follows the shared value "Langs", which does not exist',
        nodeId: 'kl',
        settingPath: 'languages',
      },
    ]);
  });

  it('a linked value is checked as the setting: a bad language in it is a setting error', () => {
    const g = {
      ...mainWith(node('kl', 'core:keep-languages', {}, { links: { languages: 'Langs' } })),
      values: {
        position: { x: 0, y: 0 },
        entries: [{ name: 'Langs', schema: {}, value: ['english'] }],
      },
    };
    const issues = validateWorkflow(g, ctx());
    expect(issues.map((i) => [i.code, i.nodeId, i.settingPath])).toEqual([
      ['INVALID_SETTINGS', 'kl', 'languages.0'],
    ]);
  });

  it('unavailable node (encode-audio without aac) → NODE_UNAVAILABLE; ffmpeg off → reason "ffmpeg is not available"', () => {
    const g = mainWith(node('ea', 'core:encode-audio'));
    expect(validateWorkflow(g, ctx())).toEqual([]);
    expect(validateWorkflow(g, ctx({ capabilities: { ...caps, encoders: [] } }))).toEqual([
      {
        severity: 'error',
        code: 'NODE_UNAVAILABLE',
        message: 'Encode audio is unavailable here: missing encoder aac',
        nodeId: 'ea',
      },
    ]);
    const off = validateWorkflow(
      g,
      ctx({ capabilities: { available: false, path: 'ffmpeg', error: 'ENOENT' } }),
    );
    expect(off).toEqual([
      expect.objectContaining({
        code: 'NODE_UNAVAILABLE',
        message: 'Encode audio is unavailable here: ffmpeg is not available',
      }),
    ]);
  });

  it('bypassed nodes are still validated', () => {
    const issues = validateWorkflow(
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('b', 'test:bump', { level: 'x' }, { bypassed: true }),
        node('mc', 'core:move-copy', {}, { bypassed: true }),
      ),
      ctx(),
    );
    expect(issues.map((i) => [i.code, i.nodeId])).toEqual([
      ['INVALID_SETTINGS', 'b'],
      ['INVALID_SETTINGS', 'mc'],
      // a bypassed move-copy writes nothing
      ['NO_WRITE_PATH', 'mc'],
    ]);
  });

  it('TARGET_UNSUPPORTED on encode-video hevc with targets [chrome]', () => {
    const issues = validateWorkflow(
      mainWith(node('ev', 'core:encode-video', { codec: 'hevc', targets: ['chrome'] })),
      ctx(),
    );
    expect(issues).toEqual([
      {
        severity: 'error',
        code: 'TARGET_UNSUPPORTED',
        message: 'Encode video: Chrome (desktop) cannot play hevc',
        nodeId: 'ev',
        settingPath: 'targets',
      },
    ]);
    expect(
      validateWorkflow(
        mainWith(node('ev', 'core:encode-video', { codec: 'h264', encoder: 'aac' })),
        ctx(),
      ).map((i) => i.code),
    ).not.toContain('TARGET_UNSUPPORTED');
    const audio = validateWorkflow(
      mainWith(node('ea', 'core:encode-audio', { codec: 'ac3', targets: ['chrome'] })),
      ctx(),
    );
    expect(find(audio, 'TARGET_UNSUPPORTED')).toEqual([
      expect.objectContaining({ nodeId: 'ea', settingPath: 'targets' }),
    ]);
  });

  it('ENCODER_UNAVAILABLE when the named encoder is missing; auto with no hevc encoder; none with libx265 present; none at all while ffmpeg is unavailable', () => {
    const named = mainWith(node('ev', 'core:encode-video', { encoder: 'hevc_nvenc' }));
    expect(validateWorkflow(named, ctx())).toEqual([
      {
        severity: 'error',
        code: 'ENCODER_UNAVAILABLE',
        message: 'Encode video: encoder hevc_nvenc is not available',
        nodeId: 'ev',
        settingPath: 'encoder',
      },
    ]);
    const auto = mainWith(node('ev', 'core:encode-video', { encoder: 'auto' }));
    expect(validateWorkflow(auto, ctx({ capabilities: { ...caps, encoders: ['aac'] } }))).toEqual([
      {
        severity: 'error',
        code: 'ENCODER_UNAVAILABLE',
        message: 'Encode video: no hevc encoder is available',
        nodeId: 'ev',
        settingPath: 'encoder',
      },
    ]);
    expect(validateWorkflow(auto, ctx())).toEqual([]);
    expect(validateWorkflow(mainWith(node('ev', 'core:encode-video')), ctx())).toEqual([]);
    const off = ctx({ capabilities: { available: false, path: 'ffmpeg', error: 'ENOENT' } });
    expect(validateWorkflow(named, off)).toEqual([]);
    expect(validateWorkflow(auto, off)).toEqual([]);
  });

  it('move-copy is unavailable without output roots and its outputRoot must be configured', () => {
    const g = (outputRoot: string) =>
      chain(
        'workflow',
        node('in', 'core:input-manual'),
        node('mc', 'core:move-copy', { outputRoot }),
      );
    expect(validateWorkflow(g('/out'), ctx({ outputRoots: [] }))).toEqual([
      {
        severity: 'error',
        code: 'NODE_UNAVAILABLE',
        message: 'Move or copy is unavailable here: needs an output folder (server setting)',
        nodeId: 'mc',
      },
    ]);
    expect(validateWorkflow(g('/elsewhere'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([
      {
        severity: 'error',
        code: 'INVALID_SETTINGS',
        message: 'outputRoot must be one of the configured output roots',
        nodeId: 'mc',
        settingPath: 'outputRoot',
      },
    ]);
    expect(validateWorkflow(g('/media'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([]);
    // Compared resolved, as the pipeline does (final review M7): trailing slashes and `..` match.
    expect(validateWorkflow(g('/media/'), ctx({ outputRoots: ['/out', '/media'] }))).toEqual([]);
    expect(validateWorkflow(g('/media'), ctx({ outputRoots: ['/out/', '/media/'] }))).toEqual([]);
    expect(validateWorkflow(g('/out/x/..'), ctx({ outputRoots: ['/out'] }))).toEqual([]);
  });

  it('a bypassed node is not refused for its targets or a missing encoder (final review M5)', () => {
    const bypassed = (settings: { [key: string]: JsonValue }) =>
      mainWith(node('ev', 'core:encode-video', settings, { bypassed: true }));
    const codes = (settings: { [key: string]: JsonValue }) =>
      validateWorkflow(bypassed(settings), ctx()).map((i) => i.code);
    expect(codes({ codec: 'hevc', targets: ['chrome'] })).not.toContain('TARGET_UNSUPPORTED');
    expect(codes({ encoder: 'hevc_nvenc' })).not.toContain('ENCODER_UNAVAILABLE');
  });
});

describe('LIBRARY_MISSING', () => {
  const withLibrary = (libraryId: JsonValue): WorkflowGraph =>
    chain(
      'workflow',
      node('in', 'core:input-library', { libraryId }),
      node('ro', 'core:replace-original'),
    );
  const exists = (id: string) => id === 'lib1';

  it('warns once on a Library input naming no live library', () => {
    const issues = validateWorkflow(withLibrary('gone'), { ...ctx(), libraryExists: exists });
    expect(find(issues, 'LIBRARY_MISSING')).toEqual([
      {
        severity: 'warning',
        code: 'LIBRARY_MISSING',
        message: 'Library input: no library with this id',
        nodeId: 'in',
        settingPath: 'libraryId',
      },
    ]);
  });

  it('says nothing for a live library or without the lookup', () => {
    expect(
      find(
        validateWorkflow(withLibrary('lib1'), { ...ctx(), libraryExists: exists }),
        'LIBRARY_MISSING',
      ),
    ).toEqual([]);
    expect(find(validateWorkflow(withLibrary('gone'), ctx()), 'LIBRARY_MISSING')).toEqual([]);
  });

  it('leaves an empty id to INVALID_SETTINGS', () => {
    const issues = validateWorkflow(withLibrary(''), { ...ctx(), libraryExists: exists });
    expect(find(issues, 'LIBRARY_MISSING')).toEqual([]);
    expect(find(issues, 'INVALID_SETTINGS').map((i) => [i.severity, i.nodeId])).toEqual([
      ['error', 'in'],
    ]);
  });
});
