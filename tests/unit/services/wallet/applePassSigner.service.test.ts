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

// Captura los archivos que se le entregan al hilo que arma el pase (D5: PKPass corre allá),
// que es lo unico que decide si Apple acepta el pase. La firma real se prueba en applePassSigner.hilo.test.ts.
const archivosDelPase: Record<string, Buffer> = {}
// Para la prueba del tope: con `retener`, cada hilo espera a que la prueba lo suelte.
const mockHilos = {
  abiertos: 0,
  vivos: 0,
  maxVivos: 0,
  retener: false,
  soltar: [] as Array<() => void>,
  // Con `cierreLento`, terminate() tarda: el hilo sigue vivo hasta que la prueba lo cierra (Codex D5 r1 P2).
  cierreLento: false,
  cerrar: [] as Array<() => void>,
}
jest.mock('node:worker_threads', () => {
  const { EventEmitter } = jest.requireActual('node:events')
  class HiloFalso extends EventEmitter {
    constructor(_archivo: string, opciones: { workerData: { archivos: Record<string, Buffer> } }) {
      super()
      for (const k of Object.keys(archivosDelPase)) delete archivosDelPase[k]
      Object.assign(archivosDelPase, opciones.workerData.archivos)
      mockHilos.abiertos++
      mockHilos.vivos++
      mockHilos.maxVivos = Math.max(mockHilos.maxVivos, mockHilos.vivos)
      const contestar = () => this.emit('message', { ok: true, bytes: new Uint8Array(Buffer.from('pkpass')).buffer })
      if (mockHilos.retener) mockHilos.soltar.push(contestar)
      else queueMicrotask(contestar)
    }
    terminate() {
      return new Promise<number>(r => {
        const morir = () => {
          mockHilos.vivos--
          this.emit('exit', 0)
          r(0)
        }
        if (mockHilos.cierreLento) mockHilos.cerrar.push(morir)
        else morir()
      })
    }
  }
  return { Worker: HiloFalso, isMainThread: true, parentPort: null, workerData: null }
})

jest.mock('../../../../src/config/env', () => ({
  get env() {
    return envMock
  },
}))

import {
  walletSigningAvailable,
  signPass,
  FIRMAS_A_LA_VEZ,
  FIRMAS_EN_ESPERA_MAX,
  ESPERA_DE_FIRMA_MS,
  FIRMA_TIMEOUT_MS,
} from '../../../../src/services/wallet/applePassSigner.service'

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

    await signPass({ formatVersion: 1 }, { brandColor: '#7ADD2C' })

    // Este es el test que faltaba y costó una prueba en un iPhone real (25-ago).
    // Sin icon.png el pase se firma bien, la cadena de certificados valida, y el
    // telefono lo degrada a una vista previa de archivo generica SIN decir por que.
    expect(Object.keys(archivosDelPase).sort()).toEqual(['icon.png', 'icon@2x.png', 'logo.png', 'logo@2x.png', 'pass.json'])
    expect(archivosDelPase['icon.png'].subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })

  it('🔴 con sellos, incluye la banda en sus dos tamaños', async () => {
    setEnv(COMPLETO)

    await signPass({ formatVersion: 1 }, { brandColor: '#7ADD2C', stamps: { earned: 3, required: 10 } })

    // La banda es lo que hace que la tarjeta se reconozca como cartilla de sellos.
    // Sin @2x se ve pixeleada en cualquier iPhone de los últimos diez años.
    expect(Object.keys(archivosDelPase).sort()).toEqual([
      'icon.png',
      'icon@2x.png',
      'logo.png',
      'logo@2x.png',
      'pass.json',
      'strip.png',
      'strip@2x.png',
    ])
  })

  it('sin sellos, el pase sale sin banda en vez de con una vacía', async () => {
    setEnv(COMPLETO)

    await signPass({ formatVersion: 1 }, { brandColor: '#7ADD2C' })

    expect(Object.keys(archivosDelPase)).not.toContain('strip.png')
  })

  it('🔴 el logo va BLANQUEADO: el original desaparece sobre el fondo verde', async () => {
    setEnv(COMPLETO)

    await signPass({ formatVersion: 1 }, { brandColor: '#7ADD2C' })

    // El isotipo original es verde y el fondo de la tarjeta tambien: sobre la
    // tarjeta desaparecia entero y solo sobrevivia el punto naranja. Se ve
    // mirando la tarjeta, no leyendo el codigo.
    const logo = archivosDelPase['logo.png']
    expect(logo.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(logo.length).toBeGreaterThan(1000)
  })

  it('un negocio sin color igual recibe iconos válidos', async () => {
    setEnv(COMPLETO)

    // Caso real: "Restaurante El Atole" tiene primaryColor = "".
    await signPass({ formatVersion: 1 }, { brandColor: '' })

    expect(archivosDelPase['icon.png']).toBeInstanceOf(Buffer)
    expect(archivosDelPase['icon.png'].length).toBeGreaterThan(50)
  })
})

describe('tope de hilos de firma (D5)', () => {
  const vuelta = () => new Promise(r => setImmediate(r))
  const vueltas = async (n = 20) => {
    for (let i = 0; i < n; i++) await vuelta()
  }
  beforeEach(() => {
    setEnv(COMPLETO)
    Object.assign(mockHilos, { abiertos: 0, vivos: 0, maxVivos: 0, retener: false, soltar: [], cierreLento: false, cerrar: [] })
  })

  it('una ráfaga nunca tiene más de FIRMAS_A_LA_VEZ hilos VIVOS, aunque cerrarlos tarde, y todas salen', async () => {
    mockHilos.retener = true
    mockHilos.cierreLento = true
    const pedidos = Array.from({ length: 5 }, () => signPass({ formatVersion: 1 }, { brandColor: '#123456' }))
    await vueltas()
    expect(mockHilos.abiertos).toBe(FIRMAS_A_LA_VEZ)

    while (mockHilos.soltar.length || mockHilos.cerrar.length) {
      mockHilos.soltar.shift()?.()
      await vueltas()
      // Mientras el hilo que ya contestó no termine de cerrarse, no entra otro.
      expect(mockHilos.maxVivos).toBeLessThanOrEqual(FIRMAS_A_LA_VEZ)
      mockHilos.cerrar.shift()?.()
      await vueltas()
    }
    const pases = await Promise.all(pedidos)
    expect(pases.map(p => p.toString())).toEqual(Array(5).fill('pkpass'))
    expect(mockHilos.abiertos).toBe(5)
    expect(mockHilos.maxVivos).toBe(FIRMAS_A_LA_VEZ)
  })

  it('la fila tiene tope: el que llega con la fila llena recibe «ocupado» (503) al momento, sin preparar nada', async () => {
    mockHilos.retener = true
    const capacidad = FIRMAS_A_LA_VEZ + FIRMAS_EN_ESPERA_MAX
    const pedidos = Array.from({ length: capacidad }, () => signPass({ formatVersion: 1 }, { brandColor: '#123456' }))
    await vueltas()
    await expect(signPass({ formatVersion: 1 }, { brandColor: '#123456' })).rejects.toMatchObject({ statusCode: 503 })
    expect(mockHilos.abiertos).toBe(FIRMAS_A_LA_VEZ)

    mockHilos.retener = false
    while (mockHilos.soltar.length) {
      mockHilos.soltar.shift()!()
      await vueltas()
    }
    await expect(Promise.all(pedidos)).resolves.toHaveLength(capacidad)
  })

  it('quien espera su turno más de ESPERA_DE_FIRMA_MS se rinde con «ocupado» y no se queda en la fila', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] })
    try {
      mockHilos.retener = true
      // Se les pone el `catch` desde ya: vencen dentro del mismo avance de reloj.
      const ocupando = Array.from({ length: FIRMAS_A_LA_VEZ }, () =>
        signPass({ formatVersion: 1 }, { brandColor: '#123456' }).then(
          () => 'firmó',
          (e: Error) => e,
        ),
      )
      await vueltas()
      const esperando = signPass({ formatVersion: 1 }, { brandColor: '#123456' })
      const resultado = esperando.catch(e => e)
      await vueltas()
      jest.advanceTimersByTime(ESPERA_DE_FIRMA_MS + 1)
      await vueltas()
      expect(await resultado).toMatchObject({ statusCode: 503 })

      // Los que ocupaban el turno también vencen su propio plazo de 20 s, y el que se rindió nunca abrió hilo.
      await vueltas()
      const fin = await Promise.all(ocupando)
      expect(fin.every(r => r instanceof Error)).toBe(true)
      expect(mockHilos.abiertos).toBe(FIRMAS_A_LA_VEZ)
      mockHilos.soltar.length = 0
    } finally {
      jest.useRealTimers()
    }
  })

  it('al pasar el turno al siguiente, un recién llegado no se cuela: nunca 3 hilos vivos (Codex r2 P1)', async () => {
    // El recién llegado (D) entra en distintos momentos del relevo de A hacia C.
    for (let k = 0; k < 8; k++) {
      Object.assign(mockHilos, { abiertos: 0, vivos: 0, maxVivos: 0, retener: true, soltar: [], cierreLento: false, cerrar: [] })
      const pedidos = Array.from({ length: 3 }, () => signPass({ formatVersion: 1 }, { brandColor: '#123456' }))
      await vueltas()
      mockHilos.soltar.shift()!()
      for (let i = 0; i < k; i++) await Promise.resolve()
      pedidos.push(signPass({ formatVersion: 1 }, { brandColor: '#123456' }))
      await vueltas()
      expect(mockHilos.maxVivos).toBeLessThanOrEqual(FIRMAS_A_LA_VEZ)
      mockHilos.retener = false
      while (mockHilos.soltar.length) {
        mockHilos.soltar.shift()!()
        await vueltas()
      }
      await Promise.all(pedidos)
      expect(mockHilos.maxVivos).toBeLessThanOrEqual(FIRMAS_A_LA_VEZ)
    }
  })

  it('si el hilo no termina de cerrarse, el pedido igual contesta al vencer su plazo y el turno sigue apartado (Codex r2 P2)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'] })
    try {
      mockHilos.retener = true
      mockHilos.cierreLento = true
      const pedidos = Array.from({ length: FIRMAS_A_LA_VEZ }, () =>
        signPass({ formatVersion: 1 }, { brandColor: '#123456' }).then(
          () => 'firmó',
          (e: Error) => e,
        ),
      )
      await vueltas()
      jest.advanceTimersByTime(FIRMA_TIMEOUT_MS + 1)
      await vueltas()
      // Contestaron (con error) aunque sus hilos sigan sin cerrar.
      const respuestas = await Promise.all(pedidos)
      expect(respuestas.every(r => r instanceof Error)).toBe(true)

      // El turno sigue apartado: uno nuevo espera en vez de abrir un tercer hilo.
      const nuevo = signPass({ formatVersion: 1 }, { brandColor: '#123456' })
      await vueltas()
      expect(mockHilos.abiertos).toBe(FIRMAS_A_LA_VEZ)

      // Al cerrar de verdad un hilo, el nuevo entra.
      mockHilos.retener = false
      mockHilos.cierreLento = false
      mockHilos.cerrar.shift()!()
      await vueltas()
      expect(mockHilos.abiertos).toBe(FIRMAS_A_LA_VEZ + 1)
      await expect(nuevo).resolves.toEqual(Buffer.from('pkpass'))
      mockHilos.cerrar.shift()?.()
    } finally {
      jest.useRealTimers()
    }
  })
})
