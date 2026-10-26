import { describe, expect, it } from 'vitest';
import { jobUrl } from './plugin-context.ts';

describe('jobUrl', () => {
  it('joins the public origin and the job page', () => {
    expect(jobUrl('https://t.example.net', 'j1')).toBe('https://t.example.net/jobs/j1');
  });

  it('is null without a public URL', () => {
    expect(jobUrl(null, 'j1')).toBeNull();
  });
});
