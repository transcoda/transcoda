import type { VerifyFailure } from './types.ts';

// Shared helpers for the verify tests.

export function checks(failures: VerifyFailure[]): string[] {
  return [...new Set(failures.map((f) => f.check))];
}
