/** The file extensions the engine treats as media (lower case, with the dot). */
export const MEDIA_EXTENSIONS = [
  '.mkv',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.ts',
  '.m2ts',
  '.webm',
  '.wmv',
  '.flv',
] as const;

/**
 * Whether a path's last segment has a media extension, by its text only (no disk access, so it
 * works in the browser). A trailing slash names a folder: false. A dotfile such as `.mkv` has no
 * extension, as with node's `extname`.
 */
export function isMediaPath(path: string): boolean {
  if (path.endsWith('/') || path.endsWith('\\')) return false;
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return (MEDIA_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase());
}
