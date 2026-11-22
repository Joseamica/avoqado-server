/**
 * D7 (encargo a25cd7): en Pago rápido, una tarjeta que se registra TARDE y un efectivo del mismo importe en la misma terminal
 * cobrado entre su intento y 30 min después ⇒ rastro `LATE_CARD_AFTER_CASH`, revisado desde los dos lados. Nunca toca el cobro.
 * El recorrido contra Postgres vive en `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts` («Pago rápido»).
 */
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  ACCION_TARJETA_TARDIA_CON_EFECTIVO,
  horaDelIntentoParaGuardar,
  leerHoraDelIntento,
  revisarEfectivoContraTarjetasTardias,
  revisarTarjetaTardia,
} from '@/services/shared/avisoDeTarjetaTardiaConEfectivo'
import prisma from '@/utils/prismaClient'

const buscarPagos = prisma.payment.findMany as jest.Mock
const buscarRastro = prisma.activityLog.findFirst as jest.Mock
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
  createdAt: LLEGADA,
  processorData: { cardBrand: 'VISA', capturadoEnAparato: INTENTO },
  processedById: 's1',
}
const EFECTIVO = {
  id: 'pEfectivo',
  venueId: 'v1',
  orderId: 'oEfectivo',
  terminalId: 't1',
  method: 'CASH',
  status: 'COMPLETED',
  amount: 100,
  createdAt: new Date(INTENTO + 2 * MIN),
  clientCreatedAt: null,
}
const gritos = () => (logger.error as jest.Mock).mock.calls.filter(c => String(c[0]).includes('🚨 [Tarjeta tardía]'))

beforeEach(() => {
  jest.clearAllMocks()
  buscarPagos.mockResolvedValue([{ id: 'pEfectivo', orderId: 'oEfectivo' }])
  buscarRastro.mockResolvedValue(null)
})

describe('revisarTarjetaTardia (llega la tarjeta)', () => {
  it('con efectivo en la ventana ⇒ busca SÓLO efectivo de esa terminal, por la hora del aparato o la llegada, y deja UN rastro', async () => {
    await revisarTarjetaTardia(TARJETA)

    const consulta = buscarPagos.mock.calls[0][0]
    expect(consulta.where).toMatchObject({ venueId: 'v1', terminalId: 't1', status: 'COMPLETED', amount: 100, id: { not: 'pTarjeta' } })
    const [efectivo, horas] = consulta.where.AND
    expect(efectivo.OR).toEqual(expect.arrayContaining([{ fundsFlow: 'CASH_DRAWER' }]))
    // Desde el intento hasta 30 min después, pero nunca después de la llegada de la tarjeta (aquí, 10 min después del intento).
    const ventana = { gte: new Date(INTENTO), lte: LLEGADA }
    expect(horas.OR).toEqual([{ clientCreatedAt: ventana }, { clientCreatedAt: null, createdAt: ventana }])
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
        attemptStartedAt: new Date(INTENTO).toISOString(),
        recordedAt: LLEGADA.toISOString(),
      },
    })
    expect(gritos()).toHaveLength(1)
  })

  it('la ventana nunca pasa de la llegada de la tarjeta', async () => {
    await revisarTarjetaTardia({ ...TARJETA, processorData: { capturadoEnAparato: LLEGADA.getTime() - 5 * MIN } })
    expect(buscarPagos.mock.calls[0][0].where.AND[1].OR[0].clientCreatedAt.lte).toEqual(LLEGADA)
  })

  it('ya hay rastro de esta tarjeta (el otro lado o un reintento) ⇒ no se repite', async () => {
    buscarRastro.mockResolvedValue({ id: 'ya' })
    await revisarTarjetaTardia(TARJETA)
    expect(logAction).not.toHaveBeenCalled()
    expect(gritos()).toEqual([])
  })

  it('sin efectivo en la ventana ⇒ consulta, pero ni rastro ni grito', async () => {
    buscarPagos.mockResolvedValue([])
    await revisarTarjetaTardia(TARJETA)
    expect(logAction).not.toHaveBeenCalled()
    expect(gritos()).toEqual([])
  })

  it.each([
    ['TPV vieja: sin la hora del intento', { processorData: { cardBrand: 'VISA' } }],
    ['sin processorData', { processorData: null }],
    ['registro normal (< 1 min tras el intento)', { processorData: { capturadoEnAparato: LLEGADA.getTime() - 30_000 } }],
    ['efectivo', { method: 'CASH' }],
    ['tarjeta no completada', { status: 'PENDING' }],
    ['sin terminal', { terminalId: null }],
  ])('%s ⇒ ni consulta ni rastro', async (_nombre, cambio) => {
    await revisarTarjetaTardia({ ...TARJETA, ...cambio })
    expect(buscarPagos).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('nunca lanza: ni con la consulta rota ni con la bitácora rota', async () => {
    buscarPagos.mockRejectedValueOnce(new Error('base caída'))
    await expect(revisarTarjetaTardia(TARJETA)).resolves.toBeUndefined()
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('bitácora rota'))
    await expect(revisarTarjetaTardia(TARJETA)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})

describe('revisarEfectivoContraTarjetasTardias (llega el efectivo, la tarjeta ya estaba)', () => {
  beforeEach(() => buscarPagos.mockResolvedValue([TARJETA]))

  it('el efectivo cae en la ventana de una tarjeta tardía ya registrada ⇒ rastro sobre ESA tarjeta', async () => {
    await revisarEfectivoContraTarjetasTardias(EFECTIVO)
    const consulta = buscarPagos.mock.calls[0][0]
    expect(consulta.where).toMatchObject({
      venueId: 'v1',
      terminalId: 't1',
      amount: 100,
      method: { in: ['CREDIT_CARD', 'DEBIT_CARD'] },
      createdAt: { gte: EFECTIVO.createdAt },
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'pTarjeta', data: expect.objectContaining({ cashPaymentIds: ['pEfectivo'] }) }),
    )
  })

  it('el efectivo de la cola se mide a la hora del aparato, no a la de llegada', async () => {
    const deLaCola = { ...EFECTIVO, clientCreatedAt: new Date(INTENTO + 5 * MIN), createdAt: new Date(LLEGADA.getTime() + 60 * MIN) }
    await revisarEfectivoContraTarjetasTardias(deLaCola)
    expect(buscarPagos.mock.calls[0][0].where.createdAt.gte).toEqual(deLaCola.clientCreatedAt)
    expect(logAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['cobrado ANTES del intento', { createdAt: new Date(INTENTO - MIN) }],
    ['cobrado más de 30 min después del intento', { createdAt: new Date(INTENTO + 31 * MIN) }],
  ])('%s ⇒ sin rastro', async (_nombre, cambio) => {
    await revisarEfectivoContraTarjetasTardias({ ...EFECTIVO, ...cambio })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('una tarjeta registrada a tiempo no cuenta', async () => {
    buscarPagos.mockResolvedValue([{ ...TARJETA, processorData: { capturadoEnAparato: LLEGADA.getTime() - 10_000 } }])
    await revisarEfectivoContraTarjetasTardias({ ...EFECTIVO, createdAt: new Date(LLEGADA.getTime() - 5_000) })
    expect(logAction).not.toHaveBeenCalled()
  })

  it.each([
    ['tarjeta', { method: 'CREDIT_CARD' }],
    ['un tipo que no entra al cajón', { fundsFlow: 'EXTERNAL_RECORDED' }],
    ['no completado', { status: 'FAILED' }],
    ['sin terminal', { terminalId: null }],
  ])('%s ⇒ ni consulta ni rastro', async (_nombre, cambio) => {
    await revisarEfectivoContraTarjetasTardias({ ...EFECTIVO, ...cambio } as typeof EFECTIVO)
    expect(buscarPagos).not.toHaveBeenCalled()
  })

  it('nunca lanza', async () => {
    buscarPagos.mockRejectedValueOnce(new Error('base caída'))
    await expect(revisarEfectivoContraTarjetasTardias(EFECTIVO)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
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
