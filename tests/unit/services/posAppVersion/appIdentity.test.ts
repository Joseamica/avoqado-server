import { readHomeAppIdentity } from '../../../../src/services/posAppVersion/appIdentity'

// Actualizador del POS (r7, spec §4.7.3): de qué app viene la petición del inicio. Sólo con esto el inicio sabe si le toca
// el aviso de actualizar. Ante la duda (sin cabeceras, WINDOWS, campo ilegible) contesta null: nunca se enseña el aviso.
describe('readHomeAppIdentity — la app que pide el inicio', () => {
  // ===== CASOS NUEVOS =====
  it('ANDROID con su número de compilación', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-app-version-code': '95' })).toEqual({
      platform: 'ANDROID',
      versionCode: 95,
    })
  })

  it('iOS con su nombre de versión', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'IOS', 'x-app-version': '1.15.11' })).toEqual({
      platform: 'IOS',
      versionName: '1.15.11',
    })
  })

  it('la plataforma se lee sin importar mayúsculas ni espacios', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': ' android ', 'x-app-version-code': '95' })).toEqual({
      platform: 'ANDROID',
      versionCode: 95,
    })
  })

  it('sin cabeceras (el DASHBOARD) → null', () => {
    expect(readHomeAppIdentity({})).toBeNull()
    expect(readHomeAppIdentity(undefined)).toBeNull()
  })

  // 🔴 WINDOWS puede mandar ANDROID (posSinSoloSaldo.ts:8): la forma DESKTOP lo saca, sin importar mayúsculas.
  it('con x-device-form-factor DESKTOP → null, aunque diga ANDROID', () => {
    expect(
      readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-device-form-factor': 'DESKTOP', 'x-app-version-code': '95' }),
    ).toBeNull()
    expect(
      readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-device-form-factor': 'desktop', 'x-app-version-code': '95' }),
    ).toBeNull()
  })

  it('una forma repetida que incluye DESKTOP también → null', () => {
    expect(
      readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-device-form-factor': 'TABLET, DESKTOP', 'x-app-version-code': '95' }),
    ).toBeNull()
    expect(
      readHomeAppIdentity({
        'x-device-platform': 'ANDROID',
        'x-device-form-factor': ['TABLET', 'DESKTOP'] as unknown as string,
        'x-app-version-code': '95',
      }),
    ).toBeNull()
  })

  // 🔴 La señal real del WINDOWS: su shim de `android.os.Build` (avoqado-android/desktop/plataforma/.../android/os/Build.java)
  // fija MANUFACTURER = "Avoqado" y MODEL = el nombre del sistema («Windows 11»), y viajan como x-device-manufacturer y
  // x-device-model, aunque la plataforma diga ANDROID y la forma TABLET o PHONE.
  describe('el WINDOWS, que manda ANDROID', () => {
    const android95 = { 'x-device-platform': 'ANDROID', 'x-device-form-factor': 'TABLET', 'x-app-version-code': '95' }

    it('con x-device-manufacturer «Avoqado» → null', () => {
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'Avoqado', 'x-device-model': 'Windows 11' })).toBeNull()
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'Avoqado' })).toBeNull()
    })

    it('con x-device-manufacturer «avoqado » (mayúsculas y espacios) → null', () => {
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'avoqado ' })).toBeNull()
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': ' AVOQADO' })).toBeNull()
    })

    it('con x-device-model que empieza con «Windows» → null', () => {
      expect(readHomeAppIdentity({ ...android95, 'x-device-model': 'Windows 11' })).toBeNull()
      expect(readHomeAppIdentity({ ...android95, 'x-device-model': ' windows 10' })).toBeNull()
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'Dell', 'x-device-model': 'WINDOWS SERVER 2022' })).toBeNull()
    })

    it('un ANDROID real («samsung», «SM-X710») sigue teniendo su identidad', () => {
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'samsung', 'x-device-model': 'SM-X710' })).toEqual({
        platform: 'ANDROID',
        versionCode: 95,
      })
    })

    it('un modelo que sólo CONTIENE «windows» no es el WINDOWS: sigue teniendo su identidad', () => {
      expect(readHomeAppIdentity({ ...android95, 'x-device-manufacturer': 'SUNMI', 'x-device-model': 'T2-windowsless' })).toEqual({
        platform: 'ANDROID',
        versionCode: 95,
      })
    })
  })

  it('con x-device-platform DESKTOP → null', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'DESKTOP', 'x-app-version-code': '95' })).toBeNull()
    expect(readHomeAppIdentity({ 'x-device-platform': 'desktop', 'x-app-version': '1.15.11' })).toBeNull()
  })

  it('con una plataforma desconocida → null', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'WEB', 'x-app-version-code': '95' })).toBeNull()
  })

  it('una plataforma repetida es ambigua → null', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': ['ANDROID', 'IOS'] as unknown as string, 'x-app-version-code': '95' })).toBeNull()
  })

  it('ANDROID sin x-app-version-code → null (el nombre no decide en ANDROID)', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-app-version': '2.25.26' })).toBeNull()
  })

  it('ANDROID con un número ilegible → null', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-app-version-code': '95a' })).toBeNull()
    expect(readHomeAppIdentity({ 'x-device-platform': 'ANDROID', 'x-app-version-code': '0' })).toBeNull()
  })

  it('iOS sin x-app-version → null (el número no decide en iOS)', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'IOS', 'x-app-version-code': '41' })).toBeNull()
  })

  it('iOS con un nombre que no cumple el formato → null', () => {
    expect(readHomeAppIdentity({ 'x-device-platform': 'IOS', 'x-app-version': '1.15.11 (41)' })).toBeNull()
    expect(readHomeAppIdentity({ 'x-device-platform': 'IOS', 'x-app-version': 'v1.15' })).toBeNull()
    expect(readHomeAppIdentity({ 'x-device-platform': 'IOS', 'x-app-version': '' })).toBeNull()
  })

  // ===== REGRESION =====
  it('nunca lanza, aunque las cabeceras traigan cualquier cosa', () => {
    const raras = [
      { 'x-device-platform': 123 as unknown as string },
      { 'x-device-platform': 'IOS', 'x-app-version': 42 as unknown as string },
      { 'x-device-platform': null as unknown as string, 'x-device-form-factor': {} as unknown as string },
    ]
    for (const h of raras) expect(() => readHomeAppIdentity(h)).not.toThrow()
  })
})
