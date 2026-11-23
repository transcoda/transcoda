// The stylesheets read through a real CSS parser (postcss), for the design guard tests in this
// folder. A parser sees what a regex misses: a last declaration without a semicolon, a rule
// nested in an at-rule, comments, values with nested parentheses. Test-only: nothing in the app
// imports this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AtRule, list, parse, type Root, type Rule } from 'postcss';

export const stylesCss = readFileSync(join(__dirname, '../styles.css'), 'utf8');
export const tokensCss = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

export interface Decl {
  prop: string;
  value: string;
  /** The selector list of the rule that holds it, one entry per selector; empty in an at-rule
   *  such as `@font-face`. */
  selectors: string[];
  /** The at-rules around it, outermost first, as `@media (hover: hover)`. */
  atRules: string[];
  line: number;
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
  return `${d.selectors.join(', ') || '(at-rule)'} { ${d.prop}: ${d.value} }${at} (styles.css:${d.line})`;
}
