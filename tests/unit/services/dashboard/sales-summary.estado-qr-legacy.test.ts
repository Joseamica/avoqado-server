/**
 * Carril C (21-nov-2026, Codex r4 #4 y r5 #1): con el filtro «QR del sistema anterior» (Mindform) getSalesSummary sale temprano.
 * Si se pide el desglose (exporte / MCP con `sections=statement`), el estado del periodo trae ese dinero en «otros»; con un
 * comercio elegido, nada (esos cobros no tienen comercio), igual que la ruta normal.
 */
jest.mock('@/services/legacy/qrPayments.legacy.service', () => ({
  ...jest.requireActual('@/services/legacy/qrPayments.legacy.service'),
  forEachLegacyPaymentPage: jest.fn(async (_f: unknown, consume: (rows: unknown[]) => void) => {
    consume([
      { status: 'COMPLETED', type: 'PAYMENT', amount: 90, tipAmount: 10, method: 'CARD' },
      { status: 'COMPLETED', type: 'REFUND', amount: -5, tipAmount: 0, method: 'CARD' },
    ])
    return { unavailable: false }
  }),
}))

import { flattenSalesSummaryForExport, getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import { MINDFORM_NEW_VENUE_ID } from '@/services/legacy/qrPayments.legacy.service'

const rango = { startDate: '2026-11-21T06:00:00.000Z', endDate: '2026-11-22T05:59:59.999Z', paymentMethod: 'QR_LEGACY' as const }

describe('getSalesSummary · QR del sistema anterior con el estado del periodo', () => {
  it('con el desglose pedido, el dinero del QR anterior sale en «otros» y «Te queda» lo incluye', async () => {
    const r = await getSalesSummary(MINDFORM_NEW_VENUE_ID, { ...rango, includeMerchantBreakdown: true })
    expect(r.statementDestinations?.other).toEqual(expect.objectContaining({ collected: 100, netToReceive: 100, transactionCount: 1 }))
    expect(r.byMerchantAccount).toEqual([])
    const v = Object.fromEntries(flattenSalesSummaryForExport(r, ['statement']).rows.map(x => [x.label, x.amount]))
    expect([v['Te queda'], v['Otros métodos']]).toEqual([100, 100])
  })

  it('con un comercio elegido no se le atribuye el QR anterior (no tiene comercio)', async () => {
    const r = await getSalesSummary(MINDFORM_NEW_VENUE_ID, { ...rango, includeMerchantBreakdown: true, merchantAccountId: 'ma-a' })
    expect(r.statementDestinations?.other.transactionCount).toBe(0)
    const v = Object.fromEntries(flattenSalesSummaryForExport(r, ['statement']).rows.map(x => [x.label, x.amount]))
    expect(v['Te queda']).toBe(0)
  })

  it('sin el desglose, la respuesta de siempre (sin estado del periodo)', async () => {
    const r = await getSalesSummary(MINDFORM_NEW_VENUE_ID, rango)
    expect(r.statementDestinations).toBeUndefined()
    expect(r.byMerchantAccount).toBeUndefined()
  })

  it('🔴 D16.2 (carril F, Codex r5 #3) · «Cobrado» también con este filtro: cobros aceptados con propina, y la cuenta cierra', async () => {
    const r = await getSalesSummary(MINDFORM_NEW_VENUE_ID, rango)
    const s = r.summary
    expect(s.chargedAmount).toBe(100)
    expect((s.chargedAmount ?? 0) - s.refunds - s.platformFees - (s.tenderCommissions ?? 0)).toBe(s.totalCollected)
  })
})

