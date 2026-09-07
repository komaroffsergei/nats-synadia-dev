export type RecordingRange = { firstAt: string | null; lastAt: string | null; snapshots: number; serverNow: string };

export function localDateTime(at: number) {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}

export function recordingInputs(range: RecordingRange, minutes?: number) {
  if (!range.firstAt || !range.lastAt) return null;
  const end = Math.min(Math.ceil(Date.parse(range.lastAt) / 1000) * 1000,
    Math.floor(Date.parse(range.serverNow) / 1000) * 1000);
  const first = Math.floor(Date.parse(range.firstAt) / 1000) * 1000;
  const start = minutes ? Math.max(first, end - minutes * 60000) : first;
  return { from: localDateTime(Math.min(start, end - 1000)), to: localDateTime(end) };
}

export function rangeProblem(from: string, to: string, mode: string, now: number, range?: RecordingRange | null) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || (mode === 'replay' && !Number.isFinite(end))) return 'empty';
  if (start > now) return 'future_start';
  if (mode !== 'replay') return '';
  if (end > now) return 'future_end';
  if (end <= start) return 'order';
  if (range && (!range.snapshots || !range.firstAt || !range.lastAt)) return 'unavailable';
  if (range?.firstAt && range.lastAt && (end < Date.parse(range.firstAt) || start > Date.parse(range.lastAt))) return 'outside';
  return '';
}
