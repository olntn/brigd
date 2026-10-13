import { stripVTControlCharacters } from 'node:util';

export const MAX_LOG_ERROR_LENGTH = 8000;
const REDACTED = '[скрыто]';
const TRUNCATED = '\n[текст ошибки сокращён]';

// This covers common credential names, including environment variable prefixes.
// Bound prefix/suffix matching to avoid repeated scans of huge malformed names.
const credentialName = String.raw`(?:[\w.-]{0,96}[_-])?(?:token|password|passwd|api[_-]?key|secret|secret[_-]?access[_-]?key|client[_-]?secret|access[_-]?key)(?:[_-][\w.-]{1,96})?`;
const credentialKey = new RegExp(`^(?:${credentialName}|authorization|auth|key|sig|(?:[\\w.-]{0,96}[_-])?(?:signature|credential)|AWSAccessKeyId)$`, 'i');
const valuePattern = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[скрыто\]|[^\s,;&"'<>\)\}\]]+`;
const assignment = new RegExp(`((?<![\\w.-])["']?${credentialName}["']?[ \\t]*(?:=|:)[ \\t]*)(${valuePattern})`, 'gi');
const cliFlag = new RegExp(`((?<![\\w-])--${credentialName}(?:=|[ \\t]+))(${valuePattern})`, 'gi');

function redactValue(_match: string, prefix: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
  return `${prefix}${quote}${REDACTED}${quote}`;
}

function redactUrl(url: string): string {
  // Preserve host/path and query names so the error remains useful to diagnose.
  return url
    .replace(/^([a-z][a-z\d+.-]*:\/\/)[^/?#]*@/i, `$1${REDACTED}@`)
    .replace(/([?&])([^=?&#]+)=([^&#]*)/g, (match: string, separator: string, key: string) => {
      let decoded = key;
      try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { /* Keep malformed query keys as written. */ }
      return credentialKey.test(decoded) ? `${separator}${key}=${REDACTED}` : match;
    });
}

/**
 * Prepare failure text for a copyable log. Callers select error fields; ordinary
 * tool output must not be passed here. Redacts known credential formats, rather
 * than promising to identify arbitrary secrets in free-form provider messages.
 */
export function sanitizeLogError(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value
    : value !== null && typeof value === 'object' && !Array.isArray(value) && 'message' in value && typeof value.message === 'string'
      ? value.message : undefined;
  if (!raw) return undefined;

  let text = stripVTControlCharacters(raw)
    // Keep readable multiline errors and indentation, remove terminal controls.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/-----BEGIN (?:[A-Z\d]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z\d]+ )*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/(?<![\w.+-])[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi, redactUrl)
    .replace(/((?:["']?(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?)(?:Bearer|Basic)[ \t]+)[^\s"',;]+/gi, `$1${REDACTED}`)
    .replace(/\b(Bearer[ \t]+)[a-z\d~+/_=.-]+/gi, `$1${REDACTED}`)
    .replace(assignment, redactValue)
    .replace(cliFlag, redactValue)
    .replace(/\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d]{20,}|github_pat_[a-z\d_]{20,}|glpat-[a-z\d_-]{16,}|xox[baprs]-[a-z\d-]{10,}|(?:sk|rk)_(?:live|test)_[a-z\d]{12,}|hf_[a-z\d]{20,}|npm_[a-z\d]{20,}|AIza[a-z\d_-]{30,}|(?:AKIA|ASIA)[A-Z\d]{16}|eyJ[a-z\d_-]{5,}\.[a-z\d_-]{5,}\.[a-z\d_-]{5,})\b/gi, REDACTED)
    .trim();
  if (!text) return undefined;
  if (text.length > MAX_LOG_ERROR_LENGTH) {
    text = text.slice(0, MAX_LOG_ERROR_LENGTH - TRUNCATED.length);
    // Do not leave half of a supplementary Unicode character at the boundary.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text += TRUNCATED;
  }
  return text;
}
