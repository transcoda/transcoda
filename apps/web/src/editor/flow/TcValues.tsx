import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Icon } from '../../components/Icon.tsx';
import { valueText } from '../ui/SettingLink.tsx';
import { VALUES_HANDLE } from './toFlow.ts';
import type { TcValuesNode } from './types.ts';

const uses = (n: number) => (n === 0 ? 'unused' : `${n} ${n === 1 ? 'node' : 'nodes'}`);

/**
 * The values card: each shared value with its content and how many nodes follow it. It has no
 * ports; the dotted lines to the nodes start at its hidden bottom handle. Selected, the inspector
 * edits the values.
 */
export function TcValues({ data }: NodeProps<TcValuesNode>) {
  const { entries } = data.values;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card, not a form fieldset.
    <div role="group" aria-label="Shared values" className="tc-values" data-testid="tc-values">
      <div className="tc-values-head">
        <Icon name="link" size={14} strokeWidth={2.4} round />
        Shared values
      </div>
      {entries.length === 0 ? (
        <p className="tc-values-empty">
          None yet. Use the link button next to a node setting to share it.
        </p>
      ) : (
        <dl className="tc-values-list">
          {entries.map((v) => (
            <div key={v.name} className="tc-values-row">
              <dt>{v.name}</dt>
              <dd>
                <span className="tc-values-value">{valueText(v.value)}</span>
                <span className="tc-values-uses">{uses(data.uses[v.name] ?? 0)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        id={VALUES_HANDLE}
        className="tc-value-handle"
        isConnectable={false}
      />
    </div>
  );
}
