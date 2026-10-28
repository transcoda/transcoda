import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Highlight } from './Highlight.tsx';

const marks = (text: string, query: string) =>
  [...render(<Highlight text={text} query={query} />).container.querySelectorAll('mark')].map(
    (m) => m.textContent,
  );

describe('Highlight', () => {
  it('marks every occurrence, whatever the case', () => {
    expect(marks('Video and VIDEO', 'video')).toEqual(['Video', 'VIDEO']);
  });

  it('keeps the mark on the match after a character whose lowercase is longer', () => {
    expect(marks('İstanbul video', 'video')).toEqual(['video']);
  });

  it('treats the query as plain text', () => {
    expect(marks('a.b (c)', '(c)')).toEqual(['(c)']);
    expect(marks('abc', '.')).toEqual([]);
  });

  it('leaves the text alone for a blank query', () => {
    expect(marks('abc', '  ')).toEqual([]);
  });
});
