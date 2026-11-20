# DESIGN.md - Transcoda web UI ("Patchbay")

This file explains the Transcoda web UI's design system: what it is for, the rules it follows and why. The values themselves live in `apps/web/src/styles/tokens.css`. That file is a byte-identical copy of the Patchbay handoff (see `docs/decisions.md`, "Task 24"). If this file and `tokens.css` disagree on a value, `tokens.css` is right and this file needs updating. Change a token in the handoff first, then copy it in.

## Context

- Artifact type: SaaS app / pro tool. Two halves: a node workflow editor (canvas) and a jobs dashboard (lists, tables, run traces). Self-hosted.
- Positioning: technical.
- Audience: people who run their own media server and are comfortable with Docker and file paths. Primary action: build a workflow, then see what it did to each file.
- Adjectives: precise, tactile, bold, calm.
- Visual word translations:
  - precise -> mono caps labels, a 4px spacing grid, typed edge strokes, exact numbers.
  - tactile -> node cards with ports and cables, 44px targets, a filled lime press surface.
  - bold -> one loud lime accent on near-black, heavy wordmark, 700-weight headings.
  - calm -> warm low-chroma neutrals, flat surfaces, motion only where something is actually happening.
- Aesthetic essence: wired, exact, bold.
- Single-minded proposition: you can see exactly what happens to every file.
- References: hardware patchbays and modular synth panels (cables between labelled jacks). Avoid: generic SaaS admin templates (indigo, rounded cards, soft shadows).
- Mode: dark by default, light supported (follows the OS, or `data-theme`). Density: balanced on pages, dense in the editor and tables.
- Constraints: React + Vite, plain CSS (`styles.css` plus `tokens.css`), no CSS framework. Fonts are bundled (no CDN). WCAG 2.2 AA.

## Aesthetic

- Direction: "Patchbay", bespoke, from the Claude Design handoff.
- Defining trait: everything is a jack or a cable. Nodes are labelled modules, edges are cables whose line style says what flows through them, and colour is reserved for meaning (kinds, verdicts), always paired with an icon and a word.
- Signature move: the typed edges. Five line languages between node cards:

  | Edge | Stroke |
  |---|---|
  | path taken | 3.5px lime, dash 10 6, animated |
  | file flow | 3px solid, muted |
  | data | 2px dotted yellow, round caps |
  | not taken | 2px, dash 6 6 |
  | into a broken node | 2.5px red, dash 6 5 |

  The running node's turning conic lime border belongs to the same move.

## Typography

- UI and display: Bricolage Grotesque, 400/500/700/800, `@fontsource/bricolage-grotesque`, OFL-1.1.
- Mono: JetBrains Mono, 400/600, `@fontsource/jetbrains-mono`, OFL-1.1. Used for caps micro labels, paths, codecs, sizes and durations.
- Scale: a deliberately tight scale for a dense tool. The steps are roughly 1.15 in the UI and open up to 1.4 to 1.57 for headings.

  | Token | Size | Weight / tracking | Use |
  |---|---|---|---|
  | `--fs-display` | 44px | 700, -0.03em | auth hero |
  | (page title) | 32px | 700, -0.01em | page titles |
  | `--fs-h1` | 28px | 700, -0.01em | section titles |
  | `--fs-h2` | 20px | 700 | panel titles |
  | `--fs-body` | 15px | 400, line-height 1.5 | text |
  | `--fs-small` | 13px | 500 | meta |
  | `--fs-mono` | 12px | 600, caps | labels |

- Wordmark: 800 weight, -0.04em, lowercase "transcoda".
- Rules:
  - Interactive text is at least 14px.
  - Nothing is below 11px.
  - Headings are no tighter than -0.02em, except the wordmark.
  - Caps are for short mono labels only.

## Color

- Strategy: one loud lime on warm near-black. Lime (hue about 124) stays well away from the indigo/violet band that AI UIs default to, and reads like an indicator LED. The neutrals have very low chroma: slightly cool in dark, warm in light. Every other hue is semantic: node kinds and job verdicts.
- Distribution: roughly 85 neutral / 10 semantic / 5 lime. Lime marks the primary action, the path taken, the current item and the focus ring.
- Light mode keeps lime as the fill (with dark ink) and moves lime text and lines to a deep green that passes AA.

| Role | Token | Dark | Light |
|---|---|---|---|
| bg | `--bg` | oklch(20.3% 0.008 297) #17161A | oklch(97.0% 0.007 97) #F6F5F0 |
| surface | `--surface` | oklch(23.0% 0.010 295) #1D1C21 | #FFFFFF |
| raised | `--raised` | oklch(26.8% 0.011 293) #26252B | oklch(93.7% 0.010 94) #ECEAE3 |
| border | `--line` | oklch(30.1% 0.013 292) #2E2D34 | oklch(87.6% 0.014 93) #D9D6CC |
| border strong | `--line-strong` | oklch(34.8% 0.012 292) #3A3940 | oklch(81.4% 0.017 92) #C6C2B6 |
| fg | `--text` | oklch(94.0% 0.007 89) #EDEBE6 | #17161A |
| muted | `--muted` | oklch(76.1% 0.013 87) #B5B1A8 | oklch(43.9% 0.012 88) #55524B |
| faint | `--faint` | oklch(68.0% 0.014 87) #9C988F | oklch(48.3% 0.012 82) #625E57 |
| accent (fill) | `--accent` | oklch(90.4% 0.184 124) #C6F35A | same |
| accent-fg | `--on-accent` | #17161A | same |
| accent text/line | `--accent-text` | #C6F35A | oklch(47.4% 0.132 132) #3E6A00 |
| error | `--st-failed` | oklch(70.9% 0.184 29) #FF6B5A | same fill, text #8F1D10 |
| warning / dry run | `--st-dry` | oklch(85.6% 0.126 76) #FFC46B | oklch(49.4% 0.109 67) #8A5300 |
| success / replaced | `--st-replaced` | lime | lime fill, text #3E6A00 |

Node kinds (always with an icon and a label):

| Kind | Dark | Light |
|---|---|---|
| trigger | #5AA9FF (oklch 72% 0.148 252) | #1B5DB8 |
| condition | #B79BFF (oklch 75% 0.143 296) | #6A44C8 |
| action | #FF9F5A (oklch 79% 0.142 55) | #A84A0C |
| finish | #3FD9B5 (oklch 80% 0.137 173) | #08705A |
| data | #F2D04B (oklch 86% 0.151 94) | #7E6000 |

Verdicts (`--st-*`) have a fill, an `-ink` for text on that fill and, where needed, a `-text` for text on the page. Filled chips mean an outcome (replaced, failed). Outlined neutral chips mean nothing changed.

Colours that are not tokens are named variables at the top of `styles.css`, with their light values next to them. No raw hex in rules.

## Spacing, radius, shadow

- Spacing: 4px base. `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-6` 24, `--sp-8` 32, `--sp-12` 48. Tight inside a group (4 to 8), generous between sections (24 to 48).
- Radius: `--r-sm` 6px for chips in dense rows, small controls and node ports; `--r-md` 12px for inputs, buttons, cards and node cards; `--r-lg` 16px for large panels only; `--r-pill` for tags, filter chips and dots. Nothing above 16px except pills.
- Shadows: defined edges, not elevation. Cards and rows are a 1px or 1.5px border plus a lightness step (bg < surface < raised). Box-shadow is used for:
  - focus rings
  - zero-blur state rings
  - floating layers only (menus, tips, panels, sheets): `0 8px 24px var(--toolbar-shadow)`

## Layout and composition

- The editor is three columns: palette, canvas, inspector. The default widths are 240 / flexible / 340, and 200 / flexible / 280 between 1024 and 1279px. In the editor the side nav collapses to a 56px icon rail.
- Pages are a side nav plus a sticky top bar (`--topbar-h` 69px), with content in a single column of lists and tables. There are no card grids except the jobs overview stat tiles, and those are filters.
- Signature layout move: the canvas is the page. Run traces reuse the editor's canvas, with the path taken lit and everything else dimmed, so "what happened" is drawn on the same diagram as "what should happen".
- Breakpoints:
  - Phone: up to 639px.
  - Auth layout splits at 900px.
  - Editor compact below 1024px, with the inspector as a sheet.
  - Container queries on the job list (1143px, 993px) and the jobs overview (699px, 559px).

## Components and states

- Buttons (`.btn`, 44px tall):
  - `.btn-primary`: lime fill with dark ink, one per view.
  - `.btn-secondary`, `.btn-ghost`.
  - `.btn-danger` and `.btn-danger-outline`: destructive actions only.
  - `.btn-ink` and `.btn-ink-outline`: on lime surfaces.
  - Sizes `.btn-sm` (drawn smaller, with a 44px hit area from `::before`) and `.btn-lg`.
- Inputs: 48px tall, `--raised` background, label above (14px/500), errors through `aria-invalid` plus a message tied with `aria-describedby`. Placeholders are hints, never labels.
- Tables: text left, numbers right in tabular figures, light row separators.
- Overlays: `Dialog` traps and returns focus. Menus and tips are floating layers with the one shadow.
- Empty states:
  - Workflows: the three-dot kind chain, one sentence and one primary button.
  - Lists: one muted line that says what will appear there.
- Loading: `Loading` with `role="status"`, a spinner and a word. Working jobs get a turning arc. Planned jobs get a still hourglass.
- Errors: `.alert-danger` and `.alert-warning` blocks, toasts in a polite region plus an alert region.
- Focus: `:focus-visible` gets `--focus-ring` (2px bg gap, 2px `--accent-text`), and `--focus-ring-on-accent` on lime. Never `outline: none` without it.
- Node cards:
  - Header: kind eyebrow, icon and title.
  - Ports: 26px hit area.
  - States:
    - selected: 2.5px lime outline at 3px offset
    - dry run: dashed border
    - bypassed: hatch, plus a label
    - off path: faded
    - running: conic border plus a progress fill

## Motion

- Durations: 120 to 150ms for hover and toggles. 400ms to 600ms linear for progress fills. Loops are linear: spinner 0.8s, edge dash 0.6s, running border 1.6s.
- Easing: ease-out for anything entering (target token `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`). Linear only for progress and loops.
- Only transform, opacity, stroke-dashoffset and clip-path animate. Never layout properties.
- Motion means something is happening: a job running, a path taken. Nothing pulses or loops at rest. The live dot is static.
- Reduced motion: every loop has a still replacement (a solid accent border for the running node, a static dash for edges).

## Iconography

- `components/Icon.tsx`: inline SVG on a 24 unit grid, `currentColor` stroke 2.2 (2.6 on the primary add), default size 18 (16 in buttons), rect corners rx 2.
- Source: lucide path data (ISC) plus icons drawn in the handoff, all re-stroked to 2.2.
- Kind icons: play (trigger), git-branch (condition), wand (action), flag (finish), database (data).
- Icons are `aria-hidden`; meaning sits in the adjacent text or the button's accessible name.

## Imagery

- Real product material only: episode and movie posters from the user's own library next to jobs, and the before/after frame viewer. No illustration, stock or decorative art.
- The canvas dot grid is functional (it supports placing nodes). It is not texture.

## Dark mode

- Dark is the designed default:
  - Near-black `--bg` (L 20%) and off-white `--text` (L 94%).
  - Elevation by lightness steps: 20.3%, 23.0%, 26.8%.
  - Borders lighter than the surface.
- Light is designed separately, not inverted. The page and raised colours are warm off-whites, and kinds, verdict text and accent text each have darker siblings that pass AA.

## Accessibility

- Contrast:
  - Text, muted, faint, accent text, kind and verdict colours all pass AA on bg, surface and raised in both themes. The lowest pairs are faint on raised in dark (5.28) and kind-action on raised in light (4.78).
  - Input edges do not yet reach 3:1 (see the audit).
- There is a skip link, keyboard focus on every control, and 44px targets (`--target-min`).
  - Exception: the React Flow zoom controls are 40px.
- Kinds and verdicts never rely on colour alone.
- Forms use real labels, `aria-invalid` and `role="alert"`.

## Cards and surfaces

- A surface has a border or a lightness step, not a shadow. No cards inside cards. Padding at least 12px inside any bordered container (chips excepted).

## Slop audit

- Date: 2026-11-20. Result: 7.5 / 10 (source audit; checks that need a rendered page not run yet).
- Clean: no indigo or violet accent, no gradient text, no glassmorphism, no bounce easing, no decorative glows or haze, no pulsing dots, no stock or AI imagery, no card-grid boilerplate. The signature move is clear.
- Open fixes, most important first:
  1. **Input edges below 3:1.** `.input` uses a 1.5px `--line-strong` border, which is about 1.5:1 in dark and 1.8:1 in light. Give control edges their own token that reaches 3:1, for example #6A6770 in dark and #8A867E in light.
  2. **Type floor and scale drift.** About 60 `font-size` declarations are at 10 or 11px, and about two thirds of all sizes are raw px instead of `--fs-*`. Raise 10px to at least 11px, and caps labels to `--fs-mono`. Add tokens for 11, 14 and 16 to 18px, and map the odd sizes (22, 26, 30, 34, 40, 64) onto the scale.
  3. **Bold on selected.** About 11 selected or active rules change `font-weight`, for example segmented controls, listbox options, filter chips, settings nav and the versions row. This shifts the layout. Mark selection with fill, colour or an icon instead.
  4. **Tabular figures.** Only a couple of rules set `tabular-nums`. Apply it to numeric cells in the job, library, step, plan and before/after tables, and right-align those columns.
  5. **Reduced motion and easing.** `tokens.css` zeroes every animation with `!important`. Replace that with a duration clamp in the handoff, or keep every keyframe behind `prefers-reduced-motion: no-preference`. Add the `--ease-out` token in place of the default `ease`, and add an `:active` press state on buttons.
  6. Replace the side-tab `inset 3px 0 0` on the current versions row with a fill or a check. Drop the glow (`drop-shadow(0 0 3px)`) on the selected edge.
  7. Collapse the off-token radii (2, 3, 4, 5, 8, 9, 10, 14px) onto `--r-sm` and `--r-md`.
  8. Gate hover styles behind `@media (hover: hover)`.
  9. `.btn-danger-outline` text from 13px to 14px.
- Not yet checked (needs a rendered page):
  - layout defects
  - focus hidden under the sticky bar
  - nested cards
  - heading order
  - measure
  - an axe pass on icon-only buttons

## Changelog

- 2026-11-20: first version. Documents the existing Patchbay system (no visual changes) and records the first slop and accessibility audit.
