import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setServerTitle, usePageTitle } from './pageTitle.ts';

function Page({ title }: { title: string | null }) {
  usePageTitle(title);
  return null;
}

afterEach(() => {
  cleanup();
  setServerTitle(null);
});

describe('usePageTitle', () => {
  it('names the page, then the server, then Transcoda, and drops the page when it goes', () => {
    setServerTitle('Home');
    const { rerender, unmount } = render(<Page title="Jobs" />);
    expect(document.title).toBe('Jobs · Home · Transcoda');
    rerender(<Page title="h264-big.mkv" />);
    expect(document.title).toBe('h264-big.mkv · Home · Transcoda');
    unmount();
    expect(document.title).toBe('Home · Transcoda');
    setServerTitle(null);
    expect(document.title).toBe('Transcoda');
  });
});
