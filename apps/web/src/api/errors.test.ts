import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { describeError } from './errors.ts';

describe('describeError', () => {
  it('maps a defined VERSION_CONFLICT to its code', () => {
    const err = new ORPCError('VERSION_CONFLICT', {
      defined: true,
      status: 409,
      message: 'The workflow was changed since you loaded it',
      data: { currentVersion: 4 },
    });
    expect(describeError(err)).toEqual({
      code: 'VERSION_CONFLICT',
      status: 409,
      message: 'The workflow was changed since you loaded it',
    });
  });

  it('maps an undefined 413 to PAYLOAD_TOO_LARGE with the 2 MB message', () => {
    const err = new ORPCError('PAYLOAD_TOO_LARGE', { status: 413, message: 'Payload Too Large' });
    expect(describeError(err)).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
      message: 'The workflow is too large to save (2 MB limit)',
    });
  });

  it('maps an undefined 400 to "The server rejected the request"', () => {
    const err = new ORPCError('BAD_REQUEST', { status: 400, message: 'Input validation failed' });
    expect(describeError(err)).toEqual({
      code: 'BAD_REQUEST',
      status: 400,
      message: 'The server rejected the request',
    });
  });

  it('maps a fetch TypeError to "Could not reach the server"', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      code: null,
      status: null,
      message: 'Could not reach the server',
    });
  });
});
