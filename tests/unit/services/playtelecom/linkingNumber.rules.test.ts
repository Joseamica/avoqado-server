import {
  normalizeLinkingNumber,
  isValidTerminalNumber,
  isValidBackofficeNumber,
  isNewerCapture,
  withAppliedCapture,
  canTerminalWriteNumber,
  computeNumberAlerts,
} from '../../../../src/services/playtelecom/linkingNumber.rules'

const base = {
  linkingNumber: '5512345678' as string | null,
  linkingNumberSource: 'TPV' as const,
  portedNumber: null as string | null,
  portedNumberSource: null,
  isPortabilidad: false,
  photos: ['a'],
  isExternalSale: false,
  linkingDuplicate: false,
  portedDuplicate: false,
}

describe('linkingNumber.rules', () => {
  it('normaliza y valida', () => {
    expect(normalizeLinkingNumber(' 55 1234-5678 ')).toBe('5512345678')
    expect(normalizeLinkingNumber('(55) 1234.5678')).toBe('5512345678')
    expect(isValidTerminalNumber(normalizeLinkingNumber('+52 55 1234 5678'))).toBe(false)
    expect(isValidTerminalNumber('551234567')).toBe(true)
    expect(isValidTerminalNumber('5512345678')).toBe(true)
    expect(isValidTerminalNumber('55123456')).toBe(false)
    expect(isValidTerminalNumber(normalizeLinkingNumber('334651O556'))).toBe(false)
    expect(isValidBackofficeNumber('551234567', false)).toBe(false)
    expect(isValidBackofficeNumber('551234567', true)).toBe(true)
    expect(isValidBackofficeNumber('5512345678', false)).toBe(true)
  })

  it('capturas más nuevas por destino y aparato', () => {
    expect(isNewerCapture({}, 'LINKING', 'dev-a', 1)).toBe(true)
    expect(isNewerCapture({ LINKING: { 'dev-a': 5 } }, 'LINKING', 'dev-a', 5)).toBe(false)
    expect(isNewerCapture({ LINKING: { 'dev-a': 5 } }, 'LINKING', 'dev-a', 6)).toBe(true)
    expect(isNewerCapture({ LINKING: { 'dev-a': 5 } }, 'LINKING', 'dev-b', 1)).toBe(true)
    expect(isNewerCapture({ LINKING: { 'dev-a': 5 } }, 'PHOTO_VINCULACION', 'dev-a', 2)).toBe(true)
  })

  it('withAppliedCapture no muta y conserva lo demás', () => {
    const a = { LINKING: { 'dev-a': 5 } }
    const b = withAppliedCapture(a, 'LINKING', 'dev-b', 2)
    expect(b).toEqual({ LINKING: { 'dev-a': 5, 'dev-b': 2 } })
    expect(a).toEqual({ LINKING: { 'dev-a': 5 } })
    expect(withAppliedCapture(b, 'PORTED', 'dev-a', 1).PORTED).toEqual({ 'dev-a': 1 })
  })

  it('canTerminalWriteNumber', () => {
    expect(canTerminalWriteNumber('BACKOFFICE')).toBe(false)
    expect(canTerminalWriteNumber('EXTERNAL_SALE')).toBe(false)
    expect(canTerminalWriteNumber('IMPORT')).toBe(false)
    expect(canTerminalWriteNumber('TPV')).toBe(true)
    expect(canTerminalWriteNumber(null)).toBe(true)
  })

  it('alertas', () => {
    expect(computeNumberAlerts(base)).toEqual([])
    expect(computeNumberAlerts({ ...base, linkingNumber: '551234567' })).toContain('NOT_10_DIGITS')
    expect(computeNumberAlerts({ ...base, linkingNumber: '551234567', linkingNumberSource: 'BACKOFFICE' })).not.toContain('NOT_10_DIGITS')
    expect(computeNumberAlerts({ ...base, linkingNumber: null, photos: ['https://f/x.jpg'] })).toContain('LINKING_MISSING')
    expect(computeNumberAlerts({ ...base, linkingNumber: null, photos: [] })).toEqual([])
    expect(computeNumberAlerts({ ...base, linkingNumber: null, photos: [], isExternalSale: true })).toContain('LINKING_MISSING')
    expect(computeNumberAlerts({ ...base, isPortabilidad: true, portedNumber: null, photos: ['a', 'b'] })).toContain('PORTED_MISSING')
    expect(computeNumberAlerts({ ...base, isPortabilidad: true, portedNumber: null, photos: ['a', ''] })).not.toContain('PORTED_MISSING')
    expect(computeNumberAlerts({ ...base, isPortabilidad: true, portedNumber: null, photos: ['', 'url'] })).toContain('PORTED_MISSING')
    expect(computeNumberAlerts({ ...base, isPortabilidad: true, portedNumber: null, photos: [], isExternalSale: true })).toContain('PORTED_MISSING')
    expect(computeNumberAlerts({ ...base, linkingNumber: '551234567', linkingNumberSource: 'EXTERNAL_SALE' })).toContain('NOT_10_DIGITS')
    expect(computeNumberAlerts({ ...base, linkingNumber: '5512345678', linkingNumberSource: 'EXTERNAL_SALE' })).not.toContain('NOT_10_DIGITS')
    expect(computeNumberAlerts({ ...base, linkingNumber: '' })).not.toContain('NOT_10_DIGITS')
    expect(isNewerCapture({}, 'LINKING', 'constructor', 1)).toBe(true)
    expect(computeNumberAlerts({ ...base, linkingDuplicate: true, portedDuplicate: true })).toEqual(['LINKING_DUPLICATE', 'PORTED_DUPLICATE'])
  })
})
