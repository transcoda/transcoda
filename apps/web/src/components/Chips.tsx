import type { NodeSource } from '@transcoda/contract';
import type { NodeKind } from '../hooks/useCatalog.ts';
import { Icon, type IconName } from './Icon.tsx';

// Colour never carries meaning alone: every badge and chip pairs an icon with a word.

export function StatusChip({
  tone,
  icon,
  children,
  title,
  srText,
  srId,
}: {
  tone: 'ok' | 'error' | 'warning';
  icon: IconName;
  children: string;
  title?: string;
  /** Text for screen readers only (what `title` shows on hover). */
  srText?: string;
  srId?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      <Icon name={icon} size={12} />
      {children}
      {srText ? (
        <span className="sr-only" id={srId}>
          {srText}
        </span>
      ) : null}
    </span>
  );
}

export const KIND_WORD: Record<NodeKind | 'workflow' | 'subworkflow', string> = {
  trigger: 'Trigger',
  condition: 'Condition',
  action: 'Action',
  finish: 'Finish',
  data: 'Data',
  'subworkflow-io': 'Sub-workflow',
  workflow: 'Workflow',
  subworkflow: 'Sub-workflow',
};

/**
 * "Action · core", "Finish · plugin jellyfin 1.2.0", or just the word ("Workflow"). Typed in
 * sentence case; `.eyebrow-kind-word` shows only the kind words in capitals, so a plugin name
 * and version keep their own case.
 */
export function KindEyebrow({ word, source }: { word: string; source?: NodeSource }) {
  return (
    <span className="eyebrow-kind">
      <span className="eyebrow-kind-word">{word}</span>
      {source?.kind === 'core' && ' · core'}
      {source?.kind === 'plugin' && (
        <>
          {' · '}
          <span className="eyebrow-kind-word">plugin</span>
          {` ${source.name} ${source.version}`}
        </>
      )}
    </span>
  );
}
