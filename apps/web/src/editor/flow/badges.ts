import type { IconName } from '../../components/Icon.tsx';
import type { NodeBadge } from '../model/issues.ts';

/** The badge glyph per state; amber states show "!" as drawn in screen 05. */
export const BADGE_ICON: Record<Exclude<NodeBadge, null>, IconName | '!' | null> = {
  'plugin-missing': 'plug-off',
  'plugin-stopped': 'plug-zap',
  'unknown-node': 'plug-off',
  unavailable: 'lock',
  'needs-setting': '!',
  'check-settings': '!',
  'needs-connection': '!',
  // Icon.tsx has no unlink glyph: "!" on the dashed (grey) tone, the word says which.
  unreachable: '!',
  'subworkflow-problem': 'workflow',
  'not-allowed': 'alert',
  'outdated-pin': null,
  'generic-error': 'alert',
  'generic-warning': '!',
};
