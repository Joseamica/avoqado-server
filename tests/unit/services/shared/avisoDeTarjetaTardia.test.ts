/**
 * D7 (encargo a25cd7): en Pago rápido, toda tarjeta que llega aprobada TARDE (≥ 1 min después de su intento) deja
 * `LATE_CARD_RECORDED` para que el dueño revise si esa venta se cobró de otra forma. A propósito NO se empareja con un efectivo.
 * Nunca toca el cobro. El recorrido contra Postgres vive en `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`.
 */
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  ACCION_TARJETA_CONFIRMADA_TARDE,
  horaDelIntentoParaGuardar,
  leerHoraDelIntento,
  revisarTarjetaTardia,
} from '@/services/shared/avisoDeTarjetaTardia'
import prisma from '@/utils/prismaClient'

const buscarRastro = prisma.activityLog.findFirst as jest.Mock
const buscarPagos = prisma.payment.findMany as jest.Mock
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
  processorData: { cardBrand: 'VISA', capturadoEnAparato: INTENTO },
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
    expect(logAction).toHaveBeenCalledWith({
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
    })
    expect(gritos()).toHaveLength(1)
    expect(buscarPagos).not.toHaveBeenCalled()
  })

  it('ya hay rastro de esta tarjeta (reintento con su llave) ⇒ no se repite', async () => {
    buscarRastro.mockResolvedValue({ id: 'ya' })
    await revisarTarjetaTardia(TARJETA)
    expect(logAction).not.toHaveBeenCalled()
    expect(gritos()).toEqual([])
  })

  it.each([
    ['TPV vieja: sin la hora del intento', { processorData: { cardBrand: 'VISA' } }],
    ['sin processorData', { processorData: null }],
    ['hora ilegible', { processorData: { capturadoEnAparato: 'ayer' } }],
    ['registro normal (< 1 min tras el intento)', { processorData: { capturadoEnAparato: LLEGADA.getTime() - 30_000 } }],
    ['efectivo', { method: 'CASH' }],
    ['tarjeta no completada', { status: 'PENDING' }],
  ])('%s ⇒ ni consulta ni rastro', async (_nombre, cambio) => {
    await revisarTarjetaTardia({ ...TARJETA, ...cambio })
    expect(buscarRastro).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('nunca lanza: ni con la consulta rota ni con la bitácora rota', async () => {
    buscarRastro.mockRejectedValueOnce(new Error('base caída'))
    await expect(revisarTarjetaTardia(TARJETA)).resolves.toBeUndefined()
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('bitácora rota'))
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

  it('sólo se guarda para tarjeta y con una hora legible', () => {
    expect(horaDelIntentoParaGuardar({ method: 'DEBIT_CARD', capturadoEnAparato: String(INTENTO) }, LLEGADA)).toEqual({
      capturadoEnAparato: INTENTO,
    })
    expect(horaDelIntentoParaGuardar({ method: 'CASH', capturadoEnAparato: INTENTO }, LLEGADA)).toEqual({})
    expect(horaDelIntentoParaGuardar({ method: 'CREDIT_CARD', capturadoEnAparato: 'ayer' }, LLEGADA)).toEqual({})
    expect(horaDelIntentoParaGuardar({ method: 'CREDIT_CARD' }, LLEGADA)).toEqual({})
  })
})
