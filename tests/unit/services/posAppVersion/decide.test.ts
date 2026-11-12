import { compareVersionNames, normalizeVersionName } from '@/services/posAppVersion/version'
import { decide, isBelow } from '@/services/posAppVersion/decide'

const req = (versionCode: number | null, versionName: string | null = null) => ({
  required: { versionCode, versionName },
  recommended: null,
})
const rec = (versionCode: number | null, versionName: string | null = null) => ({
  required: null,
  recommended: { versionCode, versionName },
})

describe('decide', () => {
  it('DESKTOP siempre OK', () => {
    expect(decide('DESKTOP', { versionCode: 1 }, req(999))).toBe('OK')
  })
  it('sin política es OK', () => {
    expect(decide('ANDROID', { versionCode: 1 }, null)).toBe('OK')
  })
  it('ANDROID debajo de la obligatoria es REQUIRED', () => {
    expect(decide('ANDROID', { versionCode: 95 }, req(100))).toBe('REQUIRED')
  })
  it('ANDROID igual a la mínima es OK', () => {
    expect(decide('ANDROID', { versionCode: 100 }, req(100))).toBe('OK')
  })
  it('ANDROID entre obligatoria y recomendada es RECOMMENDED', () => {
    const policy = { required: { versionCode: 100, versionName: null }, recommended: { versionCode: 102, versionName: null } }
    expect(decide('ANDROID', { versionCode: 101 }, policy)).toBe('RECOMMENDED')
  })
  it('ANDROID igual a la recomendada es OK', () => {
    expect(decide('ANDROID', { versionCode: 102 }, rec(102))).toBe('OK')
  })
  it('iOS debajo de la obligatoria es REQUIRED', () => {
    expect(decide('IOS', { versionName: '1.15.11' }, req(null, '1.16.0'))).toBe('REQUIRED')
  })
  it('iOS 1.16 == 1.16.0 es OK', () => {
    expect(decide('IOS', { versionName: '1.16' }, req(null, '1.16.0'))).toBe('OK')
  })
  it('iOS 2 supera 1.99.99', () => {
    expect(decide('IOS', { versionName: '2' }, rec(null, '1.99.99'))).toBe('OK')
  })
  it('iOS 1.016 == 1.16', () => {
    expect(decide('IOS', { versionName: '1.016' }, req(null, '1.16'))).toBe('OK')
  })
  it('iOS sin versionName es OK', () => {
    expect(decide('IOS', {}, req(null, '1.16.0'))).toBe('OK')
  })
  it('isBelow es false si falta el campo que decide', () => {
    expect(isBelow('ANDROID', {}, { versionCode: 5, versionName: null })).toBe(false)
    expect(isBelow('ANDROID', { versionCode: 1 }, { versionCode: null, versionName: null })).toBe(false)
  })
})

describe('version', () => {
  it('compara parte por parte', () => {
    expect(compareVersionNames('1.16.0', '1.15.11')).toBe(1)
    expect(compareVersionNames('1.16', '1.16.0')).toBe(0)
    expect(compareVersionNames('1.2', '1.10')).toBe(-1)
  })
  it('lanza con nombres inválidos', () => {
    expect(() => compareVersionNames('abc', '1.0')).toThrow()
  })
  it('normalize devuelve null si no cumple', () => {
    expect(normalizeVersionName('1.2.3.4.5')).toBeNull()
    expect(normalizeVersionName('1234567')).toBeNull()
    expect(normalizeVersionName('1.16')).toEqual([1, 16, 0, 0])
  })
})
