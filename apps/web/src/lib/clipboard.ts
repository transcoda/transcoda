// The only place that touches the clipboard (#27). `navigator.clipboard` exists only in a secure
// context (https, localhost), so every LAN install over plain http needs the fallbacks below.

export type CopyResult = 'copied' | 'selected';

/**
 * Copies `text`: navigator.clipboard.writeText when it exists (secure context), else a hidden
 * textarea + document.execCommand('copy'). When both fail and `select` is given, selects that
 * element's text (input.select() or a Range over it) and returns 'selected' so the caller can say
 * "Press ⌘C to copy" (Ctrl+C off macOS). Never throws.
 */
export async function copyText(
  text: string,
  select?: HTMLElement | null,
): Promise<CopyResult | 'failed'> {
  // lib.dom types `navigator.clipboard` as always present; on plain http it is undefined.
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return 'copied';
    } catch {
      // Permission refused or no user activation: try the old way.
    }
  }
  if (execCopy(text)) return 'copied';
  if (select && selectContents(select)) return 'selected';
  return 'failed';
}

/**
 * `document.execCommand('copy')` is deprecated, but it is the only way to write the clipboard
 * from plain http. It copies the current selection, so a hidden textarea holds the text for the
 * moment of the copy; focus goes back to where it was (the Copy button) afterwards. jsdom has no
 * `execCommand` at all, hence the typeof check.
 */
function execCopy(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const previous = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.tabIndex = -1;
  // Off-screen but rendered: a display:none textarea cannot be selected.
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  document.body.append(area);
  let ok = false;
  try {
    area.focus();
    area.select();
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
  return ok;
}

function selectContents(el: HTMLElement): boolean {
  try {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.select();
      el.setSelectionRange(0, el.value.length);
      return true;
    }
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/** "⌘C" on Apple platforms (navigator.platform / userAgentData), else "Ctrl+C". */
export function copyShortcut(): string {
  // `userAgentData` (Chromium only) is not in lib.dom; `platform` is deprecated but everywhere.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘C' : 'Ctrl+C';
}
