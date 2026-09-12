/**
 * La CACHÉ del interruptor por venue (`terminal-payment-strictness.ts`).
 *
 * 🔴 Por qué merece pruebas propias, y por qué no las tenía (hallazgo P2-2 de la auditoría de Fable, 11-sep):
 * la consulta está EN el camino del dinero —admisión de un cobro, cancelación de una orden, selector de
 * terminales— y decide QUÉ RÉGIMEN aplica. Un fallo suyo no se ve como error: se ve como una terminal que
 * bloquea cuando no debía, o —peor— que deja de bloquear cuando sí debía. El arreglo de la carrera de
 * `invalidarVenuesEstrictos` se había dado por bueno sin una prueba que lo viera fallar antes.
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import {
  __resetVenuesEstrictosParaPruebas,
  getVenuesEstrictos,
  invalidarVenuesEstrictos,
  primeVenuesEstrictos,
} from '@/services/terminal-payment-strictness'

const venueFindMany = prisma.venue.findMany as unknown as jest.Mock

const CORTE = new Date('2026-09-20T00:00:00.000Z')
const OTRO_CORTE = new Date('2026-09-25T00:00:00.000Z')

beforeEach(() => {
  __resetVenuesEstrictosParaPruebas()
  venueFindMany.mockReset()
  jest.useRealTimers()
})

describe('la lectura NUNCA espera y NUNCA lanza', () => {
  it('P1 antes del primer prime devuelve el mapa VACÍO — o sea, el régimen HEREDADO (el de producción)', () => {
    venueFindMany.mockResolvedValue([])
    // Síncrona: si algún día devolviera una promesa, un cobro quedaría esperando a una consulta de configuración.
    expect(getVenuesEstrictos().size).toBe(0)
  })

  it('P1 un fallo de la base NO lanza y CONSERVA la lista anterior (nunca la vacía)', async () => {
    venueFindMany.mockResolvedValueOnce([{ id: 'v1', terminalPaymentStrictSince: CORTE }])
    await primeVenuesEstrictos()
    expect(getVenuesEstrictos().get('v1')).toEqual(CORTE)

    venueFindMany.mockRejectedValueOnce(new Error('P1001: no se pudo alcanzar la base'))
    await invalidarVenuesEstrictos()

    // 🔴 Vaciarla habría bajado a ese venue al régimen heredado sin que nadie lo pidiera: un venue ya migrado
    // dejaría de aplicar su lista blanca por un bache de red.
    expect(getVenuesEstrictos().get('v1')).toEqual(CORTE)
  })

  it('P1 tras un fallo NO se relanza la lectura en cada cobro: hay un respiro corto', async () => {
    // Sin respiro, con la base caída CADA consulta —o sea, cada cobro— relanzaba la lectura y otro 🚨.
    // Justo cuando la base sufre, la observabilidad no puede ser quien la remate.
    venueFindMany.mockRejectedValue(new Error('base caída'))
    await primeVenuesEstrictos()
    expect(venueFindMany).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) getVenuesEstrictos() // 20 cobros seguidos
    expect(venueFindMany).toHaveBeenCalledTimes(1)
  })

  it('P1 el arranque distingue «no hay ninguno» de «no pude saberlo»', async () => {
    venueFindMany.mockResolvedValueOnce([])
    expect(await primeVenuesEstrictos()).toBe(0) // de verdad no hay ninguno

    __resetVenuesEstrictosParaPruebas()
    venueFindMany.mockRejectedValueOnce(new Error('base caída'))
    // 🔴 `0` aquí imprimiría «✅ 0 venue(s) en modo estricto» encima de un fallo: la forma exacta de un verde falso.
    expect(await primeVenuesEstrictos()).toBeNull()
  })

  it('un fallo grita 🚨 con el token que machea la regla de Better Stack', async () => {
    const err = jest.spyOn(logger, 'error')
    venueFindMany.mockRejectedValueOnce(new Error('boom'))
    await primeVenuesEstrictos()
    expect(err).toHaveBeenCalledWith(expect.stringContaining('🚨 [terminal-payment strictness]'), expect.objectContaining({ cargadoAlgunaVez: false }))
    err.mockRestore()
  })
})

describe('qué venues entran a la lista', () => {
  it('P1 sólo los ENCENDIDOS y con corte: apagar conserva la fecha, así que la fecha sola no basta', async () => {
    venueFindMany.mockResolvedValue([])
    await primeVenuesEstrictos()
    const where = venueFindMany.mock.calls[0][0].where
    // Se prueba la FORMA de la consulta: con `terminalPaymentStrictSince` a secas, un venue APAGADO que
    // conserva su corte volvería a aplicar el régimen estricto sin que nadie lo encendiera.
    expect(where).toMatchObject({ terminalPaymentStrictEnabled: true, terminalPaymentStrictSince: { not: null } })
  })

  it('la consulta lleva tope (regla de consultas acotadas)', async () => {
    venueFindMany.mockResolvedValue([])
    await primeVenuesEstrictos()
    expect(venueFindMany.mock.calls[0][0].take).toBeGreaterThan(0)
  })
})

describe('P1 invalidar: la marcha atrás tiene que verse ENSEGUIDA', () => {
  it('🔴 espera a una lectura que empezó DESPUÉS del cambio, no a la que ya estaba en vuelo', async () => {
    // Este es el defecto que encontró Codex y que esta prueba no existía para guardar. La secuencia real:
    // un cobro dispara el refresco perezoso (lectura A, con el valor VIEJO); mientras A viaja, el operador
    // apaga el interruptor y llama a `invalidarVenuesEstrictos`. Si se enganchara a A, `await` volvería con
    // el mapa anterior y el apagado —la marcha atrás— no surtiría efecto.
    let resolverA!: (v: unknown) => void
    const A = new Promise(res => (resolverA = res))
    venueFindMany
      .mockImplementationOnce(() => A) // lectura A: empezó ANTES del apagado
      .mockResolvedValueOnce([]) // lectura B: la que de verdad ve el apagado

    void getVenuesEstrictos() // dispara A
    const invalidacion = invalidarVenuesEstrictos()
    resolverA([{ id: 'v1', terminalPaymentStrictSince: CORTE }]) // A trae el valor VIEJO
    await invalidacion

    expect(venueFindMany).toHaveBeenCalledTimes(2)
    expect(getVenuesEstrictos().size).toBe(0) // manda B: el venue quedó apagado
  })

  it('sin lecturas en vuelo, invalidar lee una sola vez', async () => {
    venueFindMany.mockResolvedValue([{ id: 'v1', terminalPaymentStrictSince: OTRO_CORTE }])
    await invalidarVenuesEstrictos()
    expect(venueFindMany).toHaveBeenCalledTimes(1)
    expect(getVenuesEstrictos().get('v1')).toEqual(OTRO_CORTE)
  })

  it('N cobros simultáneos causan UNA consulta (el camino del dinero no paga N viajes)', async () => {
    let resolver!: (v: unknown) => void
    venueFindMany.mockImplementationOnce(() => new Promise(res => (resolver = res)))
    const espera = [primeVenuesEstrictos(), primeVenuesEstrictos(), primeVenuesEstrictos()]
    resolver([])
    await Promise.all(espera)
    expect(venueFindMany).toHaveBeenCalledTimes(1)
  })
})
