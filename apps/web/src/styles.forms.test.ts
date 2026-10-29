import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('dialogs (H7, L1)', () => {
  it('an open dialog is a flex column capped to the viewport, so only the body scrolls', () => {
    const open = rule('.dialog[open]');
    expect(open).toMatch(/display:\s*flex/);
    expect(open).toMatch(/flex-direction:\s*column/);
    expect(open).toMatch(/max-height:\s*calc\(100dvh/);
    expect(open).toMatch(/overflow:\s*hidden/);
    // `display` on the bare class would show a closed dialog.
    expect(rule('.dialog')).not.toMatch(/display:/);
  });

  it('the body scrolls and the title and footer stay pinned', () => {
    const body = rule('.dialog-body');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/flex:\s*1 1 auto/);
    expect(rule('.dialog-title')).toMatch(/flex:\s*none/);
    expect(rule('.dialog-footer')).toMatch(/flex:\s*none/);
  });

  it('the close button is a full-size target and lives in the dialog section', () => {
    const close = rule('.dialog-close');
    expect(close).toMatch(/width:\s*var\(--target-min\)/);
    expect(close).toMatch(/height:\s*var\(--target-min\)/);
    expect(css.indexOf('.dialog-close {')).toBeLessThan(
      css.indexOf('/* ---------- Plugins (screen 09)'),
    );
    expect(css.indexOf('.dialog-close {')).toBeGreaterThan(css.indexOf('.dialog-footer {'));
  });
});

describe('forms (M2, L8)', () => {
  it('one neutral required mark, never the danger colour', () => {
    const mark = rule('.required-mark');
    expect(mark).toMatch(/color:\s*var\(--muted\)/);
    expect(css).not.toMatch(/\.field-required/);
    expect(rule('.form-reason')).toMatch(/color:\s*var\(--muted\)/);
  });

  it("the token form's scope checkbox never shrinks when its label wraps", () => {
    expect(rule('.scope-chip input')).toMatch(/flex:\s*none/);
  });
});

describe('selected (M8)', () => {
  it('every selected control is a fill plus bold', () => {
    for (const sel of ['.filter-chip[aria-pressed="true"]', '.scope-chip:has(input:checked)']) {
      const r = rule(sel);
      expect(r, sel).toMatch(/background:\s*var\(--accent\)/);
      expect(r, sel).toMatch(/font-weight:\s*700/);
    }
  });

  it('a selected kind card is a lime ring and dot, never a fill, and keeps regular weight', () => {
    const r = rule('.kind-option:has(input:checked)');
    expect(r).toMatch(/border-color:\s*var\(--accent\)/);
    expect(r).not.toMatch(/background/);
    expect(r).not.toMatch(/font-weight/);
    expect(rule('.kind-option input')).toMatch(/accent-color:\s*var\(--accent\)/);
    expect(rule('.new-wf-form .form-actions')).toMatch(/justify-content:\s*flex-end/);
  });

  it('focus is shown for keyboard focus only, never :focus-within', () => {
    // The Decisions layout switch is gone (one layout), so no rule for it may linger.
    expect(css).not.toMatch(/\.decisions-layout-option/);
    expect(css).toMatch(/\.kind-option:has\(input:focus-visible\)/);
  });
});

describe('workflows tables and libraries (M6, L4, L9)', () => {
  it('both tables are fixed-layout; used-by spans library + active, so the last columns line up', () => {
    expect(rule('.wf-table table')).toMatch(/table-layout:\s*fixed/);
    for (const col of ['name', 'library', 'active', 'used-by', 'edited', 'actions']) {
      expect(rule(`.wf-col-${col}`), col).toMatch(/width:/);
    }
    const px = (col: string) => Number(rule(`.wf-col-${col}`).match(/width:\s*(\d+)px/)?.[1]);
    expect(px('used-by')).toBe(px('library') + px('active'));
  });

  it('a pill may wrap as a fallback in its narrow column (#34)', () => {
    expect(rule('.wf-table .activation-pill')).toMatch(/white-space:\s*normal/);
  });

  it('a problem chip next to a name grows and wraps instead of spilling out (#34)', () => {
    const chip = rule('.wf-name-line .chip');
    expect(chip).toMatch(/height:\s*auto/);
    expect(chip).toMatch(/min-height:\s*24px/);
    expect(chip).toMatch(/max-width:\s*100%/);
  });

  it('a name cell is a real table cell, so renaming never reflows the row', () => {
    expect(rule('.wf-name')).not.toMatch(/display:\s*flex/);
    expect(rule('.inline-edit')).toMatch(/height:\s*40px/);
  });

  it('library names keep their words; a path stays on one line, cut from the left', () => {
    expect(rule('.lib-table .lib-name')).toMatch(/min-width:/);
    expect(rule('.lib-path,\n.lib-note-path')).toMatch(/white-space:\s*nowrap/);
    expect(rule('.lib-path,\n.lib-note-path')).toMatch(/direction:\s*rtl/);
  });
});

describe('activation pill (M1)', () => {
  it('not active is neutral, active is lime, and nothing dashed or amber', () => {
    expect(rule('.activation-pill.is-active')).toMatch(/background:\s*var\(--accent\)/);
    const off = rule('.activation-pill.is-off');
    expect(off).not.toMatch(/dashed/);
    expect(off).not.toMatch(/--st-dry/);
    expect(off).toMatch(/color:\s*var\(--muted\)/);
  });
});
