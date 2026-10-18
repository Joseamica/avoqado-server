// tests/unit/services/online-ordering/printClaim.service.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { PRINT_CLAIM_TTL_MS } from '@/services/online-ordering/constants'
import { claimOnlineOrderPrint, confirmOnlineOrderPrinted, onlineOrderNeedsPrint } from '@/services/online-ordering/printClaim.service'

const NOW = new Date('2026-10-14T18:30:00.000Z')

describe('onlineOrderNeedsPrint', () => {
  it('sólo pedidos aceptados que nadie imprimió', () => {
    expect(onlineOrderNeedsPrint({ status: 'PENDING_ACCEPTANCE', printedAt: null, printClaimedAt: null } as any, NOW)).toBe(false)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: null } as any, NOW)).toBe(true)
    expect(onlineOrderNeedsPrint({ status: 'READY', printedAt: NOW, printClaimedAt: NOW } as any, NOW)).toBe(false)
  })

  it('un reclamo vencido cuenta como libre (se imprime de más antes que de menos)', () => {
    const fresh = new Date(NOW.getTime() - 10_000)
    const stale = new Date(NOW.getTime() - PRINT_CLAIM_TTL_MS - 1_000)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: fresh } as any, NOW)).toBe(false)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: stale } as any, NOW)).toBe(true)
  })
})

describe('claimOnlineOrderPrint', () => {
  it('es un updateMany atómico sobre pedidos aceptados, sin imprimir y libres o con reclamo vencido', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev1', NOW)).resolves.toEqual({ claimed: true })
    const call = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(call.where).toMatchObject({ orderId: 'ord1', venueId: 'v1', status: { in: ['ACCEPTED', 'READY'] }, printedAt: null })
    expect(call.where.OR).toEqual([{ printClaimedAt: null }, { printClaimedAt: { lt: new Date(NOW.getTime() - PRINT_CLAIM_TTL_MS) } }])
    expect(call.data).toEqual({ printClaimedAt: NOW, printClaimedBy: 'dev1' })
  })

  it('el perdedor recibe claimed:false', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev2', NOW)).resolves.toEqual({ claimed: false })
  })
})

describe('confirmOnlineOrderPrinted', () => {
  it('sólo confirma quien reclamó', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    await expect(confirmOnlineOrderPrinted('v1', 'ord1', 'dev1', NOW)).resolves.toEqual({ ok: true })
    const call = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(call.where).toMatchObject({ orderId: 'ord1', venueId: 'v1', printClaimedBy: 'dev1', printedAt: null })
    expect(call.data).toEqual({ printedAt: NOW })
  })
})
