import { DEVICE_MENUS_MIN_APP_VERSION, appliesDeviceMenus } from '@/services/devices/deviceMenusAppVersion'

describe('appliesDeviceMenus (qué app ya aplica el menú del aparato)', () => {
  const original = { ...DEVICE_MENUS_MIN_APP_VERSION }
  afterEach(() => Object.assign(DEVICE_MENUS_MIN_APP_VERSION, original))

  it('prefijoNumericoConSufijo: 2.25.24-escritorio y 2.25.24-dev valen 2.25.24', () => {
    DEVICE_MENUS_MIN_APP_VERSION.POS_ANDROID = '2.25.24'
    DEVICE_MENUS_MIN_APP_VERSION.POS_DESKTOP = '2.25.24'
    expect(appliesDeviceMenus('POS_DESKTOP', '2.25.24-escritorio')).toBe(true)
    expect(appliesDeviceMenus('POS_ANDROID', '2.25.24-dev')).toBe(true)
    expect(appliesDeviceMenus('POS_ANDROID', '2.25.23-dev')).toBe(false)
    expect(appliesDeviceMenus('POS_ANDROID', 'v2.25.24')).toBe(false) // sin prefijo numérico no se adivina
  })

  it('minimaNullEsNoAplica: ninguna app lo aplica todavía', () => {
    expect(DEVICE_MENUS_MIN_APP_VERSION).toEqual({ POS_ANDROID: null, POS_IOS: null, POS_DESKTOP: null })
    expect(appliesDeviceMenus('POS_ANDROID', '9.9.9')).toBe(false)
    expect(appliesDeviceMenus('POS_IOS', '9.9.9')).toBe(false)
    // Un tipo que no es POS_* nunca lo aplica.
    expect(appliesDeviceMenus('TPV_ANDROID', '9.9.9')).toBe(false)
  })

  it('versionNullEsNoAplica', () => {
    DEVICE_MENUS_MIN_APP_VERSION.POS_IOS = '1.13.0'
    expect(appliesDeviceMenus('POS_IOS', null)).toBe(false)
    expect(appliesDeviceMenus('POS_IOS', '')).toBe(false)
  })

  it('igualOMayorAplica: compara número por número, no como texto', () => {
    DEVICE_MENUS_MIN_APP_VERSION.POS_IOS = '1.13.2'
    expect(appliesDeviceMenus('POS_IOS', '1.13.2')).toBe(true)
    expect(appliesDeviceMenus('POS_IOS', '1.13.10')).toBe(true) // como texto «1.13.10» < «1.13.2»
    expect(appliesDeviceMenus('POS_IOS', '1.14.0')).toBe(true)
    expect(appliesDeviceMenus('POS_IOS', '2.0.0')).toBe(true)
    expect(appliesDeviceMenus('POS_IOS', '1.13.1')).toBe(false)
    expect(appliesDeviceMenus('POS_IOS', '1.9.99')).toBe(false)
  })
})
