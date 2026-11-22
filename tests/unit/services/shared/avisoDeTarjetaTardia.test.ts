/**
 * D7 (encargo a25cd7): en Pago rápido, toda tarjeta que llega aprobada TARDE (≥ 1 min después de su intento) deja
 * `LATE_CARD_RECORDED` para que el dueño revise si esa venta se cobró de otra forma. A propósito NO se empareja con un efectivo.
 * Nunca toca el cobro. El recorrido contra Postgres vive en `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`.
 */
import logger from '@/config/logger'
import {
  ACCION_TARJETA_CONFIRMADA_TARDE,
  horaDelIntentoParaGuardar,
  leerHoraDelIntento,
  revisarTarjetaTardia,
} from '@/services/shared/avisoDeTarjetaTardia'
import prisma from '@/utils/prismaClient'

const buscarRastro = prisma.activityLog.findFirst as jest.Mock
const buscarPagos = prisma.payment.findMany as jest.Mock
const escribir = prisma.activityLog.create as jest.Mock
const candado = prisma.$queryRaw as jest.Mock
const LLEGADA = new Date('2026-11-22T18:00:00.000Z')
const MIN = 60_000
const INTENTO = LLEGADA.getTime() - 10 * MIN
const TARJETA = {
  id: 'pTarjeta',
  venueId: 'v1',
  orderId: 'oTarjeta',
  terminalId: 't1',
  method: 'CREDIT_CARD',
  status: 'COMPLETED',
  amount: 100,
  tipAmount: 10,
  createdAt: LLEGADA,
  processorData: { cardBrand: 'VISA', intentoAbiertoEn: INTENTO },
  processedById: 's1',
}
const gritos = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨 [Tarjeta tardía]'))

beforeEach(() => {
  jest.clearAllMocks()
  buscarRastro.mockResolvedValue(null)
})

describe('revisarTarjetaTardia', () => {
  it('tarjeta tardía ⇒ UN rastro con la terminal, el importe y cuánto tardó; sin buscar ningún efectivo', async () => {
    await revisarTarjetaTardia(TARJETA)
    expect(candado).toHaveBeenCalledTimes(1)
    expect(String(candado.mock.calls[0][0].join('?'))).toContain('pg_advisory_xact_lock')
    expect(candado.mock.calls[0][1]).toBe('late-card-recorded:pTarjeta')
    expect(escribir).toHaveBeenCalledWith({
      data: {
        action: ACCION_TARJETA_CONFIRMADA_TARDE,
        entity: 'Payment',
        entityId: 'pTarjeta',
        venueId: 'v1',
        staffId: 's1',
        data: {
          paymentId: 'pTarjeta',
          orderId: 'oTarjeta',
          terminalId: 't1',
          amount: 100,
          tipAmount: 10,
          attemptStartedAt: new Date(INTENTO).toISOString(),
          recordedAt: LLEGADA.toISOString(),
          minutesLate: 10,
        },
      },
    })
    expect(gritos()).toHaveLength(1)
    expect(buscarPagos).not.toHaveBeenCalled()
  })

  it('ya hay rastro de esta tarjeta (reintento con su llave, o dos a la vez: el candado las forma) ⇒ no se repite', async () => {
    buscarRastro.mockResolvedValue({ id: 'ya' })
    await revisarTarjetaTardia(TARJETA)
    expect(escribir).not.toHaveBeenCalled()
    expect(gritos()).toEqual([])
  })

  it.each([
    ['TPV vieja: sin la hora del intento', { processorData: { cardBrand: 'VISA' } }],
    ['sin processorData', { processorData: null }],
    ['hora ilegible', { processorData: { intentoAbiertoEn: 'ayer' } }],
    ['registro normal (< 1 min tras el intento)', { processorData: { intentoAbiertoEn: LLEGADA.getTime() - 30_000 } }],
    ['efectivo', { method: 'CASH' }],
    ['tarjeta no completada', { status: 'PENDING' }],
  ])('%s ⇒ ni consulta ni rastro', async (_nombre, cambio) => {
    await revisarTarjetaTardia({ ...TARJETA, ...cambio })
    expect(buscarRastro).not.toHaveBeenCalled()
    expect(escribir).not.toHaveBeenCalled()
  })

  it('la guardada no tiene la hora y el reintento con la llave sí la trae ⇒ cuenta la del reintento; la guardada manda si hay las dos', async () => {
    await revisarTarjetaTardia({ ...TARJETA, processorData: { cardBrand: 'VISA' } }, INTENTO)
    expect(escribir).toHaveBeenCalledTimes(1)
    expect(escribir.mock.calls[0][0].data.data.attemptStartedAt).toBe(new Date(INTENTO).toISOString())

    escribir.mockClear()
    await revisarTarjetaTardia(TARJETA, LLEGADA.getTime() - 5_000)
    expect(escribir.mock.calls[0][0].data.data.attemptStartedAt).toBe(new Date(INTENTO).toISOString())
  })

  it('nunca lanza: ni con la consulta rota ni con la bitácora rota', async () => {
    buscarRastro.mockRejectedValueOnce(new Error('base caída'))
    await expect(revisarTarjetaTardia(TARJETA)).resolves.toBeUndefined()
    escribir.mockRejectedValueOnce(new Error('bitácora rota'))
    await expect(revisarTarjetaTardia(TARJETA)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('leerHoraDelIntento y horaDelIntentoParaGuardar', () => {
  it('número o texto de dígitos ⇒ fecha; lo demás ⇒ null', () => {
    expect(leerHoraDelIntento(INTENTO, LLEGADA)).toEqual(new Date(INTENTO))
    expect(leerHoraDelIntento(String(INTENTO), LLEGADA)).toEqual(new Date(INTENTO))
    for (const malo of [null, undefined, '', 'abc', -1, 0, 1.5, '12e5', {}, LLEGADA.getTime() + 1]) {
      expect(leerHoraDelIntento(malo, LLEGADA)).toBeNull()
    }
  })

  it('se guarda la hora del intento en el reloj del SERVIDOR (llegada − edad), sólo para tarjeta y con una edad legible', () => {
    expect(horaDelIntentoParaGuardar({ method: 'DEBIT_CARD', edadDelIntentoMs: 10 * MIN }, LLEGADA)).toEqual({ intentoAbiertoEn: INTENTO })
    expect(horaDelIntentoParaGuardar({ method: 'CASH', edadDelIntentoMs: 10 * MIN }, LLEGADA)).toEqual({})
    for (const mala of [undefined, null, -1, 1.5, '600000', NaN]) {
      expect(horaDelIntentoParaGuardar({ method: 'CREDIT_CARD', edadDelIntentoMs: mala }, LLEGADA)).toEqual({})
    }
  })
})
