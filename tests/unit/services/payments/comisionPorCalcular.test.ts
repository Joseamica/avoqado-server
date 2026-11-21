/**
 * D24: ¿la comisión de este pago todavía se está calculando? (lo preguntan la póliza y la conciliación antes de guardar su foto).
 * Mock de Prisma: aquí se fija la DECISIÓN; el recorrido real contra Postgres vive en
 * `tests/integration/payments/costoPendienteEnPolizasYConciliacion.integration.test.ts`.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    transactionCost: { findMany: jest.fn() },
    paymentEffect: { findMany: jest.fn() },
  },
}))

import { PaymentType } from '@prisma/client'

import prisma from '../../../../src/utils/prismaClient'
import { comisionesPorCalcular, type PagoParaComision } from '../../../../src/services/payments/comisionPorCalcular'

const p = prisma as unknown as {
  payment: { findMany: jest.Mock }
  transactionCost: { findMany: jest.Mock }
  paymentEffect: { findMany: jest.Mock }
}

const venta = (id: string, o: Partial<PagoParaComision> = {}): PagoParaComision => ({
  id,
  type: PaymentType.FAST,
  amount: 100,
  feeAmount: 0,
  netAmount: 100,
  processorData: {},
  ...o,
})
const devolucion = (id: string, original: string, o: Partial<PagoParaComision> = {}): PagoParaComision => ({
  id,
  type: PaymentType.REFUND,
  amount: -40,
  feeAmount: 0,
  netAmount: -40,
  processorData: { originalPaymentId: original },
  ...o,
})
/** Costo de $100 al 2.5 % + $0.50 ⇒ comisión $3, neto $97; su devolución de $40 ⇒ −$1 / −$39. */
const costoVenta = (paymentId: string) => ({ paymentId, amount: 100, venueChargeAmount: 2.5, venueFixedFee: 0.5 })
const costoDevolucion = (paymentId: string) => ({ paymentId, amount: -40, venueChargeAmount: -1, venueFixedFee: 0 })

beforeEach(() => {
  jest.clearAllMocks()
  p.payment.findMany.mockResolvedValue([])
  p.transactionCost.findMany.mockResolvedValue([])
  p.paymentEffect.findMany.mockResolvedValue([])
})

describe('comisionesPorCalcular (D24)', () => {
  it('sin marca ni devoluciones: nada pendiente y ni una consulta (lo de siempre sigue igual)', async () => {
    expect(await comisionesPorCalcular('v1', [venta('a', { feeAmount: 3, netAmount: 97 }), venta('b')])).toEqual(new Map())
    expect(p.payment.findMany).not.toHaveBeenCalled()
    expect(p.transactionCost.findMany).not.toHaveBeenCalled()
  })

  it('venta con la marca y SIN costo: pendiente; con su costo ya proyectado: final (la marca la reabrió una devolución)', async () => {
    p.transactionCost.findMany.mockResolvedValue([costoVenta('final')])
    const r = await comisionesPorCalcular('v1', [
      venta('sinCosto', { processorData: { costPending: true } }),
      venta('final', { feeAmount: 3, netAmount: 97, processorData: { costPending: true } }),
    ])
    expect(r).toEqual(new Map([['sinCosto', 'PENDIENTE']]))
  })

  it('devolución cuyo cobro tiene la marca: pendiente hasta que su comisión sea la que dicta su costo negativo', async () => {
    p.payment.findMany.mockResolvedValueOnce([{ id: 'orig' }]) // la marca del cobro
    p.transactionCost.findMany.mockResolvedValue([costoDevolucion('proyectada'), costoDevolucion('aMedias')])
    const r = await comisionesPorCalcular('v1', [
      devolucion('sinCosto', 'orig'),
      devolucion('aMedias', 'orig'), // el costo ya existe pero el Payment sigue en 0 / −40 (la ventana de D19)
      devolucion('proyectada', 'orig', { feeAmount: -1, netAmount: -39 }),
    ])
    expect(r).toEqual(
      new Map([
        ['sinCosto', 'PENDIENTE'],
        ['aMedias', 'PENDIENTE'],
      ]),
    )
    expect(p.payment.findMany.mock.calls[0][0].where).toMatchObject({
      venueId: 'v1',
      id: { in: ['orig'] },
      processorData: { path: ['costPending'], equals: true },
    })
  })

  it('Codex r1 #1: la obligación convergió entre leer la devolución y leer la marca ⇒ se relee y, si cambió, se deja para la siguiente', async () => {
    p.payment.findMany
      .mockResolvedValueOnce([]) // la marca del cobro ya está en false
      .mockResolvedValueOnce([
        { id: 'r1', feeAmount: -1, netAmount: -39 }, // la convergencia ya la proyectó
        { id: 'r2', feeAmount: 0, netAmount: -40 }, // sin costo por diseño (cobro viejo): igual que antes
      ])
    const r = await comisionesPorCalcular('v1', [devolucion('r1', 'orig'), devolucion('r2', 'orig2')])
    expect(r).toEqual(new Map([['r1', 'PENDIENTE']]))
  })

  it('Codex r1 #2: crédito de cambio y devolución a saldo a favor nunca esperan (no llevan costo negativo)', async () => {
    const r = await comisionesPorCalcular('v1', [
      devolucion('cambio', 'orig', { tenderType: { systemKind: 'EXCHANGE_CREDIT' } }),
      devolucion('saldo', 'orig', { tenderType: { systemKind: 'STORE_CREDIT' } }),
    ])
    expect(r).toEqual(new Map())
    expect(p.payment.findMany).not.toHaveBeenCalled()
  })

  it('obligación en DEAD_LETTER: «sin calcular» (hay que revisarla)', async () => {
    p.paymentEffect.findMany.mockResolvedValue([{ paymentId: 'muerta' }])
    const r = await comisionesPorCalcular('v1', [
      venta('muerta', { processorData: { costPending: true } }),
      venta('viva', { processorData: { costPending: true } }),
    ])
    expect(r).toEqual(
      new Map([
        ['muerta', 'SIN_CALCULAR'],
        ['viva', 'PENDIENTE'],
      ]),
    )
    expect(p.paymentEffect.findMany.mock.calls[0][0].where).toMatchObject({ kind: 'TRANSACTION_COST', status: 'DEAD_LETTER' })
  })
})
