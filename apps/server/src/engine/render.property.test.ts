// Property test (fast-check) for renderCommandLine: the stored command line, split the way a POSIX
// shell splits it, gives back the exact argv that ran.
import { fcRuns } from '@transcoda/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderCommandLine } from './render.ts';

const RUNS = fcRuns();

/**
 * Word splitting and quote removal as a POSIX shell does them, for what renderCommandLine writes:
 * unquoted words, single quotes and backslash escapes. Anything that would expand ($, `, *, ?,
 * [, ~, {, a backslash in a word) is refused, so a word that relies on the shell leaving it alone
 * fails the test instead of passing by luck.
 */
function shellSplit(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === ' ') {
      if (word !== null) words.push(word);
      word = null;
      i += 1;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated quote in ${line}`);
      word = (word ?? '') + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\') {
      const next = line[i + 1];
      if (next === undefined) throw new Error(`trailing backslash in ${line}`);
      word = (word ?? '') + next;
      i += 2;
    } else if (/[$`"*?[\]~{}()<>|&;#!\t\n]/.test(c)) {
      throw new Error(`unquoted ${JSON.stringify(c)} in ${line}`);
    } else {
      word = (word ?? '') + c;
      i += 1;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

// Shell-hostile characters weighted in, plus any text at all.
const arg = fc.oneof(
  fc.string({ unit: fc.constantFrom(...` '"\\$\`*?[]~{}()<>|&;#!\t\n=:,./@%-_aZ09é`) }),
  fc.string({ unit: 'grapheme' }),
  fc.string(),
);

describe('renderCommandLine (property)', () => {
  it('round-trips any argv through POSIX shell word splitting', () => {
    fc.assert(
      fc.property(fc.array(arg, { maxLength: 8 }), (args) => {
        const line = renderCommandLine('/usr/lib/jellyfin-ffmpeg/ffmpeg', args);
        expect(shellSplit(line)).toEqual(['/usr/lib/jellyfin-ffmpeg/ffmpeg', ...args]);
      }),
      RUNS,
    );
  });
});
