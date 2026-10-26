import type { BundledExample } from '../examples/bundled.ts';
import { Icon } from './Icon.tsx';

/** Screen 02's empty state, shown on the workflow list when there are no workflows at all. */
export function EmptyWorkflows({
  examples,
  onAddTrigger,
  onExample,
  busy,
}: {
  /** The examples a new user can start from (the core ones: no plugins needed). */
  examples: readonly BundledExample[];
  onAddTrigger(): void;
  onExample(example: BundledExample): void;
  busy: boolean;
}) {
  return (
    <section className="empty-workflows" aria-labelledby="empty-workflows-title">
      <div className="empty-chain" aria-hidden="true">
        <span className="empty-node kind-trigger" />
        <span className="empty-link" />
        <span className="empty-node kind-action" />
        <span className="empty-link" />
        <span className="empty-node kind-finish" />
      </div>
      <h2 id="empty-workflows-title">Start with where files come from</h2>
      <p>
        Add a trigger, then the actions you want in the single ffmpeg rewrite, then what happens
        after it is verified.
      </p>
      <div className="empty-actions" aria-busy={busy}>
        <button type="button" className="btn btn-primary" onClick={onAddTrigger} disabled={busy}>
          <Icon name="plus" size={16} strokeWidth={2.6} />
          Add a trigger
        </button>
      </div>
      <fieldset className="empty-examples">
        <legend>Or start from an example</legend>
        <div className="empty-example-list">
          {examples.map((ex) => (
            <button
              key={ex.name}
              type="button"
              className="empty-example"
              onClick={() => onExample(ex)}
              disabled={busy}
            >
              <strong>{ex.name}</strong>
              <span>{ex.summary}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <p className="empty-note">
        In the editor, press <kbd>/</kbd> to search nodes
      </p>
    </section>
  );
}
