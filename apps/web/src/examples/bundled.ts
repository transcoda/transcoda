// The example workflows the repository ships (examples/workflows/*.json, described in its README),
// offered in the Workflows page's "Examples" menu; the core ones also on the empty list.
import type { WorkflowGraph } from '@transcoda/shared';
import keepMyLanguages from '../../../../examples/workflows/keep-my-languages.json';
import keepMyLanguagesPlugins from '../../../../examples/workflows/keep-my-languages-plugins.json';
import playEverywhere from '../../../../examples/workflows/play-everywhere.json';
import saveSpace from '../../../../examples/workflows/save-space.json';

export interface BundledExample {
  name: string;
  graph: WorkflowGraph;
  /** One line on what it does, for the empty list. */
  summary: string;
  /** What it needs beyond the core nodes ("needs the Sonarr, Jellyfin and ntfy plugins"). */
  needs: string | null;
}

export const BUNDLED_EXAMPLES: readonly BundledExample[] = [
  {
    name: 'Save space',
    graph: saveSpace as WorkflowGraph,
    summary: 'Re-encodes video to HEVC and keeps it only when it is at least 15% smaller.',
    needs: null,
  },
  {
    name: 'Play everywhere',
    graph: playEverywhere as WorkflowGraph,
    summary: 'Re-encodes only the files your devices cannot play.',
    needs: null,
  },
  {
    name: 'Keep my languages',
    graph: keepMyLanguages as WorkflowGraph,
    summary: 'Drops audio and subtitles in languages you do not watch. No re-encoding.',
    needs: null,
  },
  {
    name: 'Keep my languages with plugins',
    graph: keepMyLanguagesPlugins as WorkflowGraph,
    summary: 'Keep my languages, plus Sonarr, Jellyfin and ntfy.',
    needs: 'needs the Sonarr, Jellyfin and ntfy plugins',
  },
];
