/**
 * D679 · Codex código r1 #3 — una venta no entrega un Ilimitado sin vencimiento.
 *
 * La venta lee el paquete fuera del candado de la edición, en dos consultas (paquete y renglones). Si la gerente convierte un
 * paquete normal SIN vigencia en Ilimitado con 30 días justo en medio, la venta puede ver la vigencia vieja (vacía) y los renglones
 * nuevos (Ilimitados). La edición escribe las dos cosas juntas, así que al ver un renglón Ilimitado sin vigencia, la entrega
 * relee la vigencia vigente dentro de SU transacción.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { grantPackInTx } from '@/services/mobile/creditPack.mobile.service'

const D = 24 * 60 * 60 * 1000

function makeTx(vigenciaVigente: number | null) {
  return {
    creditPack: { findUnique: jest.fn().mockResolvedValue({ validityDays: vigenciaVigente }) },
    creditPackPurchase: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: 'purchase-1' }) },
    creditItemBalance: { create: jest.fn().mockResolvedValue({ id: 'bal-1' }) },
    creditTransaction: { create: jest.fn().mockResolvedValue({}) },
    customer: { update: jest.fn().mockResolvedValue({}) },
  }
}
const vender = (tx: ReturnType<typeof makeTx>, validityDays: number | null, unlimited: boolean) =>
  grantPackInTx(tx as any, {
    pack: {
      id: 'pack-1',
      venueId: 'venue-1',
      price: 2500,
      active: true,
      validityDays,
      maxPerCustomer: null,
      items: [{ id: 'item-1', productId: 'prod-1', quantity: 99999, unlimited }],
    },
    venueId: 'venue-1',
    customerId: 'cust-1',
    amountPaid: 2500 as any,
  })

describe('D679 · la venta de un Ilimitado siempre vence', () => {
  it('lectura partida (vigencia vieja vacía + renglón ya Ilimitado): relee la vigencia en su transacción y vence en 30 días', async () => {
    const tx = makeTx(30)
    await vender(tx, null, true)
    expect(tx.creditPack.findUnique).toHaveBeenCalledWith({ where: { id: 'pack-1' }, select: { validityDays: true } })
    const { expiresAt } = tx.creditPackPurchase.create.mock.calls[0][0].data
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * D)
  })

  it('si aun releída no tiene vigencia, no entrega un Ilimitado eterno', async () => {
    const tx = makeTx(null)
    await expect(vender(tx, null, true)).rejects.toMatchObject({ code: 'CREDIT_UNLIMITED_NEEDS_VALIDITY' })
    expect(tx.creditPackPurchase.create).not.toHaveBeenCalled()
  })

  it('un paquete normal sin vigencia se entrega como hoy, sin releer nada', async () => {
    const tx = makeTx(null)
    await vender(tx, null, false)
    expect(tx.creditPack.findUnique).not.toHaveBeenCalled()
    expect(tx.creditPackPurchase.create.mock.calls[0][0].data.expiresAt).toBeNull()
  })
})
