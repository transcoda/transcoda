import type { PortSpec } from '@transcoda/sdk';
import { z } from 'zod';

export const filePort: PortSpec = { id: 'file', label: 'File', type: 'file' };
export const languageInput: PortSpec = {
  id: 'language',
  label: 'Original language',
  type: 'data:language',
  required: false,
};
/**
 * A two-way branch. The ids `pass` and `else` are stored in saved graphs and never change; people
 * read "Yes" (the pass side) and "No" (the else side).
 */
export const passElse: PortSpec[] = [
  { id: 'pass', label: 'Yes', type: 'file' },
  { id: 'else', label: 'No', type: 'file' },
];
export const LanguageCodeSchema = z.string().regex(/^([a-z]{2,3}|unknown)$/);
