import * as assert from 'assert';
import { History, describeCpu, describeRss, sparkPoints, summarize } from '../../../src/monitor/webview/appModel';

describe('History', () => {
  it('keeps the last N finite values and skips undefined', () => {
    const h = new History(3);
    for (const v of [1, undefined, 2, NaN, 3, 4]) h.push(v);
    assert.deepStrictEqual([...h.list], [2, 3, 4]);
    h.clear();
    assert.strictEqual(h.list.length, 0);
  });
  it('defaults to 60 points', () => {
    const h = new History();
    for (let i = 0; i < 100; i++) h.push(i);
    assert.strictEqual(h.list.length, 60);
    assert.strictEqual(h.list[0], 40);
  });
});

describe('sparkPoints', () => {
  it('maps values into the box, 0 at the bottom', () => {
    assert.strictEqual(sparkPoints([0, 50, 100], 100, 32, 100), '0,31 50,16 100,1');
  });
  it('scales to the data when no max is given and handles one point and none', () => {
    assert.strictEqual(sparkPoints([5, 10], 10, 11), '0,5.5 10,1');
    assert.strictEqual(sparkPoints([3], 100, 10), '100,1');
    assert.strictEqual(sparkPoints([], 100, 10), '');
  });
  it('never leaves the box for negative or huge values', () => {
    for (const p of sparkPoints([-5, 1e12], 100, 32, 100).split(' ')) {
      const [x, y] = p.split(',').map(Number);
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 32, p);
    }
  });
});

describe('text alternatives', () => {
  it('summarises and describes', () => {
    assert.deepStrictEqual(summarize([2, 4, 12]), { avg: 6, max: 12 });
    assert.strictEqual(summarize([]), undefined);
    assert.strictEqual(describeCpu([5, 11, 31]), 'CPU over the last minute: avg 16 %, max 31 %');
    assert.strictEqual(describeCpu([]), 'CPU over the last minute: no data yet');
    assert.strictEqual(describeRss([48 * 1024, 52 * 1024]), 'Memory over the last minute: avg 50 MB, max 52 MB');
    assert.strictEqual(describeRss([]), 'Memory over the last minute: no data yet');
  });
});
