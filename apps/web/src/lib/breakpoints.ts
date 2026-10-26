/**
 * The named widths the layout switches at (styles.css mirrors them; a test keeps the stylesheet to
 * these). `max-width` values, so a window of exactly 640 px is already "tablet".
 *  - phone   < 640 px: one column, the shell's header with a navigation drawer
 *  - tablet  < 1024 px: the editor's "needs a wider window" range, wide tables scroll
 *  - desktop ≤ 1280 px: the editor's side columns shrink (inclusive: a 1280 px laptop is the
 *    common case, UI review M10)
 * 899 px stays for the sign-in page's two-column layout only.
 */
export const BP_PHONE_MAX = 639;
export const BP_TABLET_MAX = 1023;
export const BP_DESKTOP_MAX = 1280;

export const PHONE_QUERY = `(max-width: ${BP_PHONE_MAX}px)`;
