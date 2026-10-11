jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  __esModule: true,
  getDigitalReceiptByAccessKey: jest.fn(),
}))

import { getPublicReceipt } from '@/controllers/public/receipt.public.controller'
import { getDigitalReceiptByAccessKey } from '@/services/tpv/digitalReceipt.tpv.service'

/**
 * La rama HTML (LEGADO: QRs impresos antes de agosto) del recibo público pinta los totales CONGELADOS del snapshot
 * (`dataSnapshot.ticketTotals`, plan 7 D3), no los que se reconstruirían del cobro (revisión T3 m1).
 */
describe('GET /public/receipt/:accessKey — HTML legado con los totales congelados', () => {
  // El cobro pagó la venta entera: bruto $100 − desc. $10 + cargo $15 + IVA aparte $16 = $121, más $5 de propina.
  // Sin el snapshot, el HTML caería a «lo cobrado sin desglose» (Subtotal $121, Total $126): ni Descuento, ni Cargo, ni IVA.
  const ticketTotals = { kind: 'COBRO', desglosado: true, subtotal: 100, discount: 10, serviceCharge: 15, addedTax: 16, tip: 5, total: 126 }

  it('🔴 el HTML lleva el Descuento, el Cargo y el IVA agregado congelados en el recibo', async () => {
    ;(getDigitalReceiptByAccessKey as jest.Mock).mockResolvedValue({
      id: 'r1',
      accessKey: 'k1',
      paymentId: 'p1',
      status: 'SENT',
      dataSnapshot: {
        payment: { id: 'p1', amount: 121, tipAmount: 5, method: 'CASH', status: 'COMPLETED', createdAt: '2026-10-05T18:00:00.000Z' },
        venue: { id: 'v1', name: 'Testarudo' },
        order: { id: 'o1', number: '42', subtotal: 90, taxAmount: 16, total: 121, items: [] },
        ticketTotals,
      },
    })
    const res: any = { setHeader: jest.fn(), status: jest.fn(() => res), send: jest.fn(), json: jest.fn() }
    const next = jest.fn()
    await getPublicReceipt({ params: { accessKey: 'k1' }, get: () => 'text/html' } as any, res, next)

    expect(next).not.toHaveBeenCalled()
    const html: string = res.send.mock.calls[0][0]
    const totales = html.slice(html.indexOf('<div class="totals-section">'), html.indexOf('<!-- Payment Method -->'))
    expect(totales).toContain('Descuento')
    expect(totales).toContain('-$10.00')
    expect(totales).toContain('Cargo por servicio')
    expect(totales).toContain('IVA agregado')
    expect(totales).toContain('$16.00')
    expect(totales).toContain('$126.00')
  })
})
