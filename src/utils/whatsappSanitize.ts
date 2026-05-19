const URL_REGEX = /https?:\/\/\S+/g
// Strip ASCII control chars except whitespace we explicitly handle elsewhere.
// The control characters in this class are exactly what we're sanitizing OUT
// of WhatsApp payloads — flagging them as "unexpected" defeats the purpose.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

// Sanitize a string for use as a WhatsApp utility template variable.
// Strips control chars, collapses whitespace, replaces URLs with [enlace],
// caps at maxLen. Per spec §Sanitization of ALL template variables.
export function sanitizeTemplateVar(input: string, maxLen: number): string {
  let s = input || ''
  s = s.replace(CONTROL_CHARS_REGEX, '')
  s = s.replace(/[\r\n]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(URL_REGEX, '[enlace]')
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

// Sanitize a string for use as a WhatsApp service (non-template) message.
// Same as template sanitizer but preserves newlines and uses a higher cap.
// Per spec §Sanitization of service messages.
export function sanitizeServiceMessage(input: string): string {
  const MAX_LEN = 1500
  const SUFFIX = ' … [mensaje truncado]'
  let s = input || ''
  s = s.replace(CONTROL_CHARS_REGEX, '')
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + SUFFIX
  return s
}
