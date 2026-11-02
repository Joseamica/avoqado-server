import {
  renderAreaDelivery,
  renderPayment,
  renderQr,
  renderReference,
  renderSignature,
  renderTotals,
} from '@/services/shared/receiptLayout/blocks/footer'
import { TEMPLATES } from '@/services/shared/receiptLayout/templates'
import { input } from './helpers'

const W = 32
const line = (text: string, bold = false, double = false) => ({ kind: 'text', text, align: 'left', bold, double })
const sp = (n: number) => ' '.repeat(n)
const totals = { type: 'totals', showSubtotal: true, showTax: true, showDiscount: true, showTip: true } as const

describe('renderTotals', () => {
  it.each([32, 48] as const)('EXCHANGE labels the signed total DIFERENCIA at width %i', width => {
    for (const [totalCents, amount] of [
      [-5000, '-$50.00'],
      [0, '$0.00'],
      [5000, '$50.00'],
    ] as const) {
      const r = renderTotals(totals, input({ kind: 'EXCHANGE', subtotalCents: totalCents, totalCents }), width)
      const last = r[r.length - 1]
      expect(last).toMatchObject({ kind: 'text', bold: true, text: expect.stringMatching(/^DIFERENCIA:\s+-?\$\d+\.00$/) })
      if (last.kind === 'text') {
        expect(last.text.endsWith(amount)).toBe(true)
        expect(last.double ? last.text.length * 2 : last.text.length).toBeLessThanOrEqual(width)
      }
    }
  })

  it('IVA incluido (la norma): subtotal, descuento, la LEYENDA sin cantidad, propina, divisor y TOTAL a la mitad del ancho', () => {
    const r = renderTotals(totals, input({ subtotalCents: 4500, discountCents: 500, taxCents: 0, tipCents: 1000, totalCents: 5000 }), W)
    expect(r).toEqual([
      line('Subtotal:' + sp(17) + '$45.00'),
      line('Descuento:' + sp(16) + '-$5.00'),
      line('IVA incluido cuando aplica'),
      line('Propina:' + sp(18) + '$10.00'),
      line('-'.repeat(32)),
      line('TOTAL:' + sp(4) + '$50.00', true, true),
    ])
  })
  it('🔴 venta vieja con IVA APARTE y cargo por servicio: cada uno en su renglón y subtotal − descuento + cargo + IVA + propina = TOTAL', () => {
    const r = renderTotals(
      totals,
      input({ subtotalCents: 4500, discountCents: 500, serviceChargeCents: 400, taxCents: 704, tipCents: 1000, totalCents: 6104 }),
      W,
    )
    expect(r).toEqual([
      line('Subtotal:' + sp(17) + '$45.00'),
      line('Descuento:' + sp(16) + '-$5.00'),
      line('Cargo por servicio:' + sp(8) + '$4.00'),
      line('IVA agregado:' + sp(14) + '$7.04'),
      line('Propina:' + sp(18) + '$10.00'),
      line('-'.repeat(32)),
      line('TOTAL:' + sp(4) + '$61.04', true, true),
    ])
  })
  it('apagar «Mostrar el impuesto» quita la LEYENDA, pero nunca el IVA agregado ni el cargo: son parte de la suma', () => {
    const sinImpuesto = { ...totals, showTax: false }
    const textos = (l: ReturnType<typeof renderTotals>) => l.map(x => (x as { text?: string }).text)
    expect(textos(renderTotals(sinImpuesto, input({ taxCents: 0 }), W))).not.toContain('IVA incluido cuando aplica')
    const r = renderTotals(sinImpuesto, input({ subtotalCents: 4500, serviceChargeCents: 400, taxCents: 704, totalCents: 5604 }), W)
    expect(r).toContainEqual(line('Cargo por servicio:' + sp(8) + '$4.00'))
    expect(r).toContainEqual(line('IVA agregado:' + sp(14) + '$7.04'))
  })
  it('un IVA negativo (motor de descuentos viejo) nunca se imprime: sale la leyenda', () => {
    const r = renderTotals(totals, input({ taxCents: -50 }), W)
    expect(r).toContainEqual(line('IVA incluido cuando aplica'))
    expect(r.some(l => (l as { text?: string }).text?.startsWith('IVA agregado'))).toBe(false)
  })
  it('un cargo grande cabe en las 32 columnas', () => {
    const r = renderTotals(totals, input({ subtotalCents: 4500, serviceChargeCents: 1234567, totalCents: 1239067 }), W)
    expect(r).toContainEqual(line('Cargo por servicio:' + sp(3) + '$12,345.67'))
  })
  it('🔴 un total que no cabe a doble ancho cae a negritas a ancho completo (nunca se parte)', () => {
    const r = renderTotals({ ...totals, showSubtotal: false, showTax: false }, input({ totalCents: 12345678 }), W)
    expect(r[r.length - 1]).toEqual(line('TOTAL:' + sp(15) + '$123,456.78', true, false))
  })
  it('sin propina ni descuento, los interruptores apagan sus renglones; el TOTAL nunca', () => {
    const r = renderTotals({ type: 'totals', showSubtotal: false, showTax: false, showDiscount: false, showTip: false }, input(), W)
    expect(r).toEqual([line('-'.repeat(32)), line('TOTAL:' + sp(4) + '$45.00', true, true)])
  })
  it('🔴 la propina cobrada sale aunque la plantilla «Citas y servicios» la oculte: el papel suma (A7-R7)', () => {
    const deCitas = TEMPLATES.appointments.blocks.find(b => b.type === 'totals') as Parameters<typeof renderTotals>[0]
    expect(deCitas.showTip).toBe(false)
    const r = renderTotals(deCitas, input({ subtotalCents: 35000, tipCents: 3500, totalCents: 38500 }), W)
    expect(r).toContainEqual(line('Propina:' + sp(18) + '$35.00'))
  })
  it('🔴 el descuento aplicado sale aunque el negocio apague «Mostrar descuentos»: el papel suma (A7-R7)', () => {
    const r = renderTotals({ ...totals, showDiscount: false }, input({ subtotalCents: 10000, discountCents: 1000, totalCents: 9000 }), W)
    expect(r).toContainEqual(line('Descuento:' + sp(15) + '-$10.00'))
  })
})

describe('renderPayment — el voucher de tarjeta SIEMPRE lleva autorización y referencia', () => {
  it.each([
    [-5000, 'Devuelto:'],
    [0, 'Pago:'],
    [5000, 'Pago:'],
  ] as const)('EXCHANGE uses the payment label for signed difference %i', (totalCents, label) => {
    const r = renderPayment(
      { type: 'payment', showChange: true, showCardLastFour: true },
      input({ kind: 'EXCHANGE', totalCents, tender: { kind: 'CARD', label: 'Tarjeta', authCode: 'R9X0', referenceNumber: '000777' } }),
      W,
    )
    expect(r[1]).toMatchObject({ kind: 'text', text: expect.stringMatching(new RegExp(`^${label}\\s+Tarjeta$`)) })
    expect(r).toContainEqual(line('Autorización:' + sp(15) + 'R9X0'))
    expect(r).toContainEqual(line('Referencia:' + sp(15) + '000777'))
  })

  it('tarjeta', () => {
    const r = renderPayment(
      { type: 'payment', showChange: true, showCardLastFour: true },
      input({
        tender: {
          kind: 'CARD',
          label: 'Tarjeta',
          cardBrand: 'VISA',
          cardLastFour: '1234',
          authCode: 'A1B2C3',
          referenceNumber: '000123',
        },
      }),
      W,
    )
    expect(r).toEqual([
      { kind: 'feed', lines: 1 },
      line('Pago:' + sp(20) + 'Tarjeta'),
      line('Tarjeta:' + sp(10) + 'VISA **** 1234'),
      line('Autorización:' + sp(13) + 'A1B2C3'),
      line('Referencia:' + sp(15) + '000123'),
    ])
  })
  it('apagar los últimos 4 no apaga la autorización', () => {
    const r = renderPayment(
      { type: 'payment', showChange: true, showCardLastFour: false },
      input({ tender: { kind: 'CARD', label: 'Tarjeta', cardLastFour: '1234', authCode: 'A1B2C3' } }),
      W,
    )
    expect(r.map(l => (l as { text?: string }).text)).toEqual([
      undefined,
      'Pago:' + sp(20) + 'Tarjeta',
      'Autorización:' + sp(13) + 'A1B2C3',
    ])
  })
  it('efectivo: recibido y cambio (en negritas); sin cambio no hay renglón', () => {
    expect(renderPayment({ type: 'payment', showChange: true, showCardLastFour: true }, input(), W)).toEqual([
      { kind: 'feed', lines: 1 },
      line('Pago:' + sp(19) + 'Efectivo'),
      line('Recibido:' + sp(17) + '$50.00'),
      line('Cambio:' + sp(20) + '$5.00', true),
    ])
    const exacto = renderPayment(
      { type: 'payment', showChange: true, showCardLastFour: true },
      input({ tender: { kind: 'CASH', label: 'Efectivo', tenderedCents: 4500, changeCents: 0 } }),
      W,
    )
    expect(exacto).toHaveLength(3)
  })
  it('P1 una etiqueta de pago larga no se pasa del ancho', () => {
    const r = renderPayment(
      { type: 'payment', showChange: true, showCardLastFour: true },
      input({ tender: { kind: 'OTHER', label: 'Transferencia bancaria BBVA empresarial' } }),
      W,
    )
    for (const l of r) if (l.kind === 'text') expect(l.text.length).toBeLessThanOrEqual(W)
  })
  it('P1 pre-cuenta: sin tender el bloque de pago no imprime nada', () => {
    expect(renderPayment({ type: 'payment', showChange: true, showCardLastFour: true }, input({ tender: null }), W)).toEqual([])
  })
})

describe('renderAreaDelivery', () => {
  it('sin código no imprime nada; con código: barras y el código en grande y negritas', () => {
    expect(renderAreaDelivery({ type: 'areaDelivery' }, input(), W)).toEqual([])
    const r = renderAreaDelivery({ type: 'areaDelivery' }, input({ areaDeliveryCode: '9016719357' }), W)
    expect(r[0]).toEqual({ kind: 'feed', lines: 1 })
    expect(r[1]).toEqual(line('='.repeat(32)))
    expect(r[2]).toEqual({ kind: 'text', text: 'ENTREGA POR ÁREA', align: 'center', bold: true, double: false })
    expect(r).toContainEqual({ kind: 'barcode', data: '9016719357' })
    expect(r[r.length - 1]).toEqual({ kind: 'text', text: '9016719357', align: 'center', bold: true, double: true })
  })
})

describe('renderQr, renderReference, renderSignature', () => {
  it('pendingUpload has no QR, including when a stale receipt URL is present', () => {
    for (const receiptUrl of [null, 'https://r.avoqado.io/x/abc']) {
      expect(renderQr({ type: 'qr', caption: 'Escanea' }, input({ kind: 'EXCHANGE', pendingUpload: true, receiptUrl }), W)).toEqual([])
    }
    expect(renderQr({ type: 'qr', caption: 'Escanea' }, input({ kind: 'EXCHANGE', pendingUpload: false }), W)).toContainEqual({
      kind: 'qr',
      data: 'https://r.avoqado.io/x/abc',
    })
  })

  it('QR sólo con URL; la leyenda se sanea', () => {
    expect(renderQr({ type: 'qr', caption: 'Escanea' }, input({ receiptUrl: null }), W)).toEqual([])
    const r = renderQr({ type: 'qr', caption: 'Escanea para tu recibo' }, input(), W)
    expect(r).toContainEqual({ kind: 'qr', data: 'https://r.avoqado.io/x/abc' })
    expect(r).toContainEqual({ kind: 'text', text: 'Escanea para tu recibo', align: 'center', bold: false, double: false })
  })
  it('P1 sin autofactura la leyenda POR DEFECTO no promete factura; una leyenda propia se respeta', () => {
    const def = renderQr({ type: 'qr', caption: 'Escanea para tu recibo y factura' }, input({ autofacturaAvailable: false }), W)
    expect(def).toContainEqual({ kind: 'text', text: 'Escanea para tu recibo digital', align: 'center', bold: false, double: false })
    const propia = renderQr({ type: 'qr', caption: 'Síguenos y factura' }, input({ autofacturaAvailable: false }), W)
    expect(propia).toContainEqual({ kind: 'text', text: 'Síguenos y factura', align: 'center', bold: false, double: false })
    const desconocido = renderQr({ type: 'qr', caption: 'Escanea para tu recibo y factura' }, input(), 48)
    expect(desconocido).toContainEqual({
      kind: 'text',
      text: 'Escanea para tu recibo y factura',
      align: 'center',
      bold: false,
      double: false,
    })
  })
  it('referencia: ID y versión según sus interruptores', () => {
    expect(
      renderReference({ type: 'reference', showTransactionId: true, showAppVersion: true }, input({ appVersion: '3.1.0' }), W),
    ).toEqual([
      { kind: 'text', text: 'ID: pay_123', align: 'center', bold: false, double: false },
      { kind: 'text', text: 'Avoqado v3.1.0', align: 'center', bold: false, double: false },
    ])
    expect(renderReference({ type: 'reference', showTransactionId: false, showAppVersion: false }, input(), W)).toEqual([])
  })
  it('🔴 la firma: isotipo, «Powered by Avoqado» y el corte — siempre igual', () => {
    expect(renderSignature({ type: 'signature' }, input(), W)).toEqual([
      { kind: 'feed', lines: 1 },
      { kind: 'image', ref: 'avoqadoMark', widthPct: 15, align: 'center' },
      { kind: 'feed', lines: 1 },
      { kind: 'text', text: 'Powered by Avoqado', align: 'center', bold: false, double: false },
      { kind: 'cut' },
    ])
  })
})
