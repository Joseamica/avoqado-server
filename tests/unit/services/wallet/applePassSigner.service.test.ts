/**
 * La firma real no se puede probar aquí: sólo un iPhone dice si Apple la acepta.
 * Lo que SÍ se prueba, y es lo que importa para no dejar el servidor tronando:
 *
 * 1. Que un servidor SIN certificado siga vivo y lo reporte, en vez de reventar
 *    al arrancar. La mayoría de los entornos (CI, la máquina de otro dev, este
 *    mismo test) no tienen certificado y no deben tener que tenerlo.
 * 2. Que el error diga QUÉ falta, no un stack de OpenSSL. Quien lo lea en
 *    producción a las 11 de la noche necesita saber qué variable poner.
 *
 * `env` se sustituye con jest.mock porque se parsea UNA vez al importarse:
 * cambiar process.env dentro del test no tendría efecto.
 */

const envMock: Record<string, string | undefined> = {}

// Captura los archivos que se le entregan a PKPass, que es lo unico que decide
// si Apple acepta el pase.
const archivosDelPase: Record<string, Buffer> = {}
jest.mock('passkit-generator', () => ({
  PKPass: jest.fn().mockImplementation((buffers: Record<string, Buffer>) => {
    for (const k of Object.keys(archivosDelPase)) delete archivosDelPase[k]
    Object.assign(archivosDelPase, buffers)
    return { getAsBuffer: async () => Buffer.from('pkpass') }
  }),
}))

jest.mock('../../../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

import { walletSigningAvailable, signPass } from '../../../../src/services/wallet/applePassSigner.service'

const COMPLETO = {
  APPLE_PASS_TYPE_ID: 'pass.io.avoqado.loyalty',
  APPLE_TEAM_ID: 'TEAM123',
  APPLE_PASS_CERT_PEM_BASE64: 'Y2VydA==',
  APPLE_PASS_KEY_PEM_BASE64: 'a2V5',
  APPLE_PASS_KEY_PASSWORD: 'x',
  APPLE_WWDR_PEM_BASE64: 'd3dkcg==',
}

function setEnv(vals: Record<string, string | undefined>) {
  for (const k of Object.keys(envMock)) delete envMock[k]
  Object.assign(envMock, vals)
}

describe('walletSigningAvailable', () => {
  it('sin nada configurado, reporta que no puede firmar', () => {
    setEnv({})
    expect(walletSigningAvailable()).toBe(false)
  })

  it('con las cinco piezas, reporta que sí', () => {
    setEnv(COMPLETO)
    expect(walletSigningAvailable()).toBe(true)
  })

  it('🔴 le falta la LLAVE y lo detecta', () => {
    // El error más fácil de cometer al configurar: exportar el certificado y
    // olvidar la llave, o pasar el mismo archivo dos veces. Sin este chequeo, el
    // fallo aparece hasta el intento de firma, con un mensaje de OpenSSL.
    setEnv({ ...COMPLETO, APPLE_PASS_KEY_PEM_BASE64: undefined })
    expect(walletSigningAvailable()).toBe(false)
  })

  it('le falta el intermedio de Apple y lo detecta', () => {
    // Sin el WWDR el pase se genera, se descarga, y el iPhone lo rechaza con
    // "no se puede leer el pase" sin decir por qué. Mejor fallar aquí.
    setEnv({ ...COMPLETO, APPLE_WWDR_PEM_BASE64: undefined })
    expect(walletSigningAvailable()).toBe(false)
  })
})

describe('signPass', () => {
  it('sin certificado da un error que dice QUÉ falta, no un stack de OpenSSL', async () => {
    setEnv({})
    await expect(signPass({})).rejects.toThrow(/certificado de Apple no está configurado/i)
    // El mensaje tiene que nombrar las variables: quien lo lea en producción
    // necesita saber qué poner, no que "algo falló".
    await expect(signPass({})).rejects.toThrow(/APPLE_PASS_CERT_PEM_BASE64/)
  })

  it('🔴 SIEMPRE incluye icon.png e icon@2x.png, o el iPhone no abre Wallet', async () => {
    setEnv(COMPLETO)

    await signPass({ formatVersion: 1 }, '#7ADD2C')

    // Este es el test que faltaba y costó una prueba en un iPhone real (25-ago).
    // Sin icon.png el pase se firma bien, la cadena de certificados valida, y el
    // telefono lo degrada a una vista previa de archivo generica SIN decir por que.
    expect(Object.keys(archivosDelPase).sort()).toEqual(['icon.png', 'icon@2x.png', 'pass.json'])
    expect(archivosDelPase['icon.png'].subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  })

  it('un negocio sin color igual recibe iconos válidos', async () => {
    setEnv(COMPLETO)

    // Caso real: "Restaurante El Atole" tiene primaryColor = "".
    await signPass({ formatVersion: 1 }, '')

    expect(archivosDelPase['icon.png']).toBeInstanceOf(Buffer)
    expect(archivosDelPase['icon.png'].length).toBeGreaterThan(50)
  })
})
