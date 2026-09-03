import assert from 'node:assert/strict';
import test from 'node:test';

import { EVENT_LOG_MAX_BYTES, EVENT_LOG_MAX_EVENTS, EventLog } from '../dist/sync/event-log.js';

function makeEvent(eventId, extra = {}) {
  return {
    eventId,
    sessionId: extra.sessionId ?? 'sess-1',
    timestamp: extra.timestamp ?? '2026-09-04T00:00:00.000Z',
    type: extra.type ?? 'assistant.status',
    payload: extra.payload ?? { status: 'running' },
  };
}

test('null cursor and head cursor replay no event bodies', () => {
  const log = new EventLog();
  assert.deepEqual(log.catchUp(null), { status: 'replayed', events: [], headEventId: null });
  log.append(makeEvent('evt-1'));
  log.append(makeEvent('evt-2'));
  const fromNull = log.catchUp(null);
  assert.equal(fromNull.status, 'replayed');
  assert.deepEqual(fromNull.events, []);
  assert.equal(fromNull.headEventId, 'evt-2');
  const fromHead = log.catchUp('evt-2');
  assert.equal(fromHead.status, 'replayed');
  assert.deepEqual(fromHead.events, []);
  assert.equal(fromHead.headEventId, 'evt-2');
});

test('held cursor returns strictly-after events in append order', () => {
  const log = new EventLog();
  const first = makeEvent('evt-a');
  const second = makeEvent('evt-b', { type: 'user.message', payload: { text: 'hi' } });
  const third = makeEvent('evt-c');
  log.append(first);
  log.append(second);
  log.append(third);
  const hit = log.catchUp('evt-a');
  assert.equal(hit.status, 'replayed');
  assert.deepEqual(
    hit.events.map((event) => event.eventId),
    ['evt-b', 'evt-c'],
  );
  assert.equal(hit.events[0].payload.text, 'hi');
});

test('unknown and evicted cursors are gaps without bodies', () => {
  const log = new EventLog();
  log.append(makeEvent('evt-1'));
  const miss = log.catchUp('missing');
  assert.equal(miss.status, 'gap');
  assert.deepEqual(miss.events, []);
  assert.equal(miss.headEventId, 'evt-1');

  const overflowing = new EventLog();
  const ids = [];
  for (let index = 0; index < EVENT_LOG_MAX_EVENTS + 1; index += 1) {
    const eventId = `evt-${index}`;
    ids.push(eventId);
    overflowing.append(makeEvent(eventId));
  }
  const evicted = overflowing.catchUp(ids[0]);
  assert.equal(evicted.status, 'gap');
  assert.deepEqual(evicted.events, []);
  assert.equal(evicted.headEventId, ids[ids.length - 1]);
  const afterFirstKept = overflowing.catchUp(ids[1]);
  assert.equal(afterFirstKept.status, 'replayed');
  assert.equal(afterFirstKept.events[0].eventId, ids[2]);
  assert.equal(afterFirstKept.events.at(-1).eventId, ids[ids.length - 1]);
});

test('byte limit evicts oldest and a single huge event keeps head with empty storage', () => {
  const log = new EventLog();
  const bulky = 'x'.repeat(Math.floor(EVENT_LOG_MAX_BYTES / 3));
  log.append(makeEvent('evt-big-1', { payload: { status: bulky } }));
  log.append(makeEvent('evt-big-2', { payload: { status: bulky } }));
  log.append(makeEvent('evt-big-3', { payload: { status: bulky } }));
  const afterBytes = log.catchUp('evt-big-1');
  assert.equal(afterBytes.status, 'gap');
  assert.deepEqual(afterBytes.events, []);
  assert.equal(afterBytes.headEventId, 'evt-big-3');

  const huge = new EventLog();
  huge.append(
    makeEvent('evt-huge', {
      payload: { status: 'y'.repeat(EVENT_LOG_MAX_BYTES + 32) },
    }),
  );
  const fromNull = huge.catchUp(null);
  assert.equal(fromNull.status, 'replayed');
  assert.deepEqual(fromNull.events, []);
  assert.equal(fromNull.headEventId, 'evt-huge');
  const fromHead = huge.catchUp('evt-huge');
  assert.equal(fromHead.status, 'replayed');
  assert.deepEqual(fromHead.events, []);
  huge.append(makeEvent('evt-small'));
  const afterSmall = huge.catchUp('evt-huge');
  assert.equal(afterSmall.status, 'gap');
  assert.equal(afterSmall.headEventId, 'evt-small');
  assert.equal(huge.catchUp(null).headEventId, 'evt-small');
  assert.deepEqual(huge.catchUp('missing-before-small').events, []);
});
