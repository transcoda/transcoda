import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown.tsx';

const html = (text: string) => render(<Markdown text={text} />).container.innerHTML;

describe('Markdown', () => {
  it('renders headings, paragraphs and inline marks', () => {
    const out = html('## Start here\n\nChange **Languages** to *yours*, then `Save`.');
    expect(out).toContain('<h4>Start here</h4>');
    expect(out).toContain(
      '<p>Change <strong>Languages</strong> to <em>yours</em>, then <code>Save</code>.</p>',
    );
  });

  it('joins wrapped lines into one paragraph and splits on blank lines', () => {
    expect(html('one\ntwo\n\nthree')).toBe(
      '<div class="markdown"><p>one two</p><p>three</p></div>',
    );
  });

  it('renders bullet and numbered lists', () => {
    const out = html('- a\n- b\n\n1. first\n2. second');
    expect(out).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(out).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders http links that open in a new tab, and leaves other schemes as text', () => {
    const out = html('[docs](https://example.com/a) and [x](javascript:alert(1))');
    expect(out).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">docs</a>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).toContain('x');
  });

  it('never renders raw HTML', () => {
    const out = html('<img src=x onerror=alert(1)> **hi**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
