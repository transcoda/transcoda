// The stylesheets read through a real CSS parser (postcss), for the design guard tests in this
// folder. A parser sees what a regex misses: a last declaration without a semicolon, a rule
// nested in an at-rule, comments, values with nested parentheses. Test-only: nothing in the app
// imports this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AtRule, list, parse, type Root, type Rule } from 'postcss';

/** The stylesheet entry: a comment, then one `@import "./name.css";` per file, in cascade order. */
export const indexCss = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
export const tokensCss = readFileSync(join(__dirname, '..', 'tokens.css'), 'utf8');

/** The app's own stylesheets (every file index.css imports but the vendored tokens.css), in
 *  import order: the order the app's cascade sees them in. */
export const styleFiles: string[] = [...indexCss.matchAll(/@import\s+"\.\/([\w-]+\.css)";/g)]
  .map((m) => m[1] ?? '')
  .filter((f) => f !== 'tokens.css');

const parts = styleFiles.map((file) => ({
  file,
  text: readFileSync(join(__dirname, '..', file), 'utf8'),
}));

/** Every file of `styleFiles` joined in order, so a test reads the whole cascade as one source. A
 *  line number in it maps back to its file with `cssLine`. */
export const stylesCss = parts.map((p) => p.text).join('\n');

const starts: { file: string; first: number }[] = [];
{
  let first = 1;
  for (const p of parts) {
    starts.push({ file: p.file, first });
    first += p.text.split('\n').length;
  }
}

/** Where line `line` of `stylesCss` is, as `jobs.css:12`. */
export function cssLine(line: number): string {
  let at = starts[0];
  for (const s of starts) if (s.first <= line) at = s;
  return at ? `${at.file}:${line - at.first + 1}` : `styles:${line}`;
}

export interface Decl {
  prop: string;
  value: string;
  /** The selector list of the rule that holds it, one entry per selector; empty in an at-rule
   *  such as `@font-face`. */
  selectors: string[];
  /** The at-rules around it, outermost first, as `@media (hover: hover)`. */
  atRules: string[];
  line: number;
  /** Its place in the source, counted over every declaration: a later declaration wins a tie
   *  of specificity. */
  order: number;
}

export interface CssRule {
  selectors: string[];
  atRules: string[];
  decls: Decl[];
  line: number;
}

const cache = new Map<string, CssRule[]>();

/** Every rule of `source` (at any depth) with its declarations. Declarations that sit directly in
 *  an at-rule (`@font-face`) come as a rule with no selectors. */
export function rulesOf(source: string): CssRule[] {
  const hit = cache.get(source);
  if (hit) return hit;
  const out: CssRule[] = [];
  let order = 0;
  const visit = (container: Root | Rule | AtRule, atRules: string[]) => {
    const selectors =
      container.type === 'rule'
        ? container.selectors.map((s) => s.replace(/\s+/g, ' ').trim())
        : [];
    const here =
      container.type === 'atrule'
        ? [...atRules, `@${container.name} ${container.params}`]
        : atRules;
    const own: Decl[] = [];
    for (const node of container.nodes ?? []) {
      if (node.type === 'decl') {
        own.push({
          prop: node.prop.toLowerCase(),
          value: node.value.replace(/\s+/g, ' ').trim(),
          selectors,
          atRules: here,
          line: node.source?.start?.line ?? 0,
          order: order++,
        });
      } else if (node.type === 'rule' || node.type === 'atrule') visit(node, here);
    }
    if (own.length > 0) {
      out.push({ selectors, atRules: here, decls: own, line: container.source?.start?.line ?? 0 });
    }
  };
  visit(parse(source), []);
  cache.set(source, out);
  return out;
}

export function declsOf(source: string): Decl[] {
  return rulesOf(source).flatMap((r) => r.decls);
}

/** The declarations of every rule whose selector list holds `selector` as one entry, at any
 *  depth, each rule as `prop: value;` lines. A rule never reaches into the next one. */
export function rulesFor(source: string, selector: string): string[] {
  const want = selector.replace(/\s+/g, ' ').trim();
  return rulesOf(source)
    .filter((r) => r.selectors.includes(want))
    .map((r) => r.decls.map((d) => `${d.prop}: ${d.value};`).join('\n'));
}

/** A value split on top-level spaces and slashes, never inside parentheses:
 *  `calc(var(--r-lg) - 2px) 0 / 4px` is `calc(var(--r-lg) - 2px)`, `0`, `4px`. */
export function spaceValues(value: string): string[] {
  return list.split(value, [' ', '\n', '\t', '/'], false).filter(Boolean);
}

/** A value split on top-level commas (the layers of a transition or a shadow). */
export function commaValues(value: string): string[] {
  return list.comma(value);
}

/** Where a declaration is, for a failure message. */
export function where(d: Decl): string {
  const at = d.atRules.length > 0 ? ` in ${d.atRules.join(' ')}` : '';
  return `${d.selectors.join(', ') || '(at-rule)'} { ${d.prop}: ${d.value} }${at} (${cssLine(d.line)})`;
}
