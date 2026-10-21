/**
 * 30-sep-2026 · Inventario de warns de producción: «⚠️ [S2] El costo no se puede calcular con una tarifa acreditable» fue el
 * aviso MÁS repetido del servidor — 3,132 líneas en 3 días — y correspondía a CUATRO pagos del venue demo cuyo comercio no
 * tiene tarifa contratada. La obligación es durable y con motivo (Codex R3 P1-3), pero el worker la retoma cada ~5 min y
 * CADA corrida volvía a gritar en warn con los mismos ids.
 *
 * La regla: se avisa UNA vez por pago y motivo en la vida del proceso; las repeticiones salen en debug. Lo que NO cambia: el
 * efecto sigue PENDIENTE con su motivo y `costPending` sigue en true, en ese orden, igual que antes.
 * Auditoría de Codex del mismo día: decidirlo por el `lastError` del efecto perdía el PRIMER aviso, porque la espera del
 * método provisional ya guarda ese mismo motivo sin avisar. Cada prueba usa su propio pago: la memoria es del módulo.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { convergerCostoDeTransaccion, settleDeferredTransactionCost } from '@/services/payments/deferredTransactionCost.service'

jest.mock('@/services/payments/transactionCost.service', () => ({
  createTransactionCost: jest.fn(),
  createRefundTransactionCost: jest.fn(),
  leerTarifaCongelada: jest.fn(),
}))
const { createTransactionCost, leerTarifaCongelada } = jest.requireMock('@/services/payments/transactionCost.service')

const MOTIVO = 'AFFILIATION_PRICING_UNRESOLVED'
const S2 = expect.stringContaining('[S2] El costo no se puede calcular')
const pago = (id: string, processorData: Record<string, unknown> = {}) => ({
  id,
  status: 'COMPLETED',
  method: 'CREDIT_CARD',
  fundsFlow: 'AVOQADO_PROCESSED',
  cardBrand: null,
  merchantAccountId: 'm1',
  processorData,
})
const donde = (paymentId: string) => ({ paymentId, kind: 'TRANSACTION_COST', status: { in: ['PROCESSING', 'PENDING'] } })
const sinTarifa = (paymentId: string) =>
  new Error(`COST_PENDING_${MOTIVO}: payment ${paymentId} was processed by m1 with no contracted pricing`)

beforeEach(() => {
  ;(prismaMock as any).$queryRaw.mockReset().mockImplementation(async () => [{ id: 'x' }])
  ;(prismaMock as any).$executeRaw.mockReset().mockResolvedValue(1)
  ;(prismaMock as any).$transaction
    .mockReset()
    .mockImplementation(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prismaMock) : Promise.all(fn as unknown[]),
    )
  ;(prismaMock as any).transactionCost.findUnique.mockReset().mockResolvedValue(null)
  ;(prismaMock as any).paymentEffect.updateMany.mockReset().mockResolvedValue({ count: 1 })
})

const convergerSinTarifa = async (paymentId: string) => {
  ;(prismaMock as any).payment.findUniqueOrThrow.mockReset().mockResolvedValue(pago(paymentId))
  createTransactionCost.mockReset().mockRejectedValue(sinTarifa(paymentId))
  return convergerCostoDeTransaccion(paymentId, { tipo: 'REST' })
}

it('la PRIMERA vez que el costo de un pago queda pendiente por tarifa no acreditable avisa en warn, y anota motivo y marca', async () => {
  expect(await convergerSinTarifa('p-primera')).toBe('PENDIENTE')
  expect(logger.warn).toHaveBeenCalledWith(S2, expect.objectContaining({ paymentId: 'p-primera', motivo: MOTIVO }))
  expect((prismaMock as any).paymentEffect.updateMany).toHaveBeenCalledWith({ where: donde('p-primera'), data: { lastError: MOTIVO } })
  expect((prismaMock as any).$executeRaw).toHaveBeenCalledWith(expect.anything(), JSON.stringify({ costPending: true }), 'p-primera')
})

it('🔴 las corridas siguientes del worker por el MISMO pago y motivo no repiten el warn: salen en debug, y la obligación queda igual', async () => {
  await convergerSinTarifa('p-repetido')
  ;(logger.warn as jest.Mock).mockClear()
  ;(logger.debug as jest.Mock).mockClear()
  ;(prismaMock as any).paymentEffect.updateMany.mockClear()
  ;(prismaMock as any).$executeRaw.mockClear()

  expect(await convergerSinTarifa('p-repetido')).toBe('PENDIENTE')

  expect(logger.warn).not.toHaveBeenCalledWith(S2, expect.anything())
  expect(logger.debug).toHaveBeenCalledWith(
    expect.stringContaining('[S2]'),
    expect.objectContaining({ paymentId: 'p-repetido', motivo: MOTIVO }),
  )
  expect((prismaMock as any).paymentEffect.updateMany).toHaveBeenCalledWith({ where: donde('p-repetido'), data: { lastError: MOTIVO } })
  expect((prismaMock as any).$executeRaw).toHaveBeenCalledWith(expect.anything(), JSON.stringify({ costPending: true }), 'p-repetido')
})

it('🔴 Codex 30-sep · si la espera del método provisional YA guardó el mismo motivo sin avisar, la primera convergencia tras acreditar la tarjeta SÍ avisa', async () => {
  // 1) Webhook: método provisional + snapshot sin tarifa ⇒ la espera anota el motivo PERMANENTE y no avisa.
  ;(prismaMock as any).payment.findUnique.mockReset().mockResolvedValue(pago('p-provisional', { methodProvisional: true }))
  leerTarifaCongelada.mockReset().mockReturnValue({ estado: 'SIN_TARIFA' })
  expect(await settleDeferredTransactionCost('p-provisional', null, new Date())).toBe(false)
  expect((prismaMock as any).paymentEffect.updateMany).toHaveBeenCalledWith({ where: donde('p-provisional'), data: { lastError: MOTIVO } })
  expect(logger.warn).not.toHaveBeenCalledWith(S2, expect.anything())

  // 2) El REST de la terminal acredita la tarjeta y la convergencia topa con la misma tarifa no acreditable ⇒ ése es el aviso.
  //    La base ya dice `lastError = MOTIVO` (lo escribió el paso 1): una implementación que decidiera por esa columna callaría aquí.
  ;(prismaMock as any).paymentEffect.findFirst.mockReset().mockResolvedValue({ lastError: MOTIVO })
  expect(await convergerSinTarifa('p-provisional')).toBe('PENDIENTE')
  expect(logger.warn).toHaveBeenCalledWith(S2, expect.objectContaining({ paymentId: 'p-provisional', motivo: MOTIVO }))
})

it('un motivo DISTINTO para el mismo pago vuelve a avisar', async () => {
  await convergerSinTarifa('p-dos-motivos')
  ;(logger.warn as jest.Mock).mockClear()
  ;(prismaMock as any).payment.findUniqueOrThrow.mockReset().mockResolvedValue(pago('p-dos-motivos'))
  createTransactionCost.mockReset().mockRejectedValue(new Error('COST_PENDING_INVALID_PRICING_SNAPSHOT: payment p-dos-motivos …'))

  expect(await convergerCostoDeTransaccion('p-dos-motivos', { tipo: 'REST' })).toBe('PENDIENTE')
  expect(logger.warn).toHaveBeenCalledWith(S2, expect.objectContaining({ motivo: 'INVALID_PRICING_SNAPSHOT' }))
})
