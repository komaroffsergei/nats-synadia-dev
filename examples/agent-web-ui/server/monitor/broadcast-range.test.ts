import { test, expect } from 'bun:test';
import { localDateTime, recordingInputs, rangeProblem } from '../../src/broadcast-range';
const range = {firstAt:'2026-09-07T13:14:23.719569Z',lastAt:'2026-09-07T20:47:47.915981Z',serverNow:'2026-09-07T22:44:15.322Z',snapshots:26371};
const now = Date.parse(range.serverNow);
test('future day is distinguished from reversed or unavailable history', () => {
  expect(rangeProblem(localDateTime(Date.parse('2026-09-08T13:14:23Z')),localDateTime(Date.parse('2026-09-08T16:39:44Z')),'replay',now,range)).toBe('future_start');
  expect(rangeProblem(localDateTime(Date.parse(range.firstAt)),localDateTime(now+86400000),'replay',now,range)).toBe('future_end');
  expect(rangeProblem(localDateTime(now-1000),localDateTime(now-2000),'replay',now,range)).toBe('order');
  expect(rangeProblem(localDateTime(now-2000),localDateTime(now-1000),'replay',now,range)).toBe('outside');
  expect(rangeProblem('', '', 'replay',now,range)).toBe('empty');
});
test('session presets use event dates, include the last sub-second event and round trip local time', () => {
  const all = recordingInputs(range)!;
  expect(new Date(all.from).toISOString()).toBe('2026-09-07T13:14:23.000Z');
  expect(new Date(all.to).toISOString()).toBe('2026-09-07T20:47:48.000Z');
  const tail = recordingInputs(range,5)!;
  expect(Date.parse(tail.to)-Date.parse(tail.from)).toBe(300000);
  expect(rangeProblem(tail.from,tail.to,'replay',now,range)).toBe('');
  expect(rangeProblem(tail.from,'','live',now,range)).toBe('');
  expect(recordingInputs({...range,firstAt:null,lastAt:null,snapshots:0})).toBeNull();
});
