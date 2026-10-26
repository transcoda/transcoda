import { describe, expect, it } from 'vitest';
import { cardDescription, groupOf, monogram, nodeNameOf } from './pluginGroups.ts';

describe('groupOf', () => {
  it("puts the official catalog's plugins under their purpose and anything else under Other", () => {
    expect(['sonarr', 'radarr', 'bazarr', 'seerr'].map(groupOf)).toEqual(
      Array(4).fill('media-managers'),
    );
    expect(groupOf('jellyfin')).toBe('media-servers');
    expect(groupOf('tmdb')).toBe('metadata');
    expect([groupOf('discord'), groupOf('ntfy')]).toEqual(['notifications', 'notifications']);
    expect(groupOf('example')).toBe('other');
  });
});

describe('cardDescription', () => {
  it('drops the "X plugin:" lead-in and starts with a capital', () => {
    expect(
      cardDescription(
        'Jellyfin',
        'Jellyfin plugin: asks Jellyfin to rescan a file or the whole library after Transcoda replaces a file.',
      ),
    ).toBe('Asks Jellyfin to rescan a file or the whole library after Transcoda replaces a file.');
    expect(cardDescription('ntfy', 'ntfy plugin: sends a push.')).toBe('Sends a push.');
  });

  it('moves a parenthesis in the lead-in to the end', () => {
    expect(
      cardDescription(
        'Seerr',
        'Seerr plugin (Jellyseerr, Overseerr): checks whether a title was requested, by whom and when.',
      ),
    ).toBe('Checks whether a title was requested, by whom and when (Jellyseerr, Overseerr).');
  });

  it('leaves a description without the lead-in alone', () => {
    expect(cardDescription('Example', 'Shouts at your files.')).toBe('Shouts at your files.');
  });
});

describe('monogram and nodeNameOf', () => {
  it('takes the first character as written', () => {
    expect(monogram('Jellyfin')).toBe('J');
    expect(monogram('ntfy')).toBe('n');
  });

  it('turns a node type into a name', () => {
    expect(nodeNameOf('bazarr:get-subtitles-now')).toBe('Get subtitles now');
    expect(nodeNameOf('sonarr:rescan')).toBe('Rescan');
  });
});
