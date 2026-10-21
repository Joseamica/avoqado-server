import logger from '@/config/logger'
import { generateReceiptHTML } from '@/utils/receiptTemplate'

/** El HTML legado (QRs impresos antes de agosto) pinta los totales con la MISMA regla: `ticketTotalsDelSnapshot`. */
const recibo = (
  pago: { amount: number; tipAmount: number },
  orden: { subtotal: number; taxAmount: number; total: number },
  ticketTotals?: unknown,
) =>
  ({
    payment: { id: 'p1', ...pago, method: 'CASH', status: 'COMPLETED', splitType: 'FULLPAYMENT', createdAt: '2026-10-05T18:00:00.000Z' },
    venue: { id: 'v1', name: 'Testarudo', address: '', city: '', state: '', phone: '', email: '' },
    order: { id: 'o1', orderNumber: '42', type: 'TAKEOUT', source: 'POS', tipAmount: 0, ...orden },
    items: [],
    receiptInfo: { accessKey: 'k1', generatedAt: '2026-10-05T18:00:00.000Z', currency: 'MXN', taxRate: 0.16 },
    ticketTotals,
  }) as any

/** Sólo la sección de totales del HTML (para comprobar el ORDEN de los renglones). */
const totales = (html: string) => html.slice(html.indexOf('<div class="totals-section">'), html.indexOf('<!-- Payment Method -->'))

describe('HTML legado del recibo · IVA (IVA por producto, plan 7, D3)', () => {
  it('con IVA incluido dice «IVA incluido cuando aplica» y ya no pinta «Impuestos»', () => {
    const html = generateReceiptHTML(recibo({ amount: 116, tipAmount: 0 }, { subtotal: 116, taxAmount: 0, total: 116 }))
    expect(html).toContain('IVA incluido cuando aplica')
    expect(html).not.toContain('Impuestos')
    expect(html).not.toContain('IVA agregado')
  })
  it('recibo nuevo con IVA aparte y cargo: «IVA agregado» y «Cargo por servicio» con sus cantidades', () => {
    const t = { kind: 'COBRO', desglosado: true, subtotal: 100, serviceCharge: 15, addedTax: 16, tip: 10, total: 141 }
    const html = generateReceiptHTML(recibo({ amount: 131, tipAmount: 10 }, { subtotal: 100, taxAmount: 16, total: 131 }, t))
    expect(html).toContain('IVA agregado')
    expect(html).toContain('$16.00')
    expect(html).toContain('Cargo por servicio')
    expect(html).toContain('$15.00')
    expect(html).toContain('$141.00')
    expect(html).not.toContain('Descuento')
  })
  it('🔴 A7-R6: recibo nuevo con descuento: «Descuento» −$10.00 entre Subtotal y Cargo, en el orden del papel', () => {
    const t = { kind: 'COBRO', desglosado: true, subtotal: 100, discount: 10, serviceCharge: 15, addedTax: 16, tip: 5, total: 126 }
    const html = totales(generateReceiptHTML(recibo({ amount: 121, tipAmount: 5 }, { subtotal: 90, taxAmount: 16, total: 121 }, t)))
    expect(html).toContain('$100.00')
    expect(html).toContain('-$10.00')
    expect(html).toContain('$126.00')
    const orden = ['Subtotal', 'Descuento', 'Cargo por servicio', 'IVA agregado', 'Propina', 'Total pagado'].map(r => html.indexOf(r))
    expect(orden.every(i => i >= 0)).toBe(true)
    expect([...orden].sort((a, b) => a - b)).toEqual(orden)
  })
  it('🔴 recibo viejo de un cobro PARCIAL: el subtotal es lo cobrado ($50), nunca el de la orden ($100)', () => {
    const html = generateReceiptHTML(recibo({ amount: 50, tipAmount: 0 }, { subtotal: 100, taxAmount: 16, total: 116 }))
    expect(html).toContain('$50.00')
    expect(html).not.toContain('$100.00')
    expect(html).not.toContain('$116.00')
    expect(html).toContain('IVA incluido cuando aplica')
  })
  it('🔴 una devolución: «Total reembolsado» en positivo, sin IVA agregado', () => {
    const html = generateReceiptHTML(recibo({ amount: -116, tipAmount: -10 }, { subtotal: 100, taxAmount: 16, total: 116 }))
    expect(html).toContain('Total reembolsado')
    expect(html).toContain('$126.00')
    expect(html).not.toContain('-$')
    expect(html).not.toContain('IVA agregado')
  })
  it('🔴 r2 R2-6: una devolución de sólo propina: «Total reembolsado» $10.00', () => {
    const html = generateReceiptHTML(recibo({ amount: 0, tipAmount: -10 }, { subtotal: 100, taxAmount: 0, total: 110 }))
    expect(html).toContain('Total reembolsado')
    expect(html).toContain('$10.00')
    expect(html).not.toContain('-$')
  })
  it('🔴 la leyenda va sola en su renglón: sin un <span class="value"> vacío (revisión T3 m5)', () => {
    const html = generateReceiptHTML(recibo({ amount: 116, tipAmount: 0 }, { subtotal: 116, taxAmount: 0, total: 116 }))
    expect(html).toContain('IVA incluido cuando aplica')
    expect(html).not.toContain('<span class="value"></span>')
  })
  it('🔴 un recibo cuyo snapshot no trae el cobro sale en $0 y deja un aviso en el log (revisión T3 m2)', () => {
    ;(logger.warn as jest.Mock).mockClear()
    const sinCobro = { ...recibo({ amount: 0, tipAmount: 0 }, { subtotal: 0, taxAmount: 0, total: 0 }), payment: { id: 'p1' } }
    expect(generateReceiptHTML(sinCobro)).toContain('$0.00')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$0'), expect.objectContaining({ paymentId: 'p1' }))
  })
})
