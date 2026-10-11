import { describe, expect, test } from 'bun:test';
import { avatarCropRect, defaultAvatarCrop } from '../src/lib/avatar';

describe('avatar framing', () => {
  test('landscape and portrait images start with the same centered square seen in the profile', () => {
    expect(avatarCropRect(600, 300, defaultAvatarCrop())).toEqual({ x: 150, y: 0, size: 300 });
    expect(avatarCropRect(300, 600, defaultAvatarCrop())).toEqual({ x: 0, y: 150, size: 300 });
  });

  test('zoomed edge positions select the requested image region', () => {
    expect(avatarCropRect(600, 300, { zoom: 2, x: 1, y: 0 })).toEqual({ x: 450, y: 0, size: 150 });
    expect(avatarCropRect(300, 600, { zoom: 2, x: 0, y: 1 })).toEqual({ x: 0, y: 450, size: 150 });
  });

  test('zooming out fits a whole landscape image with centered transparent padding', () => {
    expect(avatarCropRect(600, 300, { zoom: .5, x: .5, y: .5 })).toEqual({ x: 0, y: -150, size: 600 });
    expect(avatarCropRect(300, 600, { zoom: .5, x: .5, y: .5 })).toEqual({ x: -150, y: 0, size: 600 });
  });

  test('zoom changes retain the image center for square, wide and tall sources', () => {
    for (const [width, height] of [[1024, 1024], [1600, 900], [900, 1600], [1, 4096]]) {
      for (const zoom of [.25, .5, 1, 1.73, 3]) {
        const rect = avatarCropRect(width, height, { zoom, x: .5, y: .5 });
        expect(rect.x + rect.size / 2).toBeCloseTo(width / 2, 10);
        expect(rect.y + rect.size / 2).toBeCloseTo(height / 2, 10);
      }
    }
  });

  test('out-of-range controls stay at the nearest supported edge and scale', () => {
    const zoomedOut = avatarCropRect(600, 300, { zoom: 0, x: -1, y: 2 });
    expect(zoomedOut.x).toBeCloseTo(0);
    expect(zoomedOut.y).toBe(-900);
    expect(zoomedOut.size).toBe(1200);
    expect(avatarCropRect(600, 300, { zoom: 100, x: 2, y: -1 })).toEqual({ x: 500, y: 0, size: 100 });
  });
});
