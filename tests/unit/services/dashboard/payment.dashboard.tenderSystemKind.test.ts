/**
 * D-3 (full-testing del DASHBOARD, parte del SERVIDOR): el listado y el detalle de pagos del panel traen el campo OPCIONAL
 * `tenderSystemKind` (el mismo nombre que el detalle del Cambio, `exchangeDetail.ts`): el medio de sistema de la fila (`STORE_CREDIT`,
 * `GIFT_CARD`, `EXCHANGE_CREDIT`) o null. Sin él, Transacciones y el panel del pago enseñaban una devolución a saldo a favor como «Otro»
 * (la fila trae `method = OTHER`). Sale de `tenderType.systemKind` en la MISMA consulta (sin N+1); nada se quita ni se renombra.
 */
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '@/utils/prismaClient'
import { getPaymentById, getPaymentsData } from '@/services/dashboard/payment.dashboard.service'

const prismaMock = prisma as any
const fila = (id: string, method: string, systemKind: string | null) => ({
  id,
  venueId: 'venue-1',
  orderId: null,
  order: null,
  amount: new Decimal(-150),
  tipAmount: new Decimal(0),
  method,
  status: 'COMPLETED',
  tenderLabel: systemKind === 'STORE_CREDIT' ? 'Saldo a favor' : null,
  tenderType: systemKind ? { systemKind } : null,
  createdAt: new Date('2026-11-01T16:00:00.000Z'),
})

describe('D-3: tenderSystemKind en el listado y el detalle de pagos del panel', () => {
  it('🔴 el listado: la devolución a saldo trae STORE_CREDIT, el cobro en efectivo null; lo demás de la fila igual; una sola consulta', async () => {
    prismaMock.$transaction.mockResolvedValue([[fila('r1', 'OTHER', 'STORE_CREDIT'), fila('p1', 'CASH', null)], 2])

    const r = await getPaymentsData('venue-1', 1, 20)

    expect(r.data).toEqual([
      expect.objectContaining({ id: 'r1', method: 'OTHER', tenderLabel: 'Saldo a favor', tenderSystemKind: 'STORE_CREDIT' }),
      expect.objectContaining({ id: 'p1', method: 'CASH', tenderSystemKind: null }),
    ])
    // Sólo se agrega el campo plano; no viaja el objeto de la relación.
    expect(r.data[0]).not.toHaveProperty('tenderType')
    expect(r.meta).toEqual({ total: 2, page: 1, pageSize: 20, pageCount: 1 })
    expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ tenderType: { select: { systemKind: true } } }) }),
    )
  })

  it('🔴 el detalle: la devolución a saldo trae STORE_CREDIT; un cobro en efectivo, null', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(fila('r1', 'OTHER', 'STORE_CREDIT'))
    const devolucion = await getPaymentById('venue-1', 'r1')
    expect(devolucion).toMatchObject({ id: 'r1', method: 'OTHER', tenderSystemKind: 'STORE_CREDIT' })
    expect(devolucion).not.toHaveProperty('tenderType')

    prismaMock.payment.findFirst.mockResolvedValueOnce(fila('p1', 'CASH', null))
    expect(await getPaymentById('venue-1', 'p1')).toMatchObject({ id: 'p1', method: 'CASH', tenderSystemKind: null })
    expect(prismaMock.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ tenderType: { select: { systemKind: true } } }) }),
    )
  })
})
