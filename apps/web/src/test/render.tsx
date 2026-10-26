import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ToastProvider } from '../components/Toast.tsx';

/** Renders `ui` inside a wouter Router on an in-memory location starting at `path`. */
export function renderAt(
  path: string,
  ui: ReactNode,
): ReturnType<typeof render> & { navigate(to: string): void; location(): string } {
  const memory = memoryLocation({ path, record: true });
  const result = render(
    <Router hook={memory.hook} searchHook={memory.searchHook}>
      <ToastProvider>{ui}</ToastProvider>
    </Router>,
  );
  return {
    ...result,
    navigate(to: string) {
      act(() => memory.navigate(to));
    },
    location() {
      return memory.history.at(-1) ?? path;
    },
  };
}
