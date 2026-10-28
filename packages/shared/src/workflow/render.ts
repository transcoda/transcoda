/**
 * The Render step (`core:render`): the one encode a path makes, between its last action and its
 * finish steps. Its input is `file`; Done always continues, Damaged only while Quality check is on.
 * The type and port ids are stored in saved graphs and never change.
 */
export const RENDER_TYPE = 'core:render';
export const RENDER_DONE_PORT = 'done';
export const RENDER_DAMAGED_PORT = 'damaged';

/**
 * The Check source step (`core:check-source`): a condition that reads the whole file before
 * anything is encoded. OK continues; a damaged file continues on Damaged, where only non-writing
 * finish steps may follow (no Render: nothing is encoded there).
 */
export const CHECK_SOURCE_TYPE = 'core:check-source';
export const CHECK_SOURCE_OK_PORT = 'ok';
export const CHECK_SOURCE_DAMAGED_PORT = 'damaged';
