import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { type Codec, type CodecMedia, codecGroups, codecPresets } from '../../data/codecs.ts';

type Option =
  | { kind: 'codec'; key: string; group: string; codec: Codec }
  | { kind: 'custom'; key: string; id: string };

function matches(codec: Codec, q: string): boolean {
  if (q === '') return true;
  return [codec.id, codec.name, codec.note ?? ''].some((t) => t.toLowerCase().includes(q));
}

/**
 * The grouped codec picker (UI list #40), a dialog like the language picker: a search box that is
 * the combobox of one multi-select listbox, the codecs in labelled groups ("Efficient (target)",
 * "Common", …), each with its plain name and ffmpeg id. A click or Enter toggles a codec and the
 * picker stays open; arrows move the active option. A typed name the table does not have is
 * offered as `Add "…"` (a custom id). Above the list: the presets and "Add all" per group.
 */
export function CodecPicker({
  open,
  media,
  selected,
  onToggle,
  onAddMany,
  onClose,
}: {
  open: boolean;
  media: CodecMedia;
  selected: readonly string[];
  onToggle(id: string): void;
  onAddMany(ids: string[]): void;
  onClose(): void;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const groups = codecGroups(media);
  const presets = codecPresets(media);
  const q = query.trim().toLowerCase();

  const shown = useMemo(
    () =>
      groups
        .map((g) => ({ group: g, codecs: g.codecs.filter((c) => matches(c, q)) }))
        .filter((g) => g.codecs.length > 0),
    [groups, q],
  );
  const custom = query.trim();
  const offerCustom = custom !== '' && !groups.some((g) => g.codecs.some((c) => c.id === custom));
  const options: Option[] = [
    ...shown.flatMap(({ group, codecs }) =>
      codecs.map(
        (codec): Option => ({
          kind: 'codec',
          key: `${group.key}-${codec.id}`,
          group: group.key,
          codec,
        }),
      ),
    ),
    ...(offerCustom ? [{ kind: 'custom', key: 'custom', id: custom } as const] : []),
  ];
  const optionId = (o: Option) => `${baseId}-${o.key}`;
  const current = options[active];

  function search(text: string) {
    setQuery(text);
    setActive(-1);
  }

  function choose(o: Option) {
    if (o.kind === 'custom') {
      if (!selected.includes(o.id)) onToggle(o.id);
      search('');
      return;
    }
    onToggle(o.codec.id);
  }

  function close() {
    search('');
    onClose();
  }

  function addGroups(keys: string[]) {
    onAddMany(groups.filter((g) => keys.includes(g.key)).flatMap((g) => g.codecs.map((c) => c.id)));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    const last = options.length - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i >= last ? 0 : i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i <= 0 ? last : i - 1));
    } else if (e.key === 'Home' && options.length > 0) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End' && options.length > 0) {
      e.preventDefault();
      setActive(last);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = current ?? (q !== '' ? options[0] : undefined);
      if (pick) choose(pick);
    }
  }

  const isSelected = (o: Option) =>
    o.kind === 'codec' ? selected.includes(o.codec.id) : selected.includes(o.id);
  const optionProps = (o: Option) => ({
    id: optionId(o),
    role: 'option' as const,
    'aria-selected': isSelected(o),
    className: `codec-option${o === current ? ' is-active' : ''}`,
    // Keeps the focus in the search box (the combobox) while the pointer picks.
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
    onClick: () => choose(o),
  });

  return (
    <Dialog
      open={open}
      title="Add codecs"
      onClose={close}
      footer={
        <button type="button" className="btn btn-primary btn-sm" onClick={close}>
          Done
        </button>
      }
    >
      <div className="lang-picker codec-picker">
        <input
          type="text"
          role="combobox"
          className="input tc-input"
          aria-label="Search codecs"
          aria-controls={listId}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={current ? optionId(current) : undefined}
          placeholder="Name or ffmpeg id"
          value={query}
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => search(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="codec-quick">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="tc-toggle-chip"
              onClick={() => addGroups(p.groups)}
            >
              {p.label}
            </button>
          ))}
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              className="tc-toggle-chip"
              aria-label={`Add all: ${g.label}`}
              onClick={() => addGroups([g.key])}
            >
              All {g.label.replace(/ \(.*\)$/, '').toLowerCase()}
            </button>
          ))}
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Codecs"
          aria-multiselectable="true"
          className="lang-picker-list codec-list"
        >
          {shown.map(({ group, codecs }) => (
            // biome-ignore lint/a11y/useSemanticElements: a listbox's option group, not a form fieldset.
            <div key={group.key} role="group" aria-label={group.label} className="codec-group">
              <div className="codec-group-label" aria-hidden="true">
                {group.label}
              </div>
              {codecs.map((codec) => {
                const o = options.find((x) => x.key === `${group.key}-${codec.id}`) as Option;
                return (
                  <div key={o.key} {...optionProps(o)}>
                    <span className="codec-option-name">
                      <span>{codec.name}</span>
                      {codec.note && <span className="codec-option-note">{codec.note}</span>}
                    </span>
                    <span className="lang-code">{codec.id}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {options.at(-1)?.kind === 'custom' && (
            <div {...optionProps(options.at(-1) as Option)}>Add “{custom}”</div>
          )}
          {options.length === 0 && <p className="lang-picker-empty">No codec matches</p>}
        </div>
      </div>
    </Dialog>
  );
}
