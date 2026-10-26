import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAt } from '../test/render.tsx';
import { GuardedLink, guardedRun, type NavTarget, setBeforeNavigate } from './navigation.tsx';

afterEach(cleanup);

function withGuard(answer: boolean): { asked: NavTarget[]; release(): void } {
  const asked: NavTarget[] = [];
  const release = setBeforeNavigate((target) => {
    asked.push(target);
    return answer;
  });
  return { asked, release };
}

describe('GuardedLink', () => {
  it('a plain click asks the guard; a refusal keeps the route', () => {
    const guard = withGuard(false);
    try {
      const view = renderAt('/here', <GuardedLink href="/there">There</GuardedLink>);
      fireEvent.click(screen.getByRole('link', { name: 'There' }));
      expect(guard.asked).toEqual([{ to: '/there' }]);
      expect(view.location()).toBe('/here');
    } finally {
      guard.release();
    }
  });

  it('a modified or non-primary click is not navigation: the guard is not asked and nothing is held', () => {
    const guard = withGuard(false);
    try {
      const view = renderAt('/here', <GuardedLink href="/there">There</GuardedLink>);
      const link = screen.getByRole('link', { name: 'There' });
      for (const init of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        // Not cancelled: the browser opens the new tab or window itself.
        expect(fireEvent.click(link, init)).toBe(true);
      }
      expect(guard.asked).toEqual([]);
      expect(view.location()).toBe('/here');
    } finally {
      guard.release();
    }
  });
});

describe('guardedRun', () => {
  it('runs at once without a guard or when the guard lets it go, and hands it over when held', () => {
    const run = vi.fn();
    guardedRun(run);
    expect(run).toHaveBeenCalledTimes(1);

    const open = withGuard(true);
    guardedRun(run);
    open.release();
    expect(run).toHaveBeenCalledTimes(2);

    const held = withGuard(false);
    guardedRun(run);
    held.release();
    expect(run).toHaveBeenCalledTimes(2);
    expect(held.asked).toEqual([{ run }]);
  });
});
