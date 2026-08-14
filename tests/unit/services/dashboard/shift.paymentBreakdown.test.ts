import { buildPaymentBreakdown } from '@/services/dashboard/shift.dashboard.service'

/**
 * El corte del dashboard colapsaba TODO a dos cubetas — `payment.method === 'CASH' ? 'CASH' : 'CARD'` —
 * así que el dueño no veía débito contra crédito aunque la base sí lo guarda por separado, y
 * transferencias / "otro" se pintaban como tarjeta.
 *
 * 🔴 El cambio de una línea (agrupar por el método real) NO era seguro: el denominador de los
 * porcentajes por marca era `paymentMethodMap.get('CARD')`. Al desaparecer esa llave el
 * denominador caía a 1 y una venta VISA de $1,000 se pintaba como 100000%. Ese es el test que
 * más importa aquí.
 */
const pago = (method: string, amount: number, tip = 0, cardBrand: string | null = null) => ({
  amount,
  tipAmount: tip,
  method,
  cardBrand,
  processorData: null,
})

describe('buildPaymentBreakdown — desglose del corte por método real', () => {
  it('separa débito y crédito en renglones distintos (lo que el dueño pidió ver)', () => {
    const { paymentMethodBreakdown } = buildPaymentBreakdown([
      pago('CREDIT_CARD', 300, 0, 'VISA'),
      pago('DEBIT_CARD', 200, 0, 'MASTERCARD'),
      pago('CASH', 100),
    ])

    const metodos = paymentMethodBreakdown.map(m => m.method)
    expect(metodos).toContain('CREDIT_CARD')
    expect(metodos).toContain('DEBIT_CARD')
    expect(metodos).toContain('CASH')
    expect(paymentMethodBreakdown.find(m => m.method === 'DEBIT_CARD')?.total).toBe(200)
  })

  it('🔴 el porcentaje por marca usa SÓLO tarjetas como denominador (no puede dar 100000%)', () => {
    const { cardBrandBreakdown } = buildPaymentBreakdown([
      pago('CREDIT_CARD', 1000, 0, 'VISA'),
      pago('CASH', 500),
    ])

    const visa = cardBrandBreakdown.find(b => b.brand === 'VISA')
    expect(visa?.percentage).toBe(100)
  })

  it('reparte el porcentaje entre marcas de forma que sume 100', () => {
    const { cardBrandBreakdown } = buildPaymentBreakdown([
      pago('CREDIT_CARD', 750, 0, 'VISA'),
      pago('DEBIT_CARD', 250, 0, 'MASTERCARD'),
    ])

    expect(cardBrandBreakdown.find(b => b.brand === 'VISA')?.percentage).toBe(75)
    expect(cardBrandBreakdown.find(b => b.brand === 'MASTERCARD')?.percentage).toBe(25)
  })

  it('una transferencia NO es tarjeta: ni cuenta como tarjeta ni inventa una marca', () => {
    const { paymentMethodBreakdown, cardBrandBreakdown } = buildPaymentBreakdown([
      pago('BANK_TRANSFER', 400),
      pago('CREDIT_CARD', 600, 0, 'VISA'),
    ])

    expect(paymentMethodBreakdown.find(m => m.method === 'BANK_TRANSFER')?.kind).toBe('OTHER')
    // La transferencia no debe aparecer como marca 'OTHER' junto a VISA.
    expect(cardBrandBreakdown.map(b => b.brand)).toEqual(['VISA'])
    expect(cardBrandBreakdown[0].percentage).toBe(100)
  })

  it('cada renglón trae su kind, para que la UI no adivine por "todo lo que no es efectivo"', () => {
    const { paymentMethodBreakdown } = buildPaymentBreakdown([
      pago('CASH', 100),
      pago('DEBIT_CARD', 100, 0, 'VISA'),
      pago('BANK_TRANSFER', 100),
    ])

    const porMetodo = Object.fromEntries(paymentMethodBreakdown.map(m => [m.method, m.kind]))
    expect(porMetodo.CASH).toBe('CASH')
    expect(porMetodo.DEBIT_CARD).toBe('CARD')
    expect(porMetodo.BANK_TRANSFER).toBe('OTHER')
  })

  it('las propinas se reportan por método real, no revueltas', () => {
    const { paymentMethodBreakdown, totalTips } = buildPaymentBreakdown([
      pago('CASH', 100, 20),
      pago('CREDIT_CARD', 200, 30, 'VISA'),
    ])

    expect(paymentMethodBreakdown.find(m => m.method === 'CASH')?.tips).toBe(20)
    expect(paymentMethodBreakdown.find(m => m.method === 'CREDIT_CARD')?.tips).toBe(30)
    expect(totalTips).toBe(50)
  })

  it('trae etiqueta en español lista para pintar', () => {
    const { paymentMethodBreakdown } = buildPaymentBreakdown([pago('DEBIT_CARD', 100, 0, 'VISA')])

    expect(paymentMethodBreakdown[0].label).toBe('Tarjeta de débito')
  })

  it('sin pagos no truena ni divide entre cero', () => {
    const { paymentMethodBreakdown, cardBrandBreakdown, totalSales } = buildPaymentBreakdown([])

    expect(paymentMethodBreakdown).toEqual([])
    expect(cardBrandBreakdown).toEqual([])
    expect(totalSales).toBe(0)
  })
})
