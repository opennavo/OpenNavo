import { describe, expect, it } from 'vitest';
import { collectionIcons } from '../src/utils/collections';

const base = {
  slug: 'new-mac',
  title: '新 Mac 必装',
  subtitle: null,
  coverUrl: null,
  itemCount: 3,
  updatedAt: '2026-09-30T08:00:00Z'
};

describe('collectionIcons', () => {
  it('Falls back to previewItems', () => {
    const icons = collectionIcons({
      ...base,
      iconUrls: [null, 'https://cdn.example/a.png'],
      previewItems: [
        { kind: 'formula', token: 'ripgrep', displayName: 'ripgrep', iconUrl: null, accentColor: null },
        {
          kind: 'cask',
          token: 'ghostty',
          displayName: 'Ghostty',
          iconUrl: 'https://cdn.example/a.png',
          accentColor: '#3D7EFF'
        }
      ]
    });
    expect(icons).toEqual([
      { kind: 'formula', token: 'ripgrep', name: 'ripgrep', src: null, accent: null },
      { kind: 'cask', token: 'ghostty', name: 'Ghostty', src: 'https://cdn.example/a.png', accent: '#3D7EFF' }
    ]);
  });

  it('Supports legacy icon URLs', () => {
    expect(collectionIcons({ ...base, iconUrls: ['https://cdn.example/a.png', null] })).toEqual([
      { src: 'https://cdn.example/a.png' },
      { src: null }
    ]);
  });
});
