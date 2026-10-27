// Stroke icons, copied from the design handoff screens where drawn (alert, chevron-down,
// chevron-up, trash, play, bypass); info, check-circle, x-circle, subworkflow, chevron-right,
// history, search, pencil and pause are not drawn there and follow the same 24-unit stroke style.
// Node icons (catalogue names: languages, star, ..., log-out, and the plugin nodes' download,
// refresh, user, bell, file-type) and the kind icons (kind-trigger is
// lucide play, kind-condition git-branch, kind-action wand, kind-finish flag, kind-data database)
// are lucide's (ISC licence) path data; plug-off is the handoff's plugin icon with a slash
// (screen 05's "plugin missing" badge). undo and redo are lucide's undo-2 and redo-2.
// The job state icons (state-running, state-queued, state-kept, state-noop, state-skipped) are
// screen 07's (the noop circle is dashed by its chip's CSS); menu is screen 08's. tidy (three cards
// in a row, the canvas's "Tidy up") follows the same stroke style.
// All are decorative (aria-hidden); the adjacent text carries the meaning.
const graph = (
  <>
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M8.5 12c4 0 4-6 7-6M8.5 12c4 0 4 6 7 6" />
  </>
);

const PATHS = {
  workflows: graph,
  jobs: <path d="M4 6h16M4 12h16M4 18h10" />,
  libraries: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  plugins: <path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  clock: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2M9 2h6" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  /** Screen 06b's "No change" badge. */
  minus: <path d="M6 12h12" />,
  /** Screen 06b's "After verification" badge. */
  shield: <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />,
  /** Screen 05's node toolbar "Bypass node". */
  bypass: <path d="M3 12h4M17 12h4M7 12c2-6 8-6 10 0" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7v.5" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  workflow: graph,
  subworkflow: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 12h9M13 9l3 3-3 3" />
    </>
  ),
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  /** Screen 05's "Collapse group". */
  'chevron-up': <path d="M6 15l6-6 6 6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" />,
  redo: <path d="M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13" />,
  history: <path d="M4 12a8 8 0 102.3-5.7M4 4v4h4M12 8v4l3 2" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  note: (
    <path d="M15 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10zM15 21v-6h6M7 8h10M7 12h6" />
  ),
  link: (
    <path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" />
  ),
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  play: <path d="M7 4l12 8-12 8z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  'state-running': <path d="M12 3a9 9 0 109 9" />,
  'state-queued': <path d="M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18" />,
  'state-kept': <path d="M9 14l-4-4 4-4M5 10h9a5 5 0 010 10h-2" />,
  /* A circle with a dash (nothing to do), never an open arc: that reads as a spinner. */
  'state-noop': <path d="M12 4a8 8 0 100 16 8 8 0 000-16M8.5 12h7" />,
  'state-skipped': <path d="M6 6l6 6-6 6M13 6l6 6-6 6" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  /** A folded map: the editor's minimap toggle. */
  tidy: <path d="M2 9h5v6H2zM9.5 9h5v6h-5zM17 9h5v6h-5zM7 12h2.5M14.5 12H17" />,
  map: <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14" />,
  /** The plugin glyph by its own name (the trace marks plugin steps with it). */
  plug: <path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4" />,
  'plug-zap': <path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4M12 9l-2 3h4l-2 3" />,
  'plug-off': <path d="M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4M3 3l18 18" />,
  languages: <path d="M5 8l6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />,
  star: (
    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
  ),
  'list-ordered': (
    <path d="M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-3.09-3.09a2 2 0 00-2.82 0L6 21" />
    </>
  ),
  video: (
    <>
      <path d="M16 13l5.22 3.48a.5.5 0 00.78-.42V7.87a.5.5 0 00-.75-.43L16 10.5" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  'volume-2': (
    <path d="M11 5L6 9H2v6h4l5 4zM15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" />
  ),
  captions: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
    </>
  ),
  package: (
    <path d="M7.5 4.27l9 5.15M21 8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.3 7l8.7 5 8.7-5M12 22V12" />
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4" />
    </>
  ),
  clapperboard: (
    <path d="M20.2 6L3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3zM6.2 5.3l3.1 3.9M12.4 3.4l3.1 4M3 11h18v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  ),
  'file-search': (
    <>
      <path d="M14 2v4a2 2 0 002 2h4M4.27 21a2 2 0 001.73 1H18a2 2 0 002-2V7l-5-5H6a2 2 0 00-2 2v3M9 18l-1.5-1.5" />
      <circle cx="5" cy="14" r="3" />
    </>
  ),
  'audio-lines': <path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" />,
  scale: (
    <path d="M16 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM2 16l3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1zM7 21h10M12 3v18M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
  ),
  replace: (
    <>
      <path d="M14 4a2 2 0 012-2M16 10a2 2 0 01-2-2M20 2a2 2 0 012 2M22 8a2 2 0 01-2 2M3 7l3 3 3-3M6 10V5a3 3 0 013-3h1" />
      <rect x="2" y="14" width="8" height="8" rx="2" />
    </>
  ),
  'folder-output': (
    <path d="M2 7.5V5a2 2 0 012-2h3.9a2 2 0 011.69.9l.81 1.2a2 2 0 001.67.9H20a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-1.5M2 13h10M5 10l-3 3 3 3" />
  ),
  send: <path d="M22 2l-7 20-4-9-9-4zM22 2L11 13" />,
  folder: (
    <path d="M20 20a2 2 0 002-2V8a2 2 0 00-2-2h-7.9a2 2 0 01-1.69-.9L9.6 3.9A2 2 0 007.93 3H4a2 2 0 00-2 2v13a2 2 0 002 2z" />
  ),
  webhook: (
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 012 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 116.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 010 8" />
  ),
  hand: (
    <path d="M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v2M10 10.5V6a2 2 0 00-4 0v8M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 012.83-2.82L7 15" />
  ),
  'log-in': <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" />,
  'log-out': <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />,
  /** Plugin node icons (Bazarr, Seerr, ntfy, Discord, ...); refresh is lucide's refresh-cw. */
  download: <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />,
  refresh: (
    <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16M8 16H3v5" />
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  bell: <path d="M6 8a6 6 0 0112 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 003.4 0" />,
  'file-type': (
    <path d="M15 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7zM14 2v4a2 2 0 002 2h4M9 13v-1h6v1M12 12v6M11 18h2" />
  ),
  'kind-trigger': <path d="M6 3l14 9-14 9z" />,
  'kind-condition': (
    <>
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 3v12M18 9a9 9 0 01-9 9" />
    </>
  ),
  'kind-action': (
    <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
  ),
  'kind-finish': <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />,
  'kind-data': (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0018 0V5M3 12a9 3 0 0018 0" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(PATHS, name);
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 2.2,
  round = false,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  /** Round line caps (the alert icons in the design use them; nav icons do not). */
  round?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap={round ? 'round' : undefined}
      aria-hidden="true"
      className="icon"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}
