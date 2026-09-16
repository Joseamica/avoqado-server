/**
 * Codex R2 (N4): el costo NEGATIVO de un reembolso se calcula sobre el importe TOTAL devuelto (base + propina), igual que
 * el costo original se cobró sobre base + propina. El helper leía sólo `amount` y un reembolso total con propina dejaba
 * comisión sin revertir y el fijo sin devolver.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createRefundTransactionCost } from '@/services/payments/transactionCost.service'

const prismaMock = prisma as any
const D = (n: number) => new Prisma.Decimal(n)

const costoOriginal = {
  id: 'tc-1',
  paymentId: 'pay-1',
  merchantAccountId: 'ma-1',
  transactionType: 'CREDIT',
  amount: D(110), // base 100 + propina 10
  providerRate: D(0.02),
  providerCostAmount: D(2.2),
  providerFixedFee: D(0.3),
  providerCostStructureId: 'pcs-1',
  venueRate: D(0.025),
  venueChargeAmount: D(2.75),
  venueFixedFee: D(0.5),
  venuePricingStructureId: 'vps-1',
  grossProfit: D(0.75),
  profitMargin: D(0.2308),
}

beforeEach(() => {
  prismaMock.transactionCost.findUnique.mockReset().mockResolvedValue(costoOriginal)
  prismaMock.transactionCost.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'tc-r', ...data }))
  prismaMock.payment.findUnique.mockReset()
})

const reembolso = (amount: number, tip: number) => ({ id: 'ref-1', amount: D(-amount), tipAmount: D(-tip) })

it('reembolso TOTAL con propina (−100 base, −10 propina): revierte el costo entero, fijo incluido', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(reembolso(100, 10))
  await createRefundTransactionCost('ref-1', 'pay-1')
  const data = prismaMock.transactionCost.create.mock.calls[0][0].data
  expect(data.amount).toBe(-110)
  expect(data.venueChargeAmount).toBeCloseTo(-2.75, 6)
  expect(data.venueFixedFee).toBeCloseTo(-0.5, 6)
  expect(data.providerCostAmount).toBeCloseTo(-2.2, 6)
  expect(data.providerFixedFee).toBeCloseTo(-0.3, 6)
  expect(data.grossProfit).toBeCloseTo(-0.75, 6)
})

it('reembolso PARCIAL con propina (−50, −5): proporcional al total devuelto (0.5), sin el fijo', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(reembolso(50, 5))
  await createRefundTransactionCost('ref-1', 'pay-1')
  const data = prismaMock.transactionCost.create.mock.calls[0][0].data
  expect(data.amount).toBe(-55)
  expect(data.venueChargeAmount).toBeCloseTo(-1.375, 6)
  expect(data.venueFixedFee).toBe(0)
})

it('reembolso SÓLO de propina (0, −10): proporcional 10/110', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(reembolso(0, 10))
  await createRefundTransactionCost('ref-1', 'pay-1')
  const data = prismaMock.transactionCost.create.mock.calls[0][0].data
  expect(data.amount).toBe(-10)
  expect(data.venueChargeAmount).toBeCloseTo(-0.25, 6)
  expect(data.venueFixedFee).toBe(0)
})

it('sin propina (−40, 0) se comporta como antes: proporcional 40/110 sobre un original con propina', async () => {
  prismaMock.payment.findUnique.mockResolvedValue(reembolso(40, 0))
  await createRefundTransactionCost('ref-1', 'pay-1')
  const data = prismaMock.transactionCost.create.mock.calls[0][0].data
  expect(data.amount).toBe(-40)
  expect(data.venueChargeAmount).toBeCloseTo(-1, 6)
})

describe('Codex R3 · P2: el margen revertido sale de los COMPONENTES efectivamente revertidos', () => {
  it('reembolso PARCIAL (50 %): los fijos no se devuelven, así que el margen revertido es −0.275 (no −0.375 = grossProfit × ratio) y el margen relativo el de los componentes', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(reembolso(50, 5))
    await createRefundTransactionCost('ref-1', 'pay-1')
    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data.providerCostAmount).toBeCloseTo(-1.1, 6)
    expect(data.providerFixedFee).toBe(0)
    expect(data.venueChargeAmount).toBeCloseTo(-1.375, 6)
    expect(data.venueFixedFee).toBe(0)
    // venue revertido (−1.375) − proveedor revertido (−1.1) = −0.275
    expect(data.grossProfit).toBeCloseTo(-0.275, 6)
    expect(data.profitMargin).toBeCloseTo(0.2, 6)
    // Conservación: lo revertido cuadra componente a componente, no por proporción del margen original.
    expect(data.grossProfit).toBeCloseTo(data.venueChargeAmount + data.venueFixedFee - (data.providerCostAmount + data.providerFixedFee), 9)
  })

  it('reembolso TOTAL: el margen revertido es el margen original entero (−0.75), con los fijos incluidos', async () => {
    prismaMock.payment.findUnique.mockResolvedValue(reembolso(100, 10))
    await createRefundTransactionCost('ref-1', 'pay-1')
    const data = prismaMock.transactionCost.create.mock.calls[0][0].data
    expect(data.grossProfit).toBeCloseTo(-0.75, 6)
    expect(data.profitMargin).toBeCloseTo(0.75 / 3.25, 6)
  })
})
