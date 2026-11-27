// Every documented exception to the design rules in DESIGN.md, in one place, each with its reason.
// The guard tests in this folder (and src/design-source.test.tsx) read these lists; a value or a
// selector that is not here fails its test. Add an entry only with a reason a reviewer can check.

/** DESIGN.md › Typography: every font-size is a --fs-* token. */
export const FONT_SIZE_OK: Record<string, string> = {
  '64px': 'the auth hero tagline, a display glyph size of its own',
  '40px': 'the auth hero tagline on a phone',
  '0.92em': '.markdown code, sized from its surrounding text',
};

/** DESIGN.md › Spacing: every padding, margin and gap is a --sp-* token. */
export const SPACING_OK: Record<string, string> = {
  '1px': 'hairline offsets: chip padding, a 1px row gap',
  '-1px': 'a margin that cancels a 1px border',
  '-4px': 'a negative margin paired with a --sp-1 padding (.text-target)',
  '-8px': 'a negative margin paired with a --sp-2 padding',
  '28px': 'a 4px-grid step tokens.css has no name for',
  '44px': 'a 4px-grid step tokens.css has no name for (the target size)',
  '52px': 'a 4px-grid step tokens.css has no name for',
  '56px': 'a 4px-grid step tokens.css has no name for (the rail width)',
  '60px': 'a 4px-grid step tokens.css has no name for',
  '64px': 'a 4px-grid step tokens.css has no name for',
  '76px': 'a 4px-grid step tokens.css has no name for',
};

/** DESIGN.md › Radius: every radius is an --r-* token. */
export const RADIUS_OK: Record<string, string> = {
  '2px': 'tiny marks: swatches, port handles, the search highlight, key dots',
  '50%': 'circles (dots, avatars, round handles)',
  '0': 'a square corner of a joined shape',
  inherit: 'follows its parent',
};

/** DESIGN.md › Motion: progress fills are linear; every other transition uses the motion tokens.
 *  These selectors are the progress fills, the only rules whose transition may be linear. */
export const LINEAR_PROGRESS: Record<string, string> = {
  '.activity-ring-value': 'the activity ring fills as jobs progress',
  '.tc-node .tc-node-fill': "the running node's progress fill",
};

/** DESIGN.md › Motion: only transform, opacity, stroke-dashoffset and clip-path animate. A rule
 *  here may also transition the listed property; none of them is a layout property. */
export const TRANSITION_PROPERTY_OK: Record<string, { property: string; reason: string }> = {
  '.empty-example': {
    property: 'background-color',
    reason: 'the example row fades its hover fill in; paint only',
  },
  '.scope-chip': {
    property: 'background-color',
    reason: 'the token scope row fades its hover fill in; paint only',
  },
};

/** Keyframe properties beyond transform, opacity, stroke-dashoffset and clip-path. */
export const KEYFRAME_PROPERTY_OK: Record<string, string> = {
  '--tc-run-angle':
    "the running node's conic border turns by this registered angle; it repaints, no layout",
};

/** DESIGN.md › Components and states: hover styles apply only under `@media (hover: hover)`.
 *  These undo a hover or reveal on focus as well, so they stay ungated (docs/decisions/2026-11.md,
 *  "2026-11-20 Design audit fixes"). */
export const UNGATED_HOVER: Record<string, string> = {
  '.canvas .react-flow__controls-button:disabled:hover':
    "undoes React Flow's hover on a disabled control",
  'a.btn:hover': 'undoes the link underline on a link styled as a button',
  '.info-tip:hover .info-tip-text': 'the info tip reveal, which focus also opens',
};

/** DESIGN.md › Shadows: focus rings, zero-blur state rings, and the one floating-layer shadow
 *  `0 8px 24px var(--toolbar-shadow)`. Other shadows, by selector. */
export const SHADOW_OK: Record<string, { value: string; reason: string }> = {
  '.tc-toolbar': {
    value: '0 6px 18px var(--toolbar-shadow)',
    reason:
      "the node toolbar is a small floating layer on the canvas; it keeps the handoff's smaller shadow",
  },
  '.info-tip-text': {
    value: '0 6px 18px var(--toolbar-shadow)',
    reason: "a tip is a small floating layer; it keeps the handoff's smaller shadow",
  },
  '.inspector-col.is-sheet': {
    value: '0 -8px 24px var(--toolbar-shadow)',
    reason: 'the bottom sheet is the floating-layer shadow cast upwards, since it rises from below',
  },
};

/** DESIGN.md › Typography: headings are no tighter than -0.02em, except the wordmark. */
export const LETTER_SPACING_OK: Record<string, string> = {
  '.wordmark': 'the wordmark is -0.04em',
  '.auth-tagline': 'the auth hero tagline, a display glyph (as for its font-size)',
  '.plan-percent': 'the dry-run plan percentage, a 32px display figure',
};

/** DESIGN.md › Typography: caps are for short mono labels only. An uppercase rule sets the mono
 *  font or a mono label size (--fs-mono, --fs-micro), or its element does in a simpler rule;
 *  these labels get the mono font another way. */
export const CAPS_OK: Record<string, string> = {
  '.eyebrow-kind-word': 'sits inside .eyebrow-kind, which sets the mono font',
  '.job-table .badge-dry': 'the element is also .badge, which sets the mono font',
  '.job-steps-head .badge-dry': 'the element is also .badge, which sets the mono font',
  // Known departures from the rule, kept so the check does not change the design:
  '.inspector-eyebrow.is-caps':
    'KNOWN: the group and values inspectors\' "Group" / "Note" / "Card" eyebrow is sans caps',
  '.plan-tile-now': 'KNOWN: "Now" in a dry-run plan tile is sans caps inside the 20px figure',
};

/** DESIGN.md has no z-index scale; these are the layers the stylesheet uses, lowest first. A new
 *  value needs a place in this order. */
export const Z_LAYERS: Record<string, string> = {
  '-1': "the running node's conic border, under its card",
  '1': "local lift inside a component (a row's own controls, a badge, a progress fill)",
  '2': 'local lift above that (running node handles and badges, the selection bar)',
  '5': 'the canvas key',
  '6': 'the canvas banners',
  '10': 'menus and tips',
  '15': 'the sticky side nav and the inspector sheet',
  '20': 'the sticky top bar, the versions panel, the chart tip',
  '30': 'the activity panel',
  '100': 'the skip link and toasts, always on top',
};

/** DESIGN.md › Layout: help and description text stops at 70ch. Other ch widths. */
export const CH_WIDTH_OK: Record<string, string> = {
  '.server-name': 'a server name truncates at 24ch; it is a name, not help text',
};

/** DESIGN.md › Layout and composition › Breakpoints: the only widths media and container
 *  queries use. */
export const MEDIA_WIDTHS = [639, 899, 900, 1023, 1024, 1280];
export const CONTAINER_WIDTHS: Record<string, number[]> = {
  'job-list': [1159, 1009],
  'jobs-overview': [699, 559],
};

/** DESIGN.md › Color: colours are tokens or named variables, not literals in components. */
export const COLOUR_LITERAL_FILES_OK: Record<string, string> = {
  'components/Logo.tsx': 'the brand mark keeps its ink and lime in every theme',
};

/** DESIGN.md › Iconography: icons come from components/Icon.tsx. These files draw other SVG. */
export const SVG_FILES_OK: Record<string, string> = {
  'components/Icon.tsx': 'the icon set',
  'components/Logo.tsx': 'the brand mark',
  'components/ActivityButton.tsx': 'the activity progress ring',
  'components/LoadStrip.tsx': 'a chart',
  'components/WeekBars.tsx': 'a chart',
  'editor/ui/CanvasLegend.tsx': 'edge line samples in the canvas key',
};
