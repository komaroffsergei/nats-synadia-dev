export type DisplayPart = { text: string; context: boolean };

// Presentation only: keep every character, including the original wrapper tags.
// `context` on a wire item means replayed input, not service context.
export function isTitleRequest(text: string): boolean {
  return text.startsWith('You are a helpful assistant. You will be presented with')
    && text.includes('your job is to provide a short title for')
    && text.includes('The title you generate will be shown in the UI');
}

export function displayParts(item: { role?: string; text?: string }): DisplayPart[] {
  const text = item.text || '';
  if (item.role !== 'user') return [{ text, context: false }];
  if (isTitleRequest(text.trimStart())) return [{ text, context: true }];
  const tags = 'environment_context|recommended_plugins|in-app-browser-context|skills_instructions|permissions';
  const opening = new RegExp(`^<(${tags})(?:\\s[^>]*|)>`, 'gm');
  const parts: DisplayPart[] = [];
  let start = 0, match: RegExpExecArray | null;
  while ((match = opening.exec(text))) {
    if (match.index < start) continue;
    if (match.index > start) parts.push({ text: text.slice(start, match.index), context: false });
    const close = text.indexOf(`</${match[1]}>`, opening.lastIndex);
    const end = close < 0 ? text.length : close + match[1].length + 3;
    parts.push({ text: text.slice(match.index, end), context: true });
    start = end; opening.lastIndex = end;
  }
  if (start < text.length || !parts.length) parts.push({ text: text.slice(start), context: false });
  return parts;
}

export function userTitle(text: string): string {
  if (isTitleRequest(text.trimStart())) return '';
  return displayParts({ role: 'user', text }).filter(p => !p.context).map(p => p.text).join(' ')
    .replace(/^\s*## My request:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export type SessionDisplay = { title: string; activity: string };
export function nextDisplay(current: SessionDisplay, item: { role?: string; text?: string; segment?: number }): SessionDisplay {
  if (item.segment) return current;
  const text = item.text || '';
  if (item.role === 'user' && isTitleRequest(text.trimStart()))
    return current.activity === 'title_generation' ? current : { title: 'Создание названия чата', activity: 'title_generation' };
  if (item.role === 'assistant' && current.activity === 'title_generation') {
    try {
      const result = JSON.parse(text);
      if (typeof result.title === 'string' && result.title.trim())
        return { title: `Название чата: ${result.title.trim().slice(0, 140)}`, activity: current.activity };
    } catch { /* A streaming or non-JSON response retains the truthful fallback. */ }
  }
  if (item.role === 'user' && !current.title && current.activity !== 'title_generation')
    return { ...current, title: userTitle(text) };
  return current;
}
