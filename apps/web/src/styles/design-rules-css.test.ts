// The machine-checkable rules of DESIGN.md, held against styles.css through a CSS parser. Each
// failure names the rule and its DESIGN.md section; the documented exceptions are in
// ./design-exceptions.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CssRule,
  commaValues,
  declsOf,
  rulesOf,
  spaceValues,
  stylesCss,
  where,
} from './css-source';
import {
  CAPS_OK,
  CH_WIDTH_OK,
  CONTAINER_WIDTHS,
  KEYFRAME_PROPERTY_OK,
  LETTER_SPACING_OK,
  MEDIA_WIDTHS,
  SHADOW_OK,
  TRANSITION_PROPERTY_OK,
  UNGATED_HOVER,
  Z_LAYERS,
} from './design-exceptions';

/** The blocks that define the theme's colours: tokens and named variables live here. */
const THEME_BLOCKS = [
  ':root',
  ':root:not([data-theme="dark"])',
  ':root[data-theme="light"]',
  'body',
];

// CSS named colours (CSS Color 4), so `color: white` is caught like `color: #fff`.
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue
  darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
  darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise
  darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred
  indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta
  maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen`.split(/\s+/),
);

/** The colour literals in a value: hex, colour functions and named colours. */
function colourLiterals(value: string): string[] {
  const v = value.replace(/var\(--[\w-]+/g, 'var(').replace(/url\([^)]*\)/g, '');
  const out = [
    ...(v.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []),
    ...(v.match(/(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g) ?? []),
  ];
  for (const word of v.match(/(?<![\w-])[a-z]+(?![\w-(])/gi) ?? []) {
    if (NAMED_COLOURS.has(word.toLowerCase())) out.push(word);
  }
  return out;
}

function colourProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => !(d.prop.startsWith('--') && d.selectors.every((s) => THEME_BLOCKS.includes(s))))
    .filter((d) => d.selectors.length > 0 || d.prop.startsWith('--'))
    .filter((d) => colourLiterals(d.value).length > 0)
    .map(where);
}

/** A selector's last compound selector: `.a .b:hover > .c.is-on` is `.c.is-on`. */
function lastCompound(selector: string): string {
  return (
    selector
      .split(/\s+|>|\+|~/)
      .filter(Boolean)
      .at(-1) ?? selector
  );
}

function hoverProblems(source: string): string[] {
  const bad: string[] = [];
  for (const rule of rulesOf(source)) {
    const gated = rule.atRules.includes('@media (hover: hover)');
    for (const s of rule.selectors) {
      if (s.includes(':hover') && !gated && !(s in UNGATED_HOVER)) {
        bad.push(`${s} (styles.css:${rule.line})`);
      }
    }
  }
  return bad;
}

/** A selected, current or pressed state. */
const STATE =
  /\.is-(?:active|selected|current|on|checked|taken|now)\b|\.(?:selected|active)\b|\[aria-(?:selected|current|pressed|checked)|:checked/;

function weightOnStateProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.prop === 'font-weight' && d.selectors.some((s) => STATE.test(s)))
    .map(where);
}

const isFocus = (s: string) => /:focus(-visible|-within)?\b/.test(s);
const RING = /var\(--focus-ring(-on-accent)?\)/;
const OUTLINE_RING = /^2px solid var\(--accent-text\)$/;

function focusProblems(source: string): string[] {
  const rules = rulesOf(source);
  const ringOf = (r: CssRule) =>
    r.decls.some(
      (d) =>
        (d.prop === 'box-shadow' && RING.test(d.value)) ||
        (d.prop === 'outline' && OUTLINE_RING.test(d.value)),
    );
  const bad: string[] = [];
  for (const rule of rules) {
    const focus = rule.selectors.filter(isFocus);
    if (focus.length === 0) continue;
    for (const d of rule.decls) {
      // A focus style draws the ring token: --focus-ring, or --focus-ring-on-accent on lime.
      if (d.prop === 'box-shadow' && d.value !== 'none' && !RING.test(d.value)) bad.push(where(d));
      if (d.prop === 'outline' && !/^(none|0)$/.test(d.value) && !OUTLINE_RING.test(d.value)) {
        bad.push(where(d));
      }
    }
    // Taking the ring away (outline: none, box-shadow: none) needs a ring drawn instead: in the
    // same rule, or on a part of it (`sel .dot`, `sel > .card`), or on its holder (`:has(sel)`).
    const removes = rule.decls.some(
      (d) =>
        (d.prop === 'outline' && /^(none|0)$/.test(d.value)) ||
        (d.prop === 'box-shadow' && d.value === 'none'),
    );
    if (!removes || ringOf(rule)) continue;
    for (const s of focus) {
      const last = lastCompound(s);
      const held = rules.some(
        (r) =>
          ringOf(r) &&
          r.selectors.some(
            (x) => x !== s && (x.startsWith(`${s} `) || x.includes(`:has(${last})`)),
          ),
      );
      if (!held) bad.push(`${s} (styles.css:${rule.line})`);
    }
  }
  return bad;
}

const FLOATING = '0 8px 24px var(--toolbar-shadow)';
const ZERO_BLUR = /^(inset )?0 0 0 [\d.]+px \S.*$/;

function shadowProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.prop === 'box-shadow' && d.value !== 'none')
    .filter((d) => {
      const layersOk = commaValues(d.value).every(
        (layer) => RING.test(layer) || ZERO_BLUR.test(layer) || layer === FLOATING,
      );
      const listed = d.selectors.every((s) => SHADOW_OK[s]?.value === d.value);
      return !layersOk && !listed;
    })
    .map(where);
}

const ANIMATABLE = new Set(['transform', 'opacity', 'stroke-dashoffset', 'clip-path']);
const LAYOUT =
  /^(all|width|height|min-|max-|top|right|bottom|left|inset|margin|padding|gap|border-width|font-size|line-height|flex|grid)/;

function transitionPropertyProblems(source: string): string[] {
  const bad: string[] = [];
  for (const d of declsOf(source)) {
    if (d.prop !== 'transition' && d.prop !== 'transition-property') continue;
    if (d.value === 'none') continue;
    for (const layer of commaValues(d.value)) {
      const property = spaceValues(layer)[0] ?? '';
      const listed = d.selectors.every((s) => TRANSITION_PROPERTY_OK[s]?.property === property);
      const shorthandWithoutProperty = d.prop === 'transition' && !/^[a-z-]+$/.test(property);
      if (
        shorthandWithoutProperty ||
        LAYOUT.test(property) ||
        (!ANIMATABLE.has(property) && !listed)
      ) {
        bad.push(`${where(d)}: ${property || 'all'}`);
      }
    }
  }
  return bad;
}

function keyframeProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.atRules.some((a) => a.startsWith('@keyframes ')))
    .filter((d) => !ANIMATABLE.has(d.prop) && !(d.prop in KEYFRAME_PROPERTY_OK))
    .map(where);
}

const NO_PREFERENCE = '@media (prefers-reduced-motion: no-preference)';
const REDUCE = '@media (prefers-reduced-motion: reduce)';

function loopProblems(source: string): string[] {
  const decls = declsOf(source);
  const stilled = new Set(
    decls
      .filter((d) => d.prop === 'animation' && d.value === 'none' && d.atRules.includes(REDUCE))
      .flatMap((d) => d.selectors),
  );
  const bad: string[] = [];
  for (const d of decls) {
    if (!/^animation(-iteration-count)?$/.test(d.prop) || !/\binfinite\b/.test(d.value)) continue;
    if (!/\blinear\b/.test(d.value)) bad.push(`${where(d)}: a loop is linear`);
    const still = d.atRules.includes(NO_PREFERENCE) || d.selectors.every((s) => stilled.has(s));
    if (!still) bad.push(`${where(d)}: a loop needs a still state under reduced motion`);
  }
  return bad;
}

function letterSpacingProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.prop === 'letter-spacing' && /^-[\d.]+em$/.test(d.value))
    .filter((d) => Number.parseFloat(d.value) < -0.02)
    .filter((d) => !d.selectors.every((s) => s in LETTER_SPACING_OK))
    .map(where);
}

const MONO = (r: CssRule) =>
  r.decls.some(
    (d) =>
      (d.prop === 'font-family' && d.value === 'var(--font-mono)') ||
      (d.prop === 'font-size' && /^var\(--fs-(mono|micro)\)$/.test(d.value)),
  );

function capsProblems(source: string): string[] {
  const rules = rulesOf(source);
  // Simple selectors (one class, as `.badge-dry`) whose rule sets the mono font or a mono size.
  const monoClasses = new Set(
    rules.filter(MONO).flatMap((r) => r.selectors.filter((s) => /^\.[\w-]+$/.test(s))),
  );
  const bad: string[] = [];
  for (const rule of rules) {
    if (!rule.decls.some((d) => d.prop === 'text-transform' && d.value === 'uppercase')) continue;
    if (MONO(rule)) continue;
    for (const s of rule.selectors) {
      const classes = lastCompound(s).match(/\.[\w-]+/g) ?? [];
      if (classes.some((c) => monoClasses.has(c)) || s in CAPS_OK) continue;
      bad.push(`${s} (styles.css:${rule.line})`);
    }
  }
  return bad;
}

const WEIGHTS_UI = ['400', '500', '700', '800'];
const WEIGHTS_MONO = ['400', '600'];

function fontProblems(source: string): string[] {
  const bad: string[] = [];
  for (const rule of rulesOf(source)) {
    const family = rule.decls.find((d) => d.prop === 'font-family');
    for (const d of rule.decls) {
      if (d.prop === 'font-family' && !/^(var\(--font-(ui|mono)\)|inherit)$/.test(d.value)) {
        bad.push(`${where(d)}: use var(--font-ui) or var(--font-mono)`);
      }
      if (d.prop !== 'font-weight') continue;
      if (!/^([4-8]00|inherit|normal|var\(--fw-[\w-]+\))$/.test(d.value)) {
        bad.push(`${where(d)}: a bundled weight`);
      }
      // A weight the rule's own font does not ship would be synthesised or swapped.
      if (
        family?.value === 'var(--font-ui)' &&
        /^\d+$/.test(d.value) &&
        !WEIGHTS_UI.includes(d.value)
      ) {
        bad.push(`${where(d)}: Bricolage Grotesque ships ${WEIGHTS_UI.join('/')}`);
      }
      if (
        family?.value === 'var(--font-mono)' &&
        /^\d+$/.test(d.value) &&
        !WEIGHTS_MONO.includes(d.value)
      ) {
        bad.push(`${where(d)}: JetBrains Mono ships ${WEIGHTS_MONO.join('/')}`);
      }
    }
  }
  return bad;
}

function zIndexProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => d.prop === 'z-index' && !(d.value in Z_LAYERS))
    .map(where);
}

function chProblems(source: string): string[] {
  return declsOf(source)
    .filter((d) => /(^|-)width$/.test(d.prop) && /^[\d.]+ch$/.test(d.value) && d.value !== '70ch')
    .filter((d) => !d.selectors.every((s) => s in CH_WIDTH_OK))
    .map(where);
}

function breakpointProblems(source: string): string[] {
  const bad: string[] = [];
  const atRules = new Set(rulesOf(source).flatMap((r) => r.atRules));
  for (const at of atRules) {
    const widths = [...at.matchAll(/(?:min|max)-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    const container = /^@container ([\w-]+)/.exec(at)?.[1];
    for (const w of widths) {
      const ok = container
        ? (CONTAINER_WIDTHS[container] ?? []).includes(w)
        : at.startsWith('@media') && MEDIA_WIDTHS.includes(w);
      if (!ok) bad.push(at);
    }
  }
  return bad;
}

describe('DESIGN.md › Color', () => {
  it('has no colour literal in a rule: colours are tokens or named variables', () => {
    expect(
      colourProblems(stylesCss),
      'DESIGN.md › Color: no raw hex (or rgb(), named colour) in rules; use a token, or a named variable at the top of styles.css with its light value',
    ).toEqual([]);
  });

  it('catches hex, colour functions and named colours, not tokens or color-mix', () => {
    expect(colourLiterals('#000')).toEqual(['#000']);
    expect(colourLiterals('0 0 0 1px rgb(0 0 0 / 0.2)')).toEqual(['rgb(']);
    expect(colourLiterals('1px solid white')).toEqual(['white']);
    expect(colourLiterals('color-mix(in srgb, var(--kind-data) 22%, transparent)')).toEqual([]);
    expect(colourLiterals('var(--accent-text)')).toEqual([]);
    expect(colourLiterals('var(--line-strong) 1px solid')).toEqual([]);
    expect(colourProblems('.a { --x: #fff } :root { --y: #fff }')).toHaveLength(1);
    expect(colourProblems('@media (hover: hover) { .a:hover { background: red } }')).toHaveLength(
      1,
    );
  });
});

describe('DESIGN.md › Components and states', () => {
  it('gates every hover style behind @media (hover: hover)', () => {
    expect(
      hoverProblems(stylesCss),
      'DESIGN.md › Components and states: hover styles apply only under @media (hover: hover) (exceptions: UNGATED_HOVER)',
    ).toEqual([]);
    expect(hoverProblems('.a:hover { color: var(--text) }')).toHaveLength(1);
    expect(hoverProblems('@media (hover: hover) { .a:hover { color: var(--text) } }')).toEqual([]);
  });

  it('never changes the font weight of a selected, current or pressed item', () => {
    expect(
      weightOnStateProblems(stylesCss),
      'DESIGN.md › Typography: a selected or current item never changes weight; it changes fill, colour or icon',
    ).toEqual([]);
    expect(weightOnStateProblems('.chip[aria-pressed="true"] { font-weight: 700 }')).toHaveLength(
      1,
    );
    expect(weightOnStateProblems('.tab.is-active { font-weight: 600 }')).toHaveLength(1);
  });

  it('draws the focus ring token on focus, and never takes the ring away without one', () => {
    expect(
      focusProblems(stylesCss),
      'DESIGN.md › Components and states › Focus: :focus-visible gets --focus-ring (--focus-ring-on-accent on lime); never outline: none without it',
    ).toEqual([]);
    expect(focusProblems('.a:focus-visible { outline: none }')).toHaveLength(1);
    expect(
      focusProblems(
        '.a:focus-visible { outline: none } .a:focus-visible .dot { box-shadow: var(--focus-ring) }',
      ),
    ).toEqual([]);
    expect(
      focusProblems(
        '.a input:focus-visible { box-shadow: none } .a:has(input:focus-visible) { box-shadow: var(--focus-ring) }',
      ),
    ).toEqual([]);
    expect(focusProblems('.a:focus-visible { box-shadow: 0 0 0 3px var(--accent) }')).toHaveLength(
      1,
    );
  });
});

describe('DESIGN.md › Spacing, radius, shadow › Shadows', () => {
  it('uses box-shadow only for focus rings, zero-blur state rings and the floating-layer shadow', () => {
    expect(
      shadowProblems(stylesCss),
      'DESIGN.md › Shadows: focus rings, zero-blur rings, or 0 8px 24px var(--toolbar-shadow) on floating layers (exceptions: SHADOW_OK)',
    ).toEqual([]);
    expect(shadowProblems('.card { box-shadow: 0 2px 8px var(--toolbar-shadow) }')).toHaveLength(1);
    expect(shadowProblems('.menu { box-shadow: 0 8px 24px var(--toolbar-shadow) }')).toEqual([]);
    expect(shadowProblems('.chip { box-shadow: inset 0 0 0 1px var(--accent) }')).toEqual([]);
  });
});

describe('DESIGN.md › Motion', () => {
  it('transitions only transform, opacity, stroke-dashoffset and clip-path, never layout', () => {
    expect(
      transitionPropertyProblems(stylesCss),
      'DESIGN.md › Motion: only transform, opacity, stroke-dashoffset and clip-path animate; never layout properties (exceptions: TRANSITION_PROPERTY_OK)',
    ).toEqual([]);
    expect(
      transitionPropertyProblems('.a { transition: width var(--dur-fast) var(--ease-out) }'),
    ).toHaveLength(1);
    expect(
      transitionPropertyProblems('.a { transition: var(--dur-fast) var(--ease-out) }'),
    ).toHaveLength(1);
    expect(transitionPropertyProblems('.a { transition-property: all }')).toHaveLength(1);
  });

  it('animates only transform, opacity, stroke-dashoffset and clip-path in keyframes', () => {
    expect(
      keyframeProblems(stylesCss),
      'DESIGN.md › Motion: keyframes animate transform, opacity, stroke-dashoffset or clip-path (exceptions: KEYFRAME_PROPERTY_OK)',
    ).toEqual([]);
    expect(keyframeProblems('@keyframes grow { to { height: 10px } }')).toHaveLength(1);
  });

  it('runs every loop linear, with a still state under reduced motion', () => {
    expect(
      loopProblems(stylesCss),
      'DESIGN.md › Motion: loops are linear, and every loop has a still replacement under prefers-reduced-motion',
    ).toEqual([]);
    expect(loopProblems('.a { animation: spin 1s linear infinite }')).toHaveLength(1);
    expect(
      loopProblems(
        '.a { animation: spin 1s linear infinite } @media (prefers-reduced-motion: reduce) { .a { animation: none } }',
      ),
    ).toEqual([]);
    expect(
      loopProblems(
        '@media (prefers-reduced-motion: no-preference) { .a { animation: spin 1s ease infinite } }',
      ),
    ).toHaveLength(1);
  });

  it('keeps the loop timings DESIGN.md gives: spinner 0.8s, edge dash 0.6s, running border 1.6s', () => {
    const animation = (sel: string) =>
      declsOf(stylesCss).find((d) => d.prop === 'animation' && d.selectors.includes(sel))?.value;
    expect(animation('.loading-spinner')).toMatch(/ 0\.8s linear infinite$/);
    expect(animation('.tc-edge.edge-path')).toMatch(/ 0\.6s linear infinite$/);
    expect(animation('.tc-node.is-running::before')).toMatch(/ 1\.6s linear infinite$/);
  });
});

describe('DESIGN.md › Typography', () => {
  it('keeps headings no tighter than -0.02em, except the wordmark', () => {
    expect(
      letterSpacingProblems(stylesCss),
      'DESIGN.md › Typography: no tighter than -0.02em (exceptions: LETTER_SPACING_OK)',
    ).toEqual([]);
    expect(letterSpacingProblems('.h { letter-spacing: -0.03em }')).toHaveLength(1);
  });

  it('sets caps only on mono labels', () => {
    expect(
      capsProblems(stylesCss),
      'DESIGN.md › Typography: caps are for short mono labels only; set var(--font-mono) or a mono size (exceptions: CAPS_OK)',
    ).toEqual([]);
    expect(capsProblems('.x { text-transform: uppercase }')).toHaveLength(1);
    expect(
      capsProblems(
        '.x { font-family: var(--font-mono) } .y .x.is-on { text-transform: uppercase }',
      ),
    ).toEqual([]);
  });

  it('uses the two font tokens and only the weights that are bundled', () => {
    expect(
      fontProblems(stylesCss),
      'DESIGN.md › Typography: font-family is var(--font-ui) or var(--font-mono), at a bundled weight',
    ).toEqual([]);
    expect(fontProblems('.a { font-family: Arial }')).toHaveLength(1);
    expect(fontProblems('.a { font-family: var(--font-ui); font-weight: 600 }')).toHaveLength(1);
    expect(fontProblems('.a { font-weight: 900 }')).toHaveLength(1);
  });

  it('bundles the fonts: the weights DESIGN.md names, and nothing from a CDN', () => {
    const main = readFileSync(join(__dirname, '../main.tsx'), 'utf8');
    const imports = [...main.matchAll(/^import '@fontsource\/([\w-]+)\/(\d+)\.css';$/gm)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(imports.sort()).toEqual(
      [
        ...WEIGHTS_UI.map((w) => `bricolage-grotesque ${w}`),
        ...WEIGHTS_MONO.map((w) => `jetbrains-mono ${w}`),
      ].sort(),
    );
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8');
    expect(html, 'DESIGN.md › Context: fonts are bundled (no CDN)').not.toMatch(/https?:\/\//);
    expect(stylesCss).not.toMatch(/@import|url\(\s*['"]?https?:/);
  });
});

describe('DESIGN.md › Layout and composition', () => {
  it('stops help text at 70ch', () => {
    expect(
      chProblems(stylesCss),
      'DESIGN.md › Layout: help and description text stops at 70ch (exceptions: CH_WIDTH_OK)',
    ).toEqual([]);
    expect(chProblems('.hint { max-width: 60ch }')).toHaveLength(1);
  });

  it('uses only the named breakpoints and container widths', () => {
    expect(
      breakpointProblems(stylesCss),
      'DESIGN.md › Layout › Breakpoints: a media or container width not in MEDIA_WIDTHS / CONTAINER_WIDTHS',
    ).toEqual([]);
    expect(breakpointProblems('@media (min-width: 700px) { .a { color: red } }')).toHaveLength(1);
    expect(
      breakpointProblems('@container job-list (max-width: 900px) { .a { color: red } }'),
    ).toHaveLength(1);
    // No stale entries: every listed container width is used.
    for (const [name, widths] of Object.entries(CONTAINER_WIDTHS)) {
      for (const w of widths) expect(stylesCss).toContain(`@container ${name} (max-width: ${w}px)`);
    }
  });

  it('puts every z-index on a known layer, with the skip link and toasts on top', () => {
    expect(
      zIndexProblems(stylesCss),
      'z-index: a value outside the layers in styles/design-exceptions.ts Z_LAYERS',
    ).toEqual([]);
    const top = Math.max(...Object.keys(Z_LAYERS).map(Number));
    for (const sel of ['.skip-link', '.toasts']) {
      expect(
        declsOf(stylesCss).find((d) => d.prop === 'z-index' && d.selectors.includes(sel))?.value,
      ).toBe(String(top));
    }
    expect(zIndexProblems('.a { z-index: 9999 }')).toHaveLength(1);
  });
});
