// Types for the parts of @transcoda/dev-config (transcoda/.github, plain .mjs with JSDoc) that the
// scripts here use. Node does not strip types under node_modules, so the package ships no .ts.
declare module '@transcoda/dev-config/changes' {
  export type NoteType = 'breaking' | 'new' | 'improved' | 'fixed';
  export interface Layout {
    folders: string[] | null;
    perFolder?: string;
  }
  export interface Note {
    path: string;
    type: NoteType;
    text: string;
  }
  export interface Entry {
    type: NoteType;
    text: string;
  }
  export const DIR: '.changes';
  export const TYPES: NoteType[];
  export const HEADINGS: Record<NoteType, string>;
  export const NO_NOTE_LABEL: string;
  export const HIGHLIGHTS: 'highlights.md';
  export function layoutOf(root: string, perFolder?: string): Layout;
  export function lintNotes(root: string, layout: Layout): string[];
  export function readNotes(
    root: string,
    layout: Layout,
    folder?: string,
  ): { notes: Note[]; errors: string[] };
  export function groupEntries(notes: readonly Entry[]): Entry[];
  export function renderGroups(entries: readonly Entry[], level: number): string;
}
