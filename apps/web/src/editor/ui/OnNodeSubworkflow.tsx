import type { WorkflowSummary } from '@transcoda/contract';
import type { NodeInstance } from '@transcoda/shared';
import type { ZoomLevel } from '../flow/useZoomLevel.ts';
import type { NodeState } from '../model/issues.ts';
import { readRunSettings } from './RunSubworkflowInspector.tsx';

const SEP = ' · ';
export const MISSING_SUBWORKFLOW = 'missing sub-workflow';

/** What a Run sub-workflow card says about its pin; null without a picked sub-workflow. */
export type RunSummary = { text: string; missing: boolean };

/**
 * "Language cleanup · v2": the pinned sub-workflow's name (from the page's one `workflows.list`)
 * and version. A sub-workflow the list does not have (deleted), or one the server reports
 * missing, reads "missing sub-workflow". Without the list only the version: "Sub-workflow · v2".
 */
export function runSummary(
  instance: NodeInstance,
  state: NodeState,
  workflows: WorkflowSummary[] | undefined,
): RunSummary | null {
  const { subworkflowId, version } = readRunSettings(instance.settings);
  if (subworkflowId === undefined) return null;
  const reported = state.issues.some((i) => i.code === 'SUBWORKFLOW_MISSING');
  const found = workflows?.find((w) => w.id === subworkflowId);
  if (reported || (workflows !== undefined && !found)) {
    return { text: MISSING_SUBWORKFLOW, missing: true };
  }
  const name = found?.name ?? 'Sub-workflow';
  return { text: version === undefined ? name : `${name}${SEP}v${version}`, missing: false };
}

/**
 * N12 for the Run sub-workflow card: its read-only summary. At zoom `full` a button that focuses
 * the inspector's sub-workflow picker; below that the summary text; at `icon` nothing. `plain`
 * (the job trace) is text at every zoom: there is no inspector to open.
 */
export function OnNodeSubworkflow({
  summary,
  zoom,
  plain = false,
  onFocus,
}: {
  summary: RunSummary;
  zoom: ZoomLevel;
  plain?: boolean;
  onFocus(key: string): void;
}) {
  if (zoom === 'icon') return null;
  if (zoom !== 'full' || plain) {
    return (
      <div className={summary.missing ? 'tc-node-summary is-missing' : 'tc-node-summary'}>
        {summary.text}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`tc-onnode tc-onnode-summary nodrag nopan${summary.missing ? ' is-missing' : ''}`}
      aria-label={`Sub-workflow: ${summary.text}. Edit in the inspector`}
      title="Edit in the inspector"
      onClick={() => onFocus('subworkflowId')}
    >
      <span className="tc-onnode-text">{summary.text}</span>
    </button>
  );
}
