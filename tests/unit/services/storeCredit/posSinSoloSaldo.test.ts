/**
 * D1 (hz:130a3725:D1): ¿el POS que llama es una app publicada que no sabe de «Sólo saldo a favor»? ANDROID (y WINDOWS, que manda
 * ANDROID) hasta el build 95 que inyecta Play (etiqueta v2.25.26-95, no el 66 de `app/build.gradle.kts`), iOS hasta el 41; sin
 * cabeceras, con una plataforma sin corte o con una versión ilegible, cuenta como vieja.
 */
import { esPosSinSoloSaldo } from '@/services/storeCredit/posSinSoloSaldo'

const pos = (platform?: string, versionCode?: string) => ({
  ...(platform === undefined ? {} : { 'x-device-platform': platform }),
  ...(versionCode === undefined ? {} : { 'x-app-version-code': versionCode }),
})

it.each([
  ['ANDROID', '66', true],
  ['ANDROID', '95', true],
  ['ANDROID', '96', false],
  ['IOS', '41', true],
  ['IOS', '42', false],
  ['android', '96', false], // la plataforma se lee sin importar mayúsculas, igual que el registro de aparatos
  ['DESKTOP', '500', true], // una plataforma sin corte conocido
  ['WEB', '500', true],
  ['ANDROID', 'abc', true],
  ['ANDROID', '96.1', true],
  ['ANDROID', undefined, true],
  [undefined, '96', true],
] as const)('%s build %s → vieja: %s', (platform, versionCode, vieja) => {
  expect(esPosSinSoloSaldo(pos(platform, versionCode))).toBe(vieja)
})

it('sin cabeceras → vieja', () => {
  expect(esPosSinSoloSaldo({})).toBe(true)
  expect(esPosSinSoloSaldo(undefined)).toBe(true)
})
