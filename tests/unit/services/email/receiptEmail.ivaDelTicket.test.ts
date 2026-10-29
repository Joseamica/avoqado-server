jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import emailService from '@/services/email.service'

/** El correo del recibo: mismos renglones que el ticket (plan 7, D3). */
type Sent = { html?: string; text?: string }
const BASE = {
  venueName: 'Testarudo',
  receiptUrl: 'https://dashboard.avoqado.io/receipts/public/k1',
  receiptNumber: 'K1',
  paymentMethod: 'CASH',
}

async function enviar(data: Record<string, unknown>): Promise<Sent> {
  const sent: Sent[] = []
  const spy = jest.spyOn(emailService, 'sendEmail').mockImplementation(async (opts: any) => (sent.push(opts), true))
  await emailService.sendReceiptEmail('cliente@x.mx', { ...BASE, ...data } as any)
  spy.mockRestore()
  return sent[0]
}

describe('correo del recibo · IVA y cargo', () => {
  it('IVA agregado y cargo por servicio en su renglón; ya no dice «Impuestos»', async () => {
    const s = await enviar({ subtotal: 100, serviceChargeAmount: 15, taxAmount: 16, tipAmount: 10, totalAmount: 141, leyendaIva: false })
    for (const cuerpo of [s.html!, s.text!]) {
      expect(cuerpo).toContain('IVA agregado')
      expect(cuerpo).toContain('Cargo por servicio')
      expect(cuerpo).not.toContain('Impuestos')
      expect(cuerpo).not.toContain('Descuento')
    }
  })
  it('🔴 A7-R6: con descuento, «Descuento» −$10.00 entre Subtotal y Cargo, en el orden del papel (HTML y texto)', async () => {
    const s = await enviar({
      subtotal: 100,
      discountAmount: 10,
      serviceChargeAmount: 15,
      taxAmount: 16,
      tipAmount: 5,
      totalAmount: 126,
      leyendaIva: false,
    })
    for (const cuerpo of [s.html!, s.text!]) {
      expect(cuerpo).toContain('-$10.00')
      const orden = ['Subtotal', 'Descuento', 'Cargo por servicio', 'IVA agregado', 'Propina'].map(r => cuerpo.indexOf(r))
      expect(orden.every(i => i >= 0)).toBe(true)
      expect([...orden].sort((a, b) => a - b)).toEqual(orden)
      expect(cuerpo.indexOf('$126.00')).toBeGreaterThan(orden[4])
    }
  })
  it('con IVA incluido dice la leyenda en el HTML y en el texto', async () => {
    const s = await enviar({ subtotal: 116, taxAmount: 0, tipAmount: 0, totalAmount: 116, leyendaIva: true })
    expect(s.html).toContain('IVA incluido cuando aplica')
    expect(s.text).toContain('IVA incluido cuando aplica')
  })
  it('una devolución dice «Total reembolsado»', async () => {
    const s = await enviar({ subtotal: 116, taxAmount: 0, tipAmount: 10, totalAmount: 126, leyendaIva: true, esDevolucion: true })
    expect(s.html).toContain('Total reembolsado')
    expect(s.text).toContain('Total reembolsado')
    expect(s.html).not.toContain('-$')
    expect(s.text).not.toContain('-$')
  })
  it('control — sin los campos nuevos (correo de ligas de pago) sale como hoy, sin leyenda', async () => {
    const s = await enviar({ subtotal: 116, tipAmount: 0, totalAmount: 116 })
    expect(s.html).not.toContain('IVA incluido cuando aplica')
    expect(s.html).toContain('Total')
  })
})

describe('correo del recibo · D1 fotocopia del ticket', () => {
  it('escapa los textos de cada renglón (nombre, modificador, peso, área y nota) y pinta peso, área y nota', async () => {
    const s = await enviar({
      subtotal: 30,
      discountAmount: 3,
      totalAmount: 27,
      items: [{ name: 'Café <b>Am</b>', quantity: 1, price: 30, totalPrice: 30, modifiers: [{ name: '<i>Sin</i>', price: 0 }],
                peso: '<u>0.5 kg</u>', area: '<b>Barra</b>', nota: '"<script>x</script>"' }],
    })
    for (const crudo of ['<b>Am</b>', '<i>Sin</i>', '<u>0.5 kg</u>', '<b>Barra</b>', '<script>x</script>']) expect(s.html).not.toContain(crudo)
    expect(s.html).toContain('Café &lt;b&gt;Am&lt;/b&gt;')
    expect(s.html).toContain('&lt;u&gt;0.5 kg&lt;/u&gt;')
    expect(s.html).toContain('&lt;b&gt;Barra&lt;/b&gt;')
    expect(s.html).toContain('&quot;&lt;script&gt;x&lt;/script&gt;&quot;')
  })
})
