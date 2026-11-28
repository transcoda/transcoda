import type { JsonValue, SharedValue } from '@transcoda/shared';
import { RowMenu, type RowMenuItem } from '../../components/RowMenu.tsx';
import { type FieldDef, specFor } from '../model/schema-fields.ts';

/** Kinds a shared value cannot stand for: secrets, URLs and whole-object fallbacks. */
const NOT_SHAREABLE = new Set(['raw', 'password', 'url', 'path-mappings']);

export function shareable(field: FieldDef): boolean {
  return !NOT_SHAREABLE.has(field.spec.kind);
}

/** A value fits a field when it was made from a setting edited the same way (same spec). */
export function fits(field: FieldDef, value: SharedValue): boolean {
  return JSON.stringify(specFor(value.schema)) === JSON.stringify(field.spec);
}

/** A value as one short line: "en, de", "24", "on". */
export function valueText(value: JsonValue): string {
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(valueText).join(', ');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === null) return 'not set';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The link control in a field's label row. Unlinked: a link button whose menu follows a value of
 * the same kind or makes a new one from the setting. Linked: the value's name, whose menu stops
 * following it.
 */
export function SettingLink({
  field,
  linked,
  values,
  onFollow,
  onUnlink,
  onShare,
}: {
  field: FieldDef;
  linked: string | null;
  values: readonly SharedValue[];
  onFollow(name: string): void;
  onUnlink(): void;
  onShare(): void;
}) {
  if (linked !== null) {
    return (
      <span className="tc-link">
        <RowMenu
          name={field.label}
          button={{
            icon: 'link',
            label: `${field.label} follows the shared value ${linked}`,
            text: linked,
            className: 'tc-link-chip is-linked',
          }}
          items={[{ label: `Stop following ${linked}`, icon: 'cross', onSelect: onUnlink }]}
        />
      </span>
    );
  }
  const items: RowMenuItem[] = [
    ...values
      .filter((v) => fits(field, v))
      .map((v) => ({
        label: `Follow ${v.name} (${valueText(v.value)})`,
        icon: 'link' as const,
        onSelect: () => onFollow(v.name),
      })),
    { label: 'New shared value', icon: 'plus', onSelect: onShare },
  ];
  return (
    <span className="tc-link">
      <RowMenu
        name={field.label}
        button={{ icon: 'link', label: `Share ${field.label}`, className: 'tc-link-chip' }}
        items={items}
      />
    </span>
  );
}
