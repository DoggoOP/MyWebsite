import { expect, test } from 'vitest';
import { sailPolylines, leewardPoint } from './sails';
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 1));
test('main runs from the luff at the origin to the clew down-left at 45 degrees', () => {
  const { main } = sailPolylines();
  expect(main).toHaveLength(41);
  close(main[0], [0, 0]); close(main[40], [-137.18, 137.18]); close(main[20], [-56.92, 83.44]);
});
test('jib sits upwind with its own 10 degree offset', () => {
  const { jib } = sailPolylines();
  close(jib[0], [129.4, -129.4]); close(jib[40], [60.48, 21.33]); close(jib[20], [113.19, -60.48]);
});
test('leeward point lies on the convex side of the main', () => {
  const [x, y] = leewardPoint('main');
  expect(x).toBeGreaterThan(-56.92); expect(y).toBeGreaterThan(83.44);
});
