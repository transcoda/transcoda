import type { Issue, WorkflowGraph } from '@transcoda/shared';
import { Icon } from '../../components/Icon.tsx';
import type { Catalog } from '../../hooks/useCatalog.ts';
import { countIssues } from '../model/issues.ts';
import { fieldsFor } from '../model/schema-fields.ts';

export type IssueTarget = { nodeId?: string; edgeId?: string; settingPath?: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 errors · 2 warnings", "1 error", "No issues". */
export function issuesSummary(issues: Issue[]): string {
  const { errors, warnings } = countIssues(issues);
  const parts = [
    errors > 0 ? plural(errors, 'error') : null,
    warnings > 0 ? plural(warnings, 'warning') : null,
  ].filter((p) => p !== null);
  return parts.length > 0 ? parts.join(' · ') : 'No issues';
}

/** What an issue is about: the node's name, "Removed node" (deleted since the last validate), "Edge" or "Workflow". */
export function subjectOf(issue: Issue, graph: WorkflowGraph, catalog: Catalog | null): string {
  if (issue.nodeId !== undefined) {
    const node = graph.nodes.find((n) => n.id === issue.nodeId);
    if (!node) return 'Removed node';
    return node.label ?? catalog?.byType.get(node.type)?.title ?? node.type;
  }
  return issue.edgeId !== undefined ? 'Edge' : 'Workflow';
}

/**
 * The message under its node's name: the server often starts a node's message with the node's
 * title ("Keep languages: …"), which the entry already shows, so a leading "<title>: " goes (the
 * label or the catalogue title, whichever the server used).
 */
export function messageUnder(issue: Issue, graph: WorkflowGraph, catalog: Catalog | null): string {
  if (issue.nodeId === undefined) return issue.message;
  const node = graph.nodes.find((n) => n.id === issue.nodeId);
  if (!node) return issue.message;
  const def = catalog?.byType.get(node.type);
  const names = [node.label, def?.title, node.type];
  let message = issue.message;
  for (const name of names) {
    if (name && message.startsWith(`${name}: `)) {
      message = message.slice(name.length + 2);
      break;
    }
  }
  return withSettingName(message, issue.settingPath, def?.settingsSchema);
}

/**
 * A settings issue names its setting ("Sub-workflow: Needs a setting"), so two issues of one node
 * never read the same. The label is the inspector's (top-level key of the path); a message that
 * already starts with it is left alone.
 */
function withSettingName(
  message: string,
  settingPath: string | undefined,
  schema: Parameters<typeof fieldsFor>[0] | undefined,
): string {
  if (settingPath === undefined || schema === undefined) return message;
  const key = settingPath.split(/[./[]/)[0];
  const label = fieldsFor(schema).find((f) => f.key === key)?.label;
  if (!label || message.startsWith(label)) return message;
  return `${label}: ${message}`;
}

function targetOf(issue: Issue): IssueTarget {
  const target: IssueTarget = {};
  if (issue.nodeId !== undefined) target.nodeId = issue.nodeId;
  if (issue.edgeId !== undefined) target.edgeId = issue.edgeId;
  if (issue.settingPath !== undefined) target.settingPath = issue.settingPath;
  return target;
}

/**
 * The issues list at the bottom of the inspector column (all of it while nothing is selected), or
 * a muted "No issues": errors first, then warnings, each an
 * icon + word, the node title (or "Edge" / "Workflow") and the server's message. An entry is a
 * button that asks the page to select and centre its node or edge (and focus the setting).
 */
export function IssuesPanel({
  issues,
  catalog,
  graph,
  onFocus,
}: {
  issues: Issue[];
  catalog: Catalog | null;
  graph: WorkflowGraph;
  onFocus(target: IssueTarget): void;
}) {
  if (issues.length === 0) return <p className="issues-none">{issuesSummary(issues)}</p>;
  const ordered = [
    ...issues.filter((i) => i.severity === 'error'),
    ...issues.filter((i) => i.severity !== 'error'),
  ];
  return (
    <details className="issues-panel" open>
      <summary className="issues-summary">{issuesSummary(issues)}</summary>
      <ul className="issues-list">
        {ordered.map((issue, i) => {
          const error = issue.severity === 'error';
          return (
            // Issues have no id; the server's order is stable for one response.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above.
            <li key={i}>
              <button
                type="button"
                className={`issues-entry ${error ? 'is-error' : 'is-warning'}`}
                onClick={() => onFocus(targetOf(issue))}
              >
                <Icon name={error ? 'x-circle' : 'alert'} size={15} round />
                <span className="sr-only">{error ? 'Error' : 'Warning'}</span>
                <span className="issues-entry-subject">{subjectOf(issue, graph, catalog)}</span>
                <span className="issues-entry-message">{messageUnder(issue, graph, catalog)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
