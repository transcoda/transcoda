import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react';
import { Icon } from '../../components/Icon.tsx';
import { Markdown } from '../../components/Markdown.tsx';
import type { GroupProblem } from '../model/group-state.ts';
import { useEditorActions } from './actions-context.ts';
import { BADGE_ICON } from './badges.ts';
import { GROUP_HANDLE } from './toFlow.ts';
import type { TcGroupNode } from './types.ts';

/** Smallest box the resizer allows (a group still has room for its header and one card's edge). */
export const GROUP_MIN_SIZE = { width: 240, height: 120 } as const;

const countWord = (n: number): string => `Group · ${n} ${n === 1 ? 'node' : 'nodes'}`;

/** A frame that only holds a note says so instead of "Group · 0 nodes". */
const kindWord = (n: number, note: string | undefined): string =>
  n === 0 && note !== undefined ? 'Note' : countWord(n);

/** The hidden members' badge, as the card's `Badge` draws it (same classes and glyphs). */
function ProblemBadge({ problem }: { problem: GroupProblem }) {
  const glyph = BADGE_ICON[problem.badge];
  return (
    <span className={`tc-badge tone-${problem.border}`}>
      {glyph === '!' ? (
        <span className="tc-badge-bang" aria-hidden="true">
          !
        </span>
      ) : (
        glyph && <Icon name={glyph} size={12} strokeWidth={2.6} round />
      )}
      {problem.word}
    </span>
  );
}

/**
 * N10: a named, dashed box behind its members (they are React Flow children via `parentId`).
 * Collapsed, it is a 210 x 60 tile (sized by `toFlow`) with one `'group'` handle each side that
 * stands in for the hidden members' ports, and their worst problem (badge, word, border) so a
 * broken node never vanishes behind a collapse. Resizing needs an editable canvas.
 */
export function TcGroup({ id, data, selected }: NodeProps<TcGroupNode>) {
  const { group, count } = data;
  const actions = useEditorActions();
  const collapsed = group.collapsed;
  // Expanded, the members show their own states.
  const problem = collapsed ? data.problem : null;
  // Also on read-only canvases, where the page keeps it as view-only state (withViewCollapse).
  const toggle = (
    <button
      type="button"
      className="tc-group-toggle nodrag nopan"
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        actions.setGroupCollapsed(id, !collapsed);
      }}
    >
      <span className="tc-group-toggle-chip">
        <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={12} strokeWidth={2.6} />
      </span>
    </button>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a canvas box around cards, not a form fieldset.
    <div
      role="group"
      aria-label={problem ? `Group ${group.name}, ${problem.word}` : `Group ${group.name}`}
      data-testid={`tc-group-${id}`}
      className={`tc-group${collapsed ? ' is-collapsed' : ''}${problem ? ` border-${problem.border}` : ''}`}
    >
      <NodeResizer
        isVisible={selected === true && !actions.readOnly && !collapsed}
        minWidth={GROUP_MIN_SIZE.width}
        minHeight={GROUP_MIN_SIZE.height}
        color="var(--accent-text)"
        handleClassName="tc-group-resize-handle"
      />
      <div className="tc-group-head">
        <span className="tc-group-name">{group.name}</span>
        <span className="tc-group-count">{kindWord(count, group.note)}</span>
      </div>
      {!collapsed && group.note ? (
        <div className="tc-group-note">
          <Markdown text={group.note} />
        </div>
      ) : null}
      {problem && <ProblemBadge problem={problem} />}
      {toggle}
      {/* Never faded while dragging: a collapsed tile is no drop target, as checkConnection rules. */}
      {collapsed && (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id={GROUP_HANDLE}
            className="tc-group-handle"
            isConnectable={false}
          />
          <Handle
            type="source"
            position={Position.Right}
            id={GROUP_HANDLE}
            className="tc-group-handle"
            isConnectable={false}
          />
        </>
      )}
    </div>
  );
}
