import { emptyGraph, type NodeInstance, type WorkflowGraph } from '@transcoda/shared';
import { describe, expect, it } from 'vitest';
import { type OpResult, removeSelection, setSettings } from './graph-ops.ts';
import {
  addNote,
  addValue,
  linkSetting,
  NOTE_SIZE,
  removeValue,
  removeValuesCard,
  renameValue,
  setGroupNote,
  setValue,
  shareSetting,
  uniqueValueName,
  unlinkSetting,
  VALUES_CARD_ID,
} from './notes-values.ts';

function graphOf(r: OpResult): WorkflowGraph {
  if (!r.ok) throw new Error(`refused: ${r.refusal.reason}`);
  return r.graph;
}

const reason = (r: OpResult) => (r.ok ? null : r.refusal.reason);

const LANGS = { type: 'array', items: { type: 'string', pattern: '^([a-z]{2,3}|unknown)$' } };

function node(id: string, settings: Record<string, unknown>, x = 0): NodeInstance {
  return {
    id,
    type: 'core:keep-languages',
    typeVersion: 1,
    settings: settings as NodeInstance['settings'],
    position: { x, y: 100 },
  };
}

function twoNodes(): WorkflowGraph {
  return {
    ...emptyGraph('workflow'),
    nodes: [node('a', { languages: ['en'] }, 0), node('b', { languages: ['fr'] }, 300)],
  };
}

const settingsOf = (g: WorkflowGraph, id: string) => g.nodes.find((n) => n.id === id)?.settings;
const linksOf = (g: WorkflowGraph, id: string) => g.nodes.find((n) => n.id === id)?.links;

describe('notes', () => {
  it('addNote makes an empty frame with a blank note at the position', () => {
    const g = graphOf(addNote(emptyGraph('workflow'), { x: 10, y: 20 }, 'n1'));
    expect(g.groups).toEqual([
      {
        id: 'n1',
        name: 'Note',
        collapsed: false,
        position: { x: 10, y: 20 },
        size: NOTE_SIZE,
        note: '',
      },
    ]);
  });

  it('setGroupNote stores the text; an empty note removes the key', () => {
    let g = graphOf(addNote(emptyGraph('workflow'), { x: 0, y: 0 }, 'n1'));
    g = graphOf(setGroupNote(g, 'n1', '**hi**'));
    expect(g.groups[0]?.note).toBe('**hi**');
    g = graphOf(setGroupNote(g, 'n1', ''));
    expect(g.groups[0] && 'note' in g.groups[0]).toBe(false);
  });

  it('setGroupNote refuses a missing group and a note over the limit', () => {
    expect(reason(setGroupNote(emptyGraph('workflow'), 'x', 'a'))).toBe(
      'That group no longer exists',
    );
    const g = graphOf(addNote(emptyGraph('workflow'), { x: 0, y: 0 }, 'n1'));
    expect(reason(setGroupNote(g, 'n1', 'a'.repeat(4001)))).toBe(
      'A note can be at most 4000 characters',
    );
  });
});

describe('shared values', () => {
  it('shareSetting makes a value from the setting, links it and places the card above the nodes', () => {
    const g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    expect(g.values).toEqual({
      position: { x: 0, y: -140 },
      entries: [{ name: 'Languages', schema: LANGS, value: ['en'] }],
    });
    expect(linksOf(g, 'a')).toEqual({ languages: 'Languages' });
  });

  it('linkSetting makes the setting take the value; setValue changes every linked setting', () => {
    let g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    g = graphOf(linkSetting(g, 'b', 'languages', 'Languages'));
    expect(settingsOf(g, 'b')).toEqual({ languages: ['en'] });
    g = graphOf(setValue(g, 'Languages', ['en', 'de']));
    expect(settingsOf(g, 'a')).toEqual({ languages: ['en', 'de'] });
    expect(settingsOf(g, 'b')).toEqual({ languages: ['en', 'de'] });
  });

  it('editing a linked setting anywhere (an on-card control) changes the value for every follower', () => {
    let g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    g = graphOf(linkSetting(g, 'b', 'languages', 'Languages'));
    g = graphOf(setSettings(g, 'a', { languages: ['de', 'en'] }));
    expect(g.values?.entries[0]?.value).toEqual(['de', 'en']);
    expect(settingsOf(g, 'b')).toEqual({ languages: ['de', 'en'] });
  });

  it('unlinkSetting keeps the current copy; later value changes no longer reach it', () => {
    let g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    g = graphOf(unlinkSetting(g, 'a', 'languages'));
    expect(linksOf(g, 'a')).toBeUndefined();
    g = graphOf(setValue(g, 'Languages', ['de']));
    expect(settingsOf(g, 'a')).toEqual({ languages: ['en'] });
  });

  it('renameValue renames the links; a taken or blank name is refused', () => {
    let g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    g = graphOf(addValue(g, 'Other', LANGS, ['fr']));
    expect(reason(renameValue(g, 'Languages', 'Other'))).toBe(
      'There is already a value called Other',
    );
    expect(reason(renameValue(g, 'Languages', '  '))).toBe('A value needs a name');
    g = graphOf(renameValue(g, 'Languages', 'Audio languages'));
    expect(linksOf(g, 'a')).toEqual({ languages: 'Audio languages' });
  });

  it('removeValue unlinks its settings and keeps their copies; removeValuesCard drops them all', () => {
    let g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    const removed = graphOf(removeValue(g, 'Languages'));
    expect(removed.values?.entries).toEqual([]);
    expect(linksOf(removed, 'a')).toBeUndefined();
    expect(settingsOf(removed, 'a')).toEqual({ languages: ['en'] });
    g = graphOf(removeValuesCard(g));
    expect(g.values).toBeUndefined();
    expect(linksOf(g, 'a')).toBeUndefined();
  });

  it('deleting the selected card removes it like removeValuesCard', () => {
    const g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    const out = graphOf(removeSelection(g, { nodes: [], edges: [], group: VALUES_CARD_ID }));
    expect(out.values).toBeUndefined();
    expect(linksOf(out, 'a')).toBeUndefined();
  });

  it('linkSetting refuses a value that does not exist', () => {
    expect(reason(linkSetting(twoNodes(), 'a', 'languages', 'Nope'))).toBe(
      'That value no longer exists',
    );
  });

  it('uniqueValueName adds a number when the name is taken', () => {
    const g = graphOf(shareSetting(twoNodes(), 'a', 'languages', 'Languages', LANGS));
    expect(uniqueValueName(g, 'Languages')).toBe('Languages 2');
    expect(uniqueValueName(g, 'Codec')).toBe('Codec');
  });
});
