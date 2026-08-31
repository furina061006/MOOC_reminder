import test from 'node:test';
import assert from 'node:assert/strict';

import { createSerializedStore } from '../../src/shared/items-mutex.js';

// Minimal async key-value store mirroring chrome.storage.local semantics:
// get() reads the live value at call time, set() overwrites it wholesale.
function makeStore(initial) {
  let value = initial;
  const delays = [];
  return {
    get: async () => {
      // simulate real async storage: yields before returning
      await new Promise(r => delays.push(setTimeout(r, 0)));
      return value;
    },
    set: async (v) => {
      await new Promise(r => delays.push(setTimeout(r, 0)));
      value = v;
    },
    read: () => value
  };
}

test('concurrent read-modify-write mutations do not lose updates', async () => {
  const store = makeStore([{ uid: 'a', n: 0 }]);
  const mutate = createSerializedStore(store);

  // Without serialization both mutations read n:0 and one write wins;
  // with the serialized store both increments must land.
  await Promise.all([
    mutate(items => { items[0].n += 1; }),
    mutate(items => { items[0].n += 1; }),
    mutate(items => { items[0].n += 1; })
  ]);

  assert.equal(store.read()[0].n, 3);
});

test('mutations run sequentially in submission order', async () => {
  const store = makeStore([]);
  const mutate = createSerializedStore(store);
  const order = [];

  await Promise.all([
    mutate(async items => { await sleep(15); order.push('first'); items.push('a'); }),
    mutate(items => { order.push('second'); items.push('b'); })
  ]);

  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(store.read(), ['a', 'b']);
});

test('a failing mutator rejects its caller but does not poison the chain', async () => {
  const store = makeStore(['x']);
  const mutate = createSerializedStore(store);

  await assert.rejects(() => mutate(() => { throw new Error('boom'); }));

  // subsequent writers still work
  await mutate(items => { items.push('y'); });
  assert.deepEqual(store.read(), ['x', 'y']);
});

test('mutator may return a replacement array (e.g. CLEAR_COMPLETED filter)', async () => {
  const store = makeStore([{ uid: 'a', checkedOff: true }, { uid: 'b', checkedOff: false }]);
  const mutate = createSerializedStore(store);

  await mutate(items => items.filter(i => !i.checkedOff));
  assert.deepEqual(store.read(), [{ uid: 'b', checkedOff: false }]);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
