import { type Group, MAX_NOTE_LENGTH } from '@transcoda/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_GROUP_NAME, MAX_LABEL_LENGTH } from '../model/graph-ops.ts';
import type { FieldDef } from '../model/schema-fields.ts';
import { BooleanField } from './fields/BooleanField.tsx';

const COLLAPSED_FIELD: FieldDef = {
  key: 'collapsed',
  label: 'Collapsed',
  hint: 'Shows the group as one tile',
  unit: null,
  required: true,
  default: undefined,
  spec: { kind: 'boolean' },
  schema: null,
};

const plural = (n: number) => `${n} node${n === 1 ? '' : 's'}`;

/**
 * The inspector for a selected group (N10): its name, "N nodes", the Markdown note, the Collapsed
 * switch and Ungroup (the members stay). A frame with a note and no nodes is a Note: Ungroup
 * deletes it. `focusName` focuses and selects the name once (a new group).
 */
export function GroupInspector({
  group,
  count,
  readOnly,
  onRename,
  onCollapse,
  onUngroup,
  onNote,
  focusName = false,
  onFocused,
}: {
  group: Group;
  count: number;
  readOnly: boolean;
  onRename(name: string): void;
  onCollapse(collapsed: boolean): void;
  onUngroup(): void;
  onNote(note: string): void;
  focusName?: boolean;
  onFocused?(): void;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // The typed text; a blank name is never sent (renameGroup refuses it), the field keeps it until
  // left. A name changed from outside (undo) replaces it.
  const [text, setText] = useState(group.name);
  const [seen, setSeen] = useState(group.name);
  if (seen !== group.name) {
    setSeen(group.name);
    setText(group.name);
  }

  useEffect(() => {
    if (!focusName) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    onFocused?.();
  }, [focusName, onFocused]);

  const isNote = count === 0 && group.note !== undefined;

  return (
    <section className="inspector" aria-labelledby={`${id}-title`}>
      <header className="inspector-head">
        <div className="inspector-eyebrow is-caps">{isNote ? 'Note' : 'Group'}</div>
        <h2 id={`${id}-title`} className="inspector-title">
          {group.name}
        </h2>
        {!isNote && <p className="inspector-description">{plural(count)}</p>}
      </header>
      <div className="inspector-body">
        <div className="tc-field">
          <div className="tc-field-head">
            <label htmlFor={`${id}-name`} className="tc-field-label">
              Group name
            </label>
          </div>
          <input
            ref={nameRef}
            id={`${id}-name`}
            className="input tc-input"
            value={text}
            maxLength={MAX_LABEL_LENGTH}
            readOnly={readOnly}
            onChange={(e) => {
              const name = e.target.value;
              setText(name);
              if (name.trim() !== '') onRename(name);
            }}
            onBlur={() => {
              if (readOnly || text.trim() !== '') return;
              setText(DEFAULT_GROUP_NAME);
              if (group.name !== DEFAULT_GROUP_NAME) onRename(DEFAULT_GROUP_NAME);
            }}
          />
        </div>
        <div className="tc-field">
          <div className="tc-field-head">
            <label htmlFor={`${id}-note`} className="tc-field-label">
              Note
            </label>
          </div>
          <span id={`${id}-note-hint`} className="tc-field-hint">
            Shown in the frame. Markdown: **bold**, *italic*, `code`, - lists, [links](https://…)
          </span>
          <textarea
            id={`${id}-note`}
            className="input tc-input tc-note-input"
            rows={8}
            value={group.note ?? ''}
            maxLength={MAX_NOTE_LENGTH}
            readOnly={readOnly}
            aria-describedby={`${id}-note-hint`}
            onChange={(e) => onNote(e.target.value)}
          />
        </div>
        <BooleanField
          def={COLLAPSED_FIELD}
          value={group.collapsed}
          issue={null}
          readOnly={readOnly}
          onChange={(v) => onCollapse(v === true)}
        />
      </div>
      <footer className="inspector-footer">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={readOnly}
          onClick={onUngroup}
        >
          {isNote ? 'Delete note' : 'Ungroup'}
        </button>
      </footer>
    </section>
  );
}
