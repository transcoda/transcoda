import { describe, expect, it } from 'vitest';
import { isMediaPath, MEDIA_EXTENSIONS } from './media.ts';

describe('isMediaPath', () => {
  it('is true for a media extension in any case, false for folders and other files', () => {
    expect(MEDIA_EXTENSIONS).toContain('.mkv');
    expect(isMediaPath('/media/Shows/a.mkv')).toBe(true);
    expect(isMediaPath('/media/Shows/A.MP4')).toBe(true);
    expect(isMediaPath('/media/Shows')).toBe(false);
    expect(isMediaPath('/media/Shows/')).toBe(false);
    expect(isMediaPath('/media/Shows.mkv/')).toBe(false);
    expect(isMediaPath('/media/Shows/notes.txt')).toBe(false);
    expect(isMediaPath('/media/.mkv')).toBe(false);
    expect(isMediaPath('/media/v1.0/clip')).toBe(false);
  });
});
