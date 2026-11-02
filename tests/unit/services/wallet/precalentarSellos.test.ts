/**
 * El servidor abre los sellos de los negocios AL ARRANCAR, antes de recibir tráfico.
 *
 * 🔴 El defecto (medido en producción, 21-oct-2026): el caché de sellos vive en la memoria del
 * proceso, y el servidor se despliega 3-4 veces al día. Cada instancia nueva empezaba vacía, así
 * que la PRIMERA tarjeta de Apple o actualización de passkit después de cada despliegue volvía a
 * abrir el sello original (2225×2550 en Testarudo): 1.0-1.5 s de hilo congelado, y el 21-oct a las
 * 17:39 UTC, 3,088 ms — suficiente para disparar la alerta «Server congelado ≥3 s». Las siguientes
 * descargas en la misma instancia tardaban 200-470 ms.
 *
 * Lo que se prueba:
 *
 * 1. **Después de precalentar, la descarga del cliente ya no abre el sello.** Es el punto entero.
 * 2. **Nunca tumba el arranque.** Un sello roto, un fallo de red o la base caída dejan al
 *    servidor arrancar igual: la descarga del cliente lo abrirá como antes.
 * 3. **Tiene tope de tiempo.** Abrir sellos no puede retrasar sin límite que el servidor abra su
 *    puerto (en un reinicio por caída, ese retraso es tiempo fuera de servicio).
 * 4. **Va ANTES de abrir el puerto.** Si alguien lo mueve después, vuelve a pagarlo un cliente.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as pngDecodeModule from '../../../../src/services/wallet/pngDecode'
import { Canvas, hexToRgb } from '../../../../src/services/wallet/pngCanvas'
import { CACHE_SELLOS_MAX, fetchDecodedPng, limpiarCacheDeSellos } from '../../../../src/services/wallet/remotePng'
import { listarSellosAPrecalentar, precalentarSellos } from '../../../../src/services/wallet/precalentarSellos'
import { prismaMock } from '../../../__helpers__/setup'

const URL_A = 'https://storage.example/prod/venues/testarudo-cafe/wallet/stamp.png?v=1'
const URL_B = 'https://storage.example/prod/venues/amaena/wallet/stamp.png?v=2'

function pngLiso(hex: string): Buffer {
  return new Canvas(4, 4, hexToRgb(hex)).toPng()
}

/** Cada URL contesta siempre sus propios bytes, como el almacenamiento real. */
function simularAlmacen(porUrl: Record<string, Buffer>) {
  const mock = jest.fn(async (url: string) => {
    const bytes = porUrl[url]
    if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  })
  ;(global as any).fetch = mock
  return mock
}

describe('precalentarSellos — la primera descarga tras un despliegue ya no abre el sello', () => {
  beforeEach(() => {
    limpiarCacheDeSellos()
    jest.restoreAllMocks()
  })

  it('🔴 después de precalentar, la tarjeta del cliente NO vuelve a abrir el sello', async () => {
    simularAlmacen({ [URL_A]: pngLiso('#FF6600'), [URL_B]: pngLiso('#0066FF') })
    const abrir = jest.spyOn(pngDecodeModule, 'decodePng')

    const resultado = await precalentarSellos({ listar: async () => [URL_A, URL_B] })
    expect(resultado).toMatchObject({ abiertos: 2, fallidos: 0, omitidos: 0 })
    expect(abrir).toHaveBeenCalledTimes(2)

    // Lo que hace la descarga de Apple, de passkit o de Google: el mismo fetchDecodedPng.
    expect(await fetchDecodedPng(URL_A)).not.toBeNull()
    expect(await fetchDecodedPng(URL_B)).not.toBeNull()
    expect(abrir).toHaveBeenCalledTimes(2)
  })

  it('una URL repetida se abre una sola vez', async () => {
    const abrirSello = jest.fn(async () => ({ width: 1, height: 1, pixels: Buffer.alloc(4) }))

    const resultado = await precalentarSellos({ listar: async () => [URL_A, URL_A, URL_B], abrir: abrirSello })

    expect(abrirSello).toHaveBeenCalledTimes(2)
    expect(resultado.abiertos).toBe(2)
  })

  it('un sello roto o que lanza NO detiene a los demás, y el arranque nunca recibe una excepción', async () => {
    const abrirSello = jest
      .fn()
      .mockRejectedValueOnce(new Error('se cayó la red'))
      .mockResolvedValueOnce(null) // un archivo que no abre
      .mockResolvedValueOnce({ width: 1, height: 1, pixels: Buffer.alloc(4) })

    const resultado = await precalentarSellos({ listar: async () => ['u1', 'u2', 'u3'], abrir: abrirSello })

    expect(abrirSello).toHaveBeenCalledTimes(3)
    expect(resultado).toMatchObject({ abiertos: 1, fallidos: 2, omitidos: 0 })
  })

  it('si la base no contesta, el servidor arranca igual (sin sellos precalentados)', async () => {
    const abrirSello = jest.fn()

    const resultado = await precalentarSellos({
      listar: async () => {
        throw new Error('connection refused')
      },
      abrir: abrirSello,
    })

    expect(abrirSello).not.toHaveBeenCalled()
    expect(resultado).toMatchObject({ abiertos: 0, fallidos: 0, omitidos: 0 })
  })

  it('🔴 una base que no contesta tampoco detiene el arranque: se deja de esperar en el tope (Codex, 2-nov)', async () => {
    const abrir = jest.fn()
    const resultado = await precalentarSellos({ listar: () => new Promise<string[]>(() => undefined), abrir, topeMs: 10 })
    expect(abrir).not.toHaveBeenCalled()
    expect(resultado.abiertos).toBe(0)
  })

  it('🔴 un negocio demo no se precalienta: su dirección la escribe cualquiera (Codex, 2-nov)', async () => {
    prismaMock.walletCardDesign.findMany.mockResolvedValue([] as any)
    await listarSellosAPrecalentar()
    expect(prismaMock.walletCardDesign.findMany.mock.calls[0][0]?.where).toEqual({
      stampImageUrl: { not: null },
      venue: { status: { not: 'LIVE_DEMO' } },
    })
  })

  it('🔴 respeta el tope de tiempo: deja de abrir sellos y avisa cuántos quedaron', async () => {
    let reloj = 0
    const abrirSello = jest.fn(async () => {
      reloj += 600 // cada sello «tarda» 600 ms
      return { width: 1, height: 1, pixels: Buffer.alloc(4) }
    })

    const resultado = await precalentarSellos({
      listar: async () => ['u1', 'u2', 'u3', 'u4'],
      abrir: abrirSello,
      topeMs: 1000,
      ahoraMs: () => reloj,
    })

    // u1 (0 → 600) y u2 (600 → 1200) empiezan dentro del tope; u3 ya no.
    expect(abrirSello).toHaveBeenCalledTimes(2)
    expect(resultado).toMatchObject({ abiertos: 2, omitidos: 2 })
  })
})

describe('listarSellosAPrecalentar — qué sellos se preparan', () => {
  it('sólo diseños con sello, con tope (nunca una consulta sin take), los más recientes primero', async () => {
    prismaMock.walletCardDesign.findMany.mockResolvedValue([
      { stampImageUrl: URL_A },
      { stampImageUrl: URL_B },
      { stampImageUrl: URL_A },
    ] as any)

    const urls = await listarSellosAPrecalentar()

    expect(urls).toEqual([URL_A, URL_B])
    const consulta = prismaMock.walletCardDesign.findMany.mock.calls[0][0] as any
    expect(consulta.where).toEqual({ stampImageUrl: { not: null }, venue: { status: { not: 'LIVE_DEMO' } } })
    expect(consulta.take).toBe(CACHE_SELLOS_MAX)
    expect(consulta.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }])
  })
})

describe('server.ts — los sellos se preparan ANTES de abrir el puerto', () => {
  it('🔴 precalentarSellos() se espera antes de listenWithRetry()', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../../../src/server.ts'), 'utf8')
    const precalentar = server.indexOf('await precalentarSellos(')
    const escuchar = server.indexOf('listenWithRetry()\n')

    expect(precalentar).toBeGreaterThan(-1)
    expect(escuchar).toBeGreaterThan(-1)
    expect(precalentar).toBeLessThan(escuchar)
  })
})
