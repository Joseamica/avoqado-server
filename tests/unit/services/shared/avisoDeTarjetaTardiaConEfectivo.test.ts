/**
 * D7 (encargo a25cd7): en Pago rápido, una tarjeta que se registra TARDE y, entre su intento y su llegada, un efectivo del mismo
 * importe en la misma terminal ⇒ rastro `LATE_CARD_AFTER_CASH`. Nunca toca el cobro. El recorrido contra Postgres vive en
 * `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts` («Pago rápido»).
 */
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  ACCION_TARJETA_TARDIA_CON_EFECTIVO,
  avisarTarjetaTardiaConEfectivo,
  leerHoraDelIntento,
} from '@/services/shared/avisoDeTarjetaTardiaConEfectivo'
import prisma from '@/utils/prismaClient'

const buscar = prisma.payment.findMany as jest.Mock
const LLEGADA = new Date('2026-11-22T18:00:00.000Z')
const HACE_5_MIN = LLEGADA.getTime() - 5 * 60_000
const TARJETA = {
  id: 'pTarjeta',
  venueId: 'v1',
  orderId: 'oTarjeta',
  terminalId: 't1',
  method: 'CREDIT_CARD',
  status: 'COMPLETED',
  amount: 100,
  processedById: 's1',
  horaDelIntento: HACE_5_MIN,
  llegada: LLEGADA,
}

beforeEach(() => {
  jest.clearAllMocks()
  buscar.mockResolvedValue([{ id: 'pEfectivo', orderId: 'oEfectivo' }])
})

describe('avisarTarjetaTardiaConEfectivo', () => {
  it('tarjeta tardía con efectivo del mismo importe en medio ⇒ busca SÓLO efectivo de esa terminal en la ventana y deja el rastro', async () => {
    await avisarTarjetaTardiaConEfectivo(TARJETA)

    const consulta = buscar.mock.calls[0][0]
    expect(consulta.where).toMatchObject({
      venueId: 'v1',
      terminalId: 't1',
      status: 'COMPLETED',
      amount: 100,
      id: { not: 'pTarjeta' },
      createdAt: { gte: new Date(HACE_5_MIN), lte: LLEGADA },
    })
    expect(consulta.where.OR).toEqual(expect.arrayContaining([{ fundsFlow: 'CASH_DRAWER' }]))
    expect(consulta.take).toBeLessThanOrEqual(5)
    expect(logAction).toHaveBeenCalledWith({
      action: ACCION_TARJETA_TARDIA_CON_EFECTIVO,
      entity: 'Payment',
      entityId: 'pTarjeta',
      venueId: 'v1',
      staffId: 's1',
      data: {
        paymentId: 'pTarjeta',
        orderId: 'oTarjeta',
        amount: 100,
        cashPaymentIds: ['pEfectivo'],
        cashOrderIds: ['oEfectivo'],
        attemptStartedAt: new Date(HACE_5_MIN).toISOString(),
        recordedAt: LLEGADA.toISOString(),
      },
    })
    expect((logger.error as jest.Mock).mock.calls.some(c => String(c[0]).includes('🚨 [Tarjeta tardía]'))).toBe(true)
  })

  it('la hora del intento también llega como texto de dígitos', async () => {
    await avisarTarjetaTardiaConEfectivo({ ...TARJETA, horaDelIntento: String(HACE_5_MIN) })
    expect(logAction).toHaveBeenCalledTimes(1)
  })

  it('sin efectivo en medio ⇒ consulta, pero ni rastro ni grito', async () => {
    buscar.mockResolvedValue([])
    await avisarTarjetaTardiaConEfectivo(TARJETA)
    expect(buscar).toHaveBeenCalledTimes(1)
    expect(logAction).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    ['TPV vieja: sin la hora del intento', { horaDelIntento: undefined }],
    ['hora ilegible', { horaDelIntento: 'ayer' }],
    ['hora en el futuro', { horaDelIntento: LLEGADA.getTime() + 1000 }],
    ['registro normal (< 1 min tras el intento)', { horaDelIntento: LLEGADA.getTime() - 30_000 }],
    ['efectivo', { method: 'CASH' }],
    ['tarjeta no completada', { status: 'PENDING' }],
    ['sin terminal', { terminalId: null }],
  ])('%s ⇒ ni consulta ni rastro', async (_nombre, cambio) => {
    await avisarTarjetaTardiaConEfectivo({ ...TARJETA, ...cambio })
    expect(buscar).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un intento de hace días: la ventana se acota a 24 h antes de la llegada', async () => {
    await avisarTarjetaTardiaConEfectivo({ ...TARJETA, horaDelIntento: LLEGADA.getTime() - 3 * 24 * 60 * 60_000 })
    expect(buscar.mock.calls[0][0].where.createdAt.gte).toEqual(new Date(LLEGADA.getTime() - 24 * 60 * 60_000))
  })

  it('nunca lanza: ni con la consulta rota ni con la bitácora rota', async () => {
    buscar.mockRejectedValueOnce(new Error('base caída'))
    await expect(avisarTarjetaTardiaConEfectivo(TARJETA)).resolves.toBeUndefined()
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('bitácora rota'))
    await expect(avisarTarjetaTardiaConEfectivo(TARJETA)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('leerHoraDelIntento', () => {
  it('número o texto de dígitos ⇒ fecha; lo demás ⇒ null', () => {
    expect(leerHoraDelIntento(HACE_5_MIN, LLEGADA)).toEqual(new Date(HACE_5_MIN))
    expect(leerHoraDelIntento(String(HACE_5_MIN), LLEGADA)).toEqual(new Date(HACE_5_MIN))
    for (const malo of [null, undefined, '', 'abc', -1, 0, 1.5, '12e5', {}, LLEGADA.getTime() + 1]) {
      expect(leerHoraDelIntento(malo, LLEGADA)).toBeNull()
    }
  })
})
