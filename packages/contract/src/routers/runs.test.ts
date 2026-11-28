import { describe, expect, it } from 'vitest';
import { RunDetailSchema, RunSchema } from '../index.ts';

describe('runs router', () => {
  it('RunSchema carries note and RunDetail files carry workflowVersion', () => {
    expect('note' in RunSchema.shape).toBe(true);
    const files = RunDetailSchema.shape.files.element.shape;
    expect('workflowVersion' in files).toBe(true);
  });
});
