// The DESIGN.md rules that live in the components rather than the stylesheet: colours come from
// tokens, and icons from components/Icon.tsx. Exceptions: styles/design-exceptions.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './components/Icon';
import { COLOUR_LITERAL_FILES_OK, SVG_FILES_OK } from './styles/design-exceptions';

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'test') yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield path;
  }
}
const files = [...sourceFiles(__dirname)].map((path) => ({
  file: relative(__dirname, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

function colourLiteralProblems(sources: { file: string; text: string }[]): string[] {
  const bad: string[] = [];
  for (const { file, text } of sources) {
    if (file in COLOUR_LITERAL_FILES_OK) continue;
    text.split('\n').forEach((line, i) => {
      if (COLOUR_LITERAL.test(line)) bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

const ICON_LIBRARIES =
  /^(lucide-react|react-icons|react-feather|@heroicons\/|@phosphor-icons\/|@tabler\/icons|@fortawesome\/|@mui\/icons-material|@radix-ui\/react-icons|@iconify\/)/;

describe('DESIGN.md › Color (components)', () => {
  it('has no colour literal in a component: inline styles and charts use var(--token)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(
      colourLiteralProblems(files),
      'DESIGN.md › Color: use a token (var(--…)), not a hex or rgb() literal (exceptions: COLOUR_LITERAL_FILES_OK)',
    ).toEqual([]);
    expect(
      colourLiteralProblems([{ file: 'x.tsx', text: "<i style={{ background: '#C6F35A' }} />" }]),
    ).toHaveLength(1);
    expect(
      colourLiteralProblems([{ file: 'x.tsx', text: "<i style={{ color: 'rgb(0 0 0)' }} />" }]),
    ).toHaveLength(1);
    expect(
      colourLiteralProblems([{ file: 'x.tsx', text: "<i style={{ color: 'var(--accent)' }} />" }]),
    ).toEqual([]);
  });
});

describe('DESIGN.md › Iconography', () => {
  it('takes icons from components/Icon.tsx, not an icon library', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(
      deps.filter((d) => ICON_LIBRARIES.test(d)),
      'DESIGN.md › Iconography: icons are components/Icon.tsx',
    ).toEqual([]);
    const imports = files.filter(({ text }) =>
      /from '(lucide-react|react-icons|@heroicons|@phosphor-icons|@tabler\/icons)/.test(text),
    );
    expect(imports.map((f) => f.file)).toEqual([]);
  });

  it('draws SVG only in the icon set and the listed drawings', () => {
    const drawing = files.filter(({ text }) => /<svg\b/.test(text)).map((f) => f.file);
    expect(
      drawing.filter((f) => !(f in SVG_FILES_OK)),
      'DESIGN.md › Iconography: use <Icon>, not an inline <svg> (exceptions: SVG_FILES_OK)',
    ).toEqual([]);
    // No stale entries.
    for (const f of Object.keys(SVG_FILES_OK)) expect(drawing, f).toContain(f);
  });

  it('draws icons on a 24-unit grid in currentColor, stroke 2.2, size 18, hidden from screen readers', () => {
    const { container } = render(<Icon name="play" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('stroke-width')).toBe('2.2');
    expect(svg?.getAttribute('width')).toBe('18');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('rounds every icon rect at rx 2', () => {
    const icon = files.find((f) => f.file === 'components/Icon.tsx')?.text ?? '';
    const rects = icon.match(/<rect\b[^>]*>/g) ?? [];
    expect(rects.length).toBeGreaterThan(0);
    expect(
      rects.filter((r) => !/\brx="2"/.test(r)),
      'DESIGN.md › Iconography: rect corners rx 2',
    ).toEqual([]);
  });
});
