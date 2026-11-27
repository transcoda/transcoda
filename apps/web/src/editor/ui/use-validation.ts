import type { WorkflowGraph } from '@transcoda/shared';
import { useEffect, useRef } from 'react';
import { api, safe } from '../../api/client.ts';
import type { EditorAction } from '../model/editor-state.ts';

/** Builder's constant: validate this long after the last draft change. */
export const VALIDATE_DEBOUNCE_MS = 400;

/**
 * Live validation (server authority): `api.workflows.validate` 400 ms after the last draft change,
 * one request in flight at a time. An edit made while a request is out waits for it, then the
 * latest draft is sent. A response for a draft that has since changed is dropped (the next one is
 * on its way); a failed call leaves the issues as they were.
 */
export function useValidation({
  id,
  draft,
  enabled,
  dispatch,
}: {
  id: string;
  draft: WorkflowGraph;
  enabled: boolean;
  dispatch(a: EditorAction): void;
}): void {
  const latest = useRef({ id, draft, dispatch });
  latest.current = { id, draft, dispatch };
  const seen = useRef(draft);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wasEnabled = useRef(enabled);

  useEffect(() => {
    // Only an edit made while editing was already on is validated: the draft that arrives with
    // the load (or with editing being switched on) brought its issues along.
    const editing = wasEnabled.current && enabled;
    wasEnabled.current = enabled;
    if (draft === seen.current) return;
    seen.current = draft;
    if (!editing) return;

    async function run(): Promise<void> {
      if (inFlight.current) {
        queued.current = true;
        return;
      }
      inFlight.current = true;
      queued.current = false;
      const sent = latest.current.draft;
      const n = ++seq.current;
      latest.current.dispatch({ type: 'validating', seq: n });
      const [error, data] = await safe(
        api.workflows.validate({ graph: sent, id: latest.current.id }),
      );
      inFlight.current = false;
      if (!alive.current) return;
      if (error) latest.current.dispatch({ type: 'validateFailed', seq: n });
      else if (latest.current.draft === sent) {
        latest.current.dispatch({ type: 'validated', seq: n, issues: data.issues });
      }
      if (queued.current) void run();
    }

    const timer = setTimeout(() => void run(), VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, enabled]);
}
