/**
 * The Render step (`core:render`): the one encode a path makes, between its last action and its
 * finish steps. Its input is `file`; Done always continues, Damaged only while Quality check is on.
 * The type and port ids are stored in saved graphs and never change.
 */
export const RENDER_TYPE = 'core:render';
export const RENDER_DONE_PORT = 'done';
export const RENDER_DAMAGED_PORT = 'damaged';
