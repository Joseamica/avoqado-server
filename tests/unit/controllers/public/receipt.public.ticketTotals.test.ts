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

/**
 * D1 «fotocopia del ticket»: con la copia que guardó el cobro de una parte, el HTML pinta SUS renglones y los totales del papel, también
 * en el ramal que pintaba `items` directo sin `parcial` (Codex plan r3 #2), y escapa TODOS los textos del renglón (r2 #1, r4 #1).
 */
describe('GET /public/receipt/:accessKey — HTML legado con la copia del ticket', () => {
  const pintar = async (dataSnapshot: Record<string, unknown>) => {
    ;(getDigitalReceiptByAccessKey as jest.Mock).mockResolvedValue({ id: 'r1', accessKey: 'k1', paymentId: 'p1', status: 'SENT', dataSnapshot })
    const res: any = { setHeader: jest.fn(), status: jest.fn(() => res), send: jest.fn(), json: jest.fn() }
    await getPublicReceipt({ params: { accessKey: 'k1' }, get: () => 'text/html' } as any, res, jest.fn())
    return res.send.mock.calls[0][0] as string
  }
  const base = {
    payment: { id: 'p1', amount: 27, tipAmount: 0, method: 'CASH', status: 'COMPLETED', createdAt: '2026-10-28T18:00:00.000Z' },
    venue: { id: 'v1', name: 'Testarudo' },
    order: { id: 'o1', number: '42', subtotal: 50, taxAmount: 0, total: 50 },
    items: [
      { productName: 'Café Americano', quantity: 1, unitPrice: 30, total: 30 },
      { productName: 'Agua Mineral 1L', quantity: 1, unitPrice: 20, total: 20 },
    ],
  }
  const copia = {
    lineas: [
      {
        nombre: 'Café <b>Americano</b>',
        cantidad: 1,
        unitarioCents: 3000,
        totalCents: 3000,
        modificadores: ['<i>Sin azúcar</i>'],
        peso: '<u>0.5 kg</u>',
        nota: '"<script>x</script>"',
        area: '<b>Barra</b>',
      },
    ],
    subtotalCents: 3000,
    descuentoCents: 300,
  }

  it('sin `parcial` y con `items`, la copia manda: sólo el Café, Subtotal $30, Descuento −$3, Total $27', async () => {
    const html = await pintar({ ...base, ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 27, serviceCharge: 0, addedTax: 0, tip: 0, total: 27 },
      lineasDelTicket: copia })
    const renglones = html.slice(html.indexOf('<div class="items-list">'), html.indexOf('<div class="totals-section">'))
    expect(renglones).toContain('Café &lt;b&gt;Americano&lt;/b&gt;')
    expect(renglones).not.toContain('Agua Mineral')
    expect(renglones).not.toContain('Pago parcial')
    const totales = html.slice(html.indexOf('<div class="totals-section">'), html.indexOf('<!-- Payment Method -->'))
    expect(totales).toContain('$30.00')
    expect(totales).toContain('-$3.00')
    expect(totales).toContain('$27.00')
  })

  it('con `parcial`, la copia manda en vez de «Pago parcial»', async () => {
    const html = await pintar({ ...base, ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 27, serviceCharge: 0, addedTax: 0, tip: 0, total: 27,
      parcial: true }, lineasDelTicket: copia })
    expect(html).toContain('Café &lt;b&gt;Americano&lt;/b&gt;')
    expect(html).not.toContain('Pago parcial')
  })

  it('escapa nombre, modificador, peso, nota y área: nada de la copia llega como HTML', async () => {
    const html = await pintar({ ...base, ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 27, serviceCharge: 0, addedTax: 0, tip: 0, total: 27 },
      lineasDelTicket: copia })
    for (const crudo of ['<b>Americano</b>', '<i>Sin azúcar</i>', '<u>0.5 kg</u>', '<script>x</script>', '<b>Barra</b>']) {
      expect(html).not.toContain(crudo)
    }
    expect(html).toContain('&lt;i&gt;Sin azúcar&lt;/i&gt;')
    expect(html).toContain('&lt;u&gt;0.5 kg&lt;/u&gt;')
    expect(html).toContain('&quot;&lt;script&gt;x&lt;/script&gt;&quot;')
    expect(html).toContain('&lt;b&gt;Barra&lt;/b&gt;')
  })

  it('pinta «Cortesía» en vez del precio, la pieza del combo sin precio y los modificadores sin $0.00 (Codex código r1 #1)', async () => {
    const html = await pintar({ ...base, ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 45, serviceCharge: 0, addedTax: 0, tip: 0, total: 45 },
      lineasDelTicket: {
        lineas: [
          { nombre: 'Combo Desayuno', cantidad: 1, unitarioCents: 4500, totalCents: 4500, modificadores: ['Sin azúcar'] },
          { nombre: 'Papas', cantidad: 1, unitarioCents: 0, totalCents: 0, pieza: true },
          { nombre: 'Galleta', cantidad: 1, unitarioCents: 1500, totalCents: 1500, cortesia: true },
        ],
        subtotalCents: 6000,
        descuentoCents: 1500,
      } })
    const renglones = html.slice(html.indexOf('<div class="items-list">'), html.indexOf('<div class="totals-section">'))
    expect(renglones).toContain('Cortesía')
    expect(renglones).not.toContain('$15.00')
    expect(renglones).toContain('1x Papas')
    expect(renglones).not.toContain('$0.00')
    expect(renglones).toContain('+ Sin azúcar')
  })

  it('control: sin copia, el ramal de siempre pinta los `items` de la venta', async () => {
    const html = await pintar({ ...base, ticketTotals: { kind: 'COBRO', desglosado: false, subtotal: 50, serviceCharge: 0, addedTax: 0, tip: 0, total: 50 } })
    expect(html).toContain('Café Americano')
    expect(html).toContain('Agua Mineral 1L')
  })
})
