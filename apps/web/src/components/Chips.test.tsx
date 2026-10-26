import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KIND_WORD, KindEyebrow, StatusChip } from './Chips.tsx';

afterEach(cleanup);

describe('Chips', () => {
  it('StatusChip carries its tone, icon, word and title', () => {
    render(
      <StatusChip tone="warning" icon="alert" title="Settings changed in core 1.3">
        Needs review
      </StatusChip>,
    );
    const chip = screen.getByText('Needs review');
    expect(chip.className).toContain('chip-warning');
    expect(chip.getAttribute('title')).toBe('Settings changed in core 1.3');
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('KindEyebrow names the kind and the source', () => {
    render(
      <>
        <KindEyebrow word={KIND_WORD.action} source={{ kind: 'core' }} />
        <KindEyebrow
          word={KIND_WORD.finish}
          source={{ kind: 'plugin', name: 'jellyfin', version: '1.2.0' }}
        />
        <KindEyebrow word={KIND_WORD.workflow} />
      </>,
    );
    expect([...document.querySelectorAll('.eyebrow-kind')].map((e) => e.textContent)).toEqual([
      'Action · core',
      'Finish · plugin jellyfin 1.2.0',
      'Workflow',
    ]);
    expect(screen.getByText('Workflow')).toBeTruthy();
    // Only the kind words are shown in capitals (by CSS); the plugin name keeps its case.
    expect([...document.querySelectorAll('.eyebrow-kind-word')].map((e) => e.textContent)).toEqual([
      'Action',
      'Finish',
      'plugin',
      'Workflow',
    ]);
    expect(KIND_WORD['subworkflow-io']).toBe('Sub-workflow');
  });
});
