import { expect, test } from 'bun:test';
import { clock } from '../server/clock';

test('stored timestamps keep increasing while the wall clock steps back, then follow it again', () => {
  const wall = Date.now;
  const before = clock();
  // Only a backward step is simulated: a forward one would leave later tests in this process with future timestamps.
  Date.now = () => wall() - 60_000;
  try {
    const during = [clock(), clock(), clock()];
    expect(during[0]).toBeGreaterThan(before);
    expect(during[1]).toBe(during[0]! + 1); expect(during[2]).toBe(during[1]! + 1);
  } finally { Date.now = wall; }
  const after = clock();
  // Restored, the clock is at most the three absorbed calls ahead of the wall (or of `before`, should the real clock step back too).
  expect(after).toBeGreaterThan(before); expect(after).toBeLessThanOrEqual(Math.max(Date.now(), before) + 4);
});
