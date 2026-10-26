import type { NodeKind } from '../hooks/useCatalog.ts';
import { Icon, type IconName, isIconName } from './Icon.tsx';

const KIND_ICON: Record<NodeKind, IconName> = {
  trigger: 'kind-trigger',
  condition: 'kind-condition',
  action: 'kind-action',
  finish: 'kind-finish',
  data: 'kind-data',
  'subworkflow-io': 'workflow',
};

/** A catalogue node's lucide icon; a name this build does not draw falls back to its kind icon. */
export function NodeIcon({
  name,
  kind,
  size = 11,
}: {
  name: string;
  kind: NodeKind;
  size?: number;
}) {
  return (
    <Icon name={isIconName(name) ? name : KIND_ICON[kind]} size={size} strokeWidth={2.6} round />
  );
}
