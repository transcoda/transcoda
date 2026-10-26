import { describe, expect, it } from 'vitest';
import { insertLibrary, updateLibrary } from '../db/repos/libraries.ts';
import { createTestDb } from '../db/test-db.ts';
import { closedLibraries, runHoursHold } from './run-hours.ts';

const T = new Date('2026-10-22T12:00:00Z'); // Thursday 12:00 UTC
const days = [[], [], [], [], [], [], []];

describe('closedLibraries', () => {
  it('lists the restricted libraries closed now with their next opening; never an unrestricted one', () => {
    const db = createTestDb();
    for (const id of ['free', 'night', 'open', 'never', 'off']) {
      insertLibrary(
        db,
        { id, name: id, path: `/${id}`, recycleFolder: null, processHardlinked: false },
        T,
      );
    }
    const rh = (every: number[], enabled = true) => ({ enabled, perDay: false, every, days });
    updateLibrary(db, 'night', { runHours: rh([22, 23, 0]) }, T);
    updateLibrary(db, 'open', { runHours: rh([12]) }, T);
    updateLibrary(db, 'never', { runHours: rh([]) }, T);
    updateLibrary(db, 'off', { runHours: rh([22], false) }, T);
    expect(closedLibraries(db, T, 'UTC')).toEqual(
      new Map([
        ['night', new Date('2026-10-22T22:00:00Z')],
        ['never', null],
      ]),
    );
  });
});

describe('runHoursHold', () => {
  const closed = new Map([['l1', new Date('2026-10-22T22:00:00Z')]]);
  const job = {
    automatic: true,
    libraryId: 'l1',
    state: 'queued' as const,
    paused: false,
    lane: null,
  };

  it('holds an automatic queued job, or a prepared one waiting for its lane', () => {
    const held = { opensAt: '2026-10-22T22:00:00.000Z', timeZone: 'UTC' };
    expect(runHoursHold(job, closed, 'UTC')).toEqual(held);
    expect(runHoursHold({ ...job, state: 'building', lane: 'encode' }, closed, 'UTC')).toEqual(
      held,
    );
  });

  it('never holds a manual, paused, running or open-library job', () => {
    expect(runHoursHold({ ...job, automatic: false }, closed, 'UTC')).toBeNull();
    expect(runHoursHold({ ...job, paused: true }, closed, 'UTC')).toBeNull();
    expect(runHoursHold({ ...job, state: 'encoding', lane: 'encode' }, closed, 'UTC')).toBeNull();
    expect(runHoursHold({ ...job, state: 'building' }, closed, 'UTC')).toBeNull();
    expect(runHoursHold({ ...job, libraryId: 'l2' }, closed, 'UTC')).toBeNull();
  });
});
