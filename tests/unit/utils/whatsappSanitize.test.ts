import { sanitizeTemplateVar, sanitizeServiceMessage } from '@/utils/whatsappSanitize'

describe('sanitizeTemplateVar', () => {
  it('replaces newlines with single space', () => {
    expect(sanitizeTemplateVar('hola\nmundo', 100)).toBe('hola mundo')
    expect(sanitizeTemplateVar('a\r\nb\nc', 100)).toBe('a b c')
  })

  it('collapses whitespace', () => {
    expect(sanitizeTemplateVar('a   b\t\tc', 100)).toBe('a b c')
  })

  it('strips control characters except space', () => {
    expect(sanitizeTemplateVar('hola\x07mundo', 100)).toBe('holamundo')
    expect(sanitizeTemplateVar('hola\x01mundo', 100)).toBe('holamundo')
  })

  it('preserves emojis', () => {
    expect(sanitizeTemplateVar('hola 👋 mundo', 100)).toBe('hola 👋 mundo')
  })

  it('replaces URLs with [enlace]', () => {
    expect(sanitizeTemplateVar('visita https://example.com hoy', 100)).toBe('visita [enlace] hoy')
    expect(sanitizeTemplateVar('http://foo.com/bar', 100)).toBe('[enlace]')
  })

  it('truncates to maxLen with ellipsis', () => {
    expect(sanitizeTemplateVar('a'.repeat(300), 250)).toHaveLength(250)
    expect(sanitizeTemplateVar('a'.repeat(300), 250).endsWith('…')).toBe(true)
  })

  it('does not truncate strings shorter than maxLen', () => {
    expect(sanitizeTemplateVar('short', 250)).toBe('short')
  })
})

describe('sanitizeServiceMessage', () => {
  it('preserves newlines (unlike template sanitizer)', () => {
    expect(sanitizeServiceMessage('hola\nmundo')).toBe('hola\nmundo')
  })

  it('still strips control chars', () => {
    expect(sanitizeServiceMessage('hola\x07mundo')).toBe('holamundo')
  })

  it('truncates at 1500 with truncation suffix', () => {
    const long = 'a'.repeat(2000)
    const out = sanitizeServiceMessage(long)
    expect(out.length).toBeLessThanOrEqual(1500 + ' … [mensaje truncado]'.length)
    expect(out.endsWith('… [mensaje truncado]')).toBe(true)
  })
})
