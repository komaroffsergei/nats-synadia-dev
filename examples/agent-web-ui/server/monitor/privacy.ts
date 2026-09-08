const REDACTED = '[скрыто]';
const PRIVATE_OPERATION = '[СЛУЖЕБНАЯ ОПЕРАЦИЯ С УЧЁТНЫМИ ДАННЫМИ СКРЫТА]';

const sensitiveKey = (key: string) => {
  const value = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (/(?:^|_)(?:enabled|present|required|path|file|name|count|ttl|type)$/.test(value)) return false;
  return /(?:^|_)(?:authorization|password|passwd|secret|api_?key|access_?token|refresh_?token|id_?token|cookie|credential|client_?secret|private_?key)(?:$|_)/.test(value);
};

function replaceSecrets(input: string) {
  let text = input.normalize('NFC');
  if (text.includes('PRIVATE KEY')) text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
  if (/(?:sk-|gh|github_pat_|xox|glpat-|npm_|pypi-)/.test(text)) text = text.replace(/(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|glpat-|npm_|pypi-)[A-Za-z0-9_\-.]{6,}/g, REDACTED);
  if (/(?:AKIA|ASIA)/.test(text)) text = text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED);
  if (/\d{6,12}:/.test(text)) text = text.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, REDACTED);
  if (text.includes('eyJ')) text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, REDACTED);
  if (/\b(?:Bearer|Basic)\s/i.test(text)) text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, `$1 ${REDACTED}`);
  if (text.includes('://') && text.includes('@')) text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  if (/[?&]/.test(text)) text = text.replace(/([?&](?:access_token|refresh_token|api_?key|token|password|secret|signature|sig|auth)=)[^\s&#"'<>]+/gi, `$1${REDACTED}`);
  if (/(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|credential|private[_-]?key)/i.test(text)) {
    text = text.replace(/((?:^|[\s,{;])(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|PRIVATE_KEY))\s*=\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/gim, `$1${REDACTED}`);
    text = text.replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|cookie|credential|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$))/gi, `$1${REDACTED}`);
    text = text.replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|cookie|credential|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["']?)([^\s"'`,;}]+)/gi, `$1${REDACTED}`);
  }
  if (/(?:--|-u\s)/.test(text)) text = text.replace(/((?:--?(?:password|passwd|secret|token|api-key|api_key|authorization)|-u)\s*(?:=|\s)\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s]+)/gi, `$1${REDACTED}`);
  if (/[A-Z]/.test(text) && /\d/.test(text)) text = text.replace(/\b[A-Za-z0-9_-]{32,}\b/g, value => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) ? REDACTED : value);
  return text;
}

function sanitizeStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeStructured);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? REDACTED : sanitizeStructured(item)]));
  }
  return typeof value === 'string' ? redactStoredText(value) : value;
}

export function redactStoredText(input: unknown) {
  const text = String(input ?? '');
  if (/^\s*[\[{]/.test(text)) {
    try { return JSON.stringify(sanitizeStructured(JSON.parse(text))); }
    catch { /* Incomplete streamed JSON is handled by lexical rules. */ }
  }
  return replaceSecrets(text);
}

function privateToolOperation(text: string) {
  return /(?:\.htpasswd|(?:^|[\\/])[\w.-]*\.env(?:\.[\w.-]+)?\b|mitm-ca\.key|(?:^|[\\/])(?:keys|auth)\.json\b|(?:^|[\\/])credentials?(?:\.[a-z]+)?\b|(?:^|[\\/])users[\\/][^\s]+\.json\b)/i.test(text)
    && /(?:get-content|read_text|readfile|cat\s|source\s|type\s|curl\s|authorization|password|token|secret|credential)/i.test(text);
}

export function redactPublicText(input: unknown, options: { kind?: string } = {}) {
  let text = redactStoredText(input);
  if ((options.kind === 'tool_call' || options.kind === 'tool_result') && privateToolOperation(text)) return PRIVATE_OPERATION;
  if (/vdsina\.(?:ru|com)/i.test(text)) text = text.replace(/https?:\/\/(?:cp\.)?vdsina\.(?:ru|com)\/[^\s"'<>)]*/gi, '[СЛУЖЕБНАЯ ССЫЛКА]');
  if (/:\\*\/*Users[\\/]/i.test(text)) text = text.replace(/\b[A-Z]:[\\/]+Users[\\/]+[^\s"'<>`,;)]+/gi, '[РАБОЧАЯ ПАПКА]');
  if (/\/(?:home|root)\//.test(text)) text = text.replace(/\/(?:home|root)\/[^\s"'<>`,;)]+/g, '[РАБОЧАЯ ПАПКА]');
  if (/\/(?:opt\/codex-proxy|srv\/portfolio|var\/lib\/docker|etc\/nginx)/.test(text)) text = text.replace(/\/(?:opt\/codex-proxy|srv\/portfolio|var\/lib\/docker|etc\/nginx)(?:\/[^\s"'<>`,;)]*)?/g, '[СЕРВЕРНЫЙ ПУТЬ]');
  if (/(?:\.htpasswd|mitm-ca\.key|\.env(?:\.|\b)|(?:keys|auth)\.json|credentials?\.(?:json|ya?ml))/i.test(text)) text = text.replace(/\S*(?:\.htpasswd\S*|mitm-ca\.key|[\w.-]*\.env(?:\.[\w.-]+)?|(?:keys|auth)\.json|credentials?\.(?:json|ya?ml))\S*/gi, '[СЕКРЕТНЫЙ ФАЙЛ]');
  if (/(?:proxy_username|userLabel|PROXY_USER|MONITOR_USERS|username|login)/i.test(text)) text = text.replace(/((?:proxy_username|userLabel|PROXY_USER|MONITOR_USERS|username|login)\s*["']?\s*[:=]\s*["']?)[^\s"'`,;}]+/gi, '$1[ПОЛЬЗОВАТЕЛЬ]');
  if (/(?:configId|active_config_id|config_id)/i.test(text)) text = text.replace(/((?:configId|active_config_id|config_id)\s*["']?\s*[:=]\s*["']?)[^\s"'`,;}]+/gi, '$1[КОНФИГУРАЦИЯ]');
  if (/(?:sessionId|session_id|accountId|account_id|tenantId|tenant_id|connectionId|connection_id)/i.test(text)) text = text.replace(/((?:sessionId|session_id|accountId|account_id|tenantId|tenant_id|connectionId|connection_id)\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9:_./-]+/gi, '$1[ИДЕНТИФИКАТОР]');
  if (text.includes('@')) text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]');
  text = text.replace(/(?<![\w.])(?:\+?\d[\s()-]*){10,15}(?![\w.])/g, '[ТЕЛЕФОН]');
  text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, value => {
    const octets=value.split('.').map(Number);
    return octets.every(part=>part>=0&&part<=255) && octets[0]!==127 ? '[IP]' : value;
  });
  return text;
}

export function sanitizeEventForStorage<T extends Record<string, any>>(event: T): T {
  return sanitizeStructured(structuredClone(event)) as T;
}

export function sanitizePublicItem<T extends Record<string, any>>(item: T): T {
  return { ...item, name: item.name ? redactPublicText(item.name) : item.name, text: redactPublicText(item.text, { kind:item.kind }) };
}

export function sanitizePublicTitle(value: unknown) {
  return redactPublicText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0,160) || 'Чат без названия';
}

export const privacyMarkers = { REDACTED, PRIVATE_OPERATION };
