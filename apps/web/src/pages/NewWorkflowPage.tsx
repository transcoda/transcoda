import type { WorkflowKind } from '@transcoda/shared';
import { type FormEvent, useId, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { api, safe } from '../api/client.ts';
import { RequiredMark } from '../components/Form.tsx';
import { Icon } from '../components/Icon.tsx';
import { usePageTitle } from '../lib/pageTitle.ts';

/** What the page promises under its title; a sub-workflow has no versions to activate. */
const SUBTITLE: Record<WorkflowKind, string> = {
  workflow: 'New workflows never touch files until you activate a version.',
  subworkflow: 'A sub-workflow is a reusable piece. It only runs when a workflow runs it.',
};

const KINDS: { kind: WorkflowKind; title: string; hint: string }[] = [
  { kind: 'workflow', title: 'Workflow', hint: 'runs on files from a trigger' },
  { kind: 'subworkflow', title: 'Sub-workflow', hint: 'a reusable piece run from a workflow' },
];

export function NewWorkflowPage() {
  usePageTitle('New workflow');
  const search = useSearch();
  const [, navigate] = useLocation();
  const initial: WorkflowKind =
    new URLSearchParams(search).get('kind') === 'subworkflow' ? 'subworkflow' : 'workflow';
  const [kind, setKind] = useState<WorkflowKind>(initial);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    const [err, out] = await safe(api.workflows.create({ name: trimmed, kind }));
    setPending(false);
    if (err || !out) {
      setError('Could not create the workflow, try again');
      return;
    }
    navigate(`/workflows/${out.id}`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{kind === 'subworkflow' ? 'New sub-workflow' : 'New workflow'}</h1>
        <p>{SUBTITLE[kind]}</p>
      </div>

      <form className="panel new-wf-form" onSubmit={onSubmit}>
        {error ? (
          <div className="alert alert-danger" role="alert">
            <Icon name="cross" strokeWidth={2.4} round />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor={`${id}-name`}>
            Name
            <RequiredMark />
          </label>
          <input
            id={`${id}-name`}
            className="input"
            value={name}
            maxLength={120}
            aria-required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset className="kind-choice">
          <legend>Kind</legend>
          {KINDS.map((k) => (
            <label key={k.kind} className="kind-option">
              <input
                type="radio"
                name={`${id}-kind`}
                value={k.kind}
                checked={kind === k.kind}
                onChange={() => setKind(k.kind)}
              />
              <span>
                <b>{k.title}</b> — {k.hint}
              </span>
            </label>
          ))}
        </fieldset>
        {/* Right-aligned, Cancel first and the primary last: the order every dialog footer uses.
            An empty name needs no helper line: the required Name field above says it. */}
        <div className="form-actions">
          <Link href="/workflows" className="btn btn-secondary">
            Cancel
          </Link>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={pending || name.trim() === ''}
          >
            Create and open
          </button>
        </div>
      </form>
    </div>
  );
}
