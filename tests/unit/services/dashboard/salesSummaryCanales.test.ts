/**
 * Carril G · D4: las piezas puras del desglose por canal (el cuadre contra la cabecera vive en la prueba de integración
 * `sales-summary-canales`, contra Postgres).
 */
import {
  canalDeLaCuenta,
  centavosComoSeVen,
  computeSalesByChannel,
  repartirCentavos,
  tipoDeLaCuenta,
} from '@/services/dashboard/salesSummaryCanales'

describe('canalDeLaCuenta', () => {
  it('caja, terminal y tablets: «Mesas» con mesa, «Mostrador» sin ella', () => {
    for (const s of ['TPV', 'POS', 'AVOQADO_ANDROID', 'AVOQADO_IOS', 'APP']) {
      expect(canalDeLaCuenta(s, true)).toBe('TABLES')
      expect(canalDeLaCuenta(s, false)).toBe('COUNTER')
    }
  })

  it('los demás canales no dependen de la mesa, y una fuente desconocida no se pierde', () => {
    expect(canalDeLaCuenta('QR', true)).toBe('QR')
    // `WEB` es la tienda sólo con su pedido en línea; sin él es el checkout de un monto (Codex r1 #7).
    expect(canalDeLaCuenta('WEB', false, true)).toBe('ONLINE_STORE')
    expect(canalDeLaCuenta('WEB', false)).toBe('WEB_CHECKOUT')
    expect(canalDeLaCuenta('PAYMENT_LINK', false)).toBe('PAYMENT_LINK')
    expect(canalDeLaCuenta('DASHBOARD_MANUAL', false)).toBe('DASHBOARD')
    expect(canalDeLaCuenta('RAPPI', false)).toBe('RAPPI')
    expect(canalDeLaCuenta('UBER_EATS', false)).toBe('UBER_EATS')
    expect(canalDeLaCuenta('DIDI_FOOD', false)).toBe('DIDI_FOOD')
    expect(canalDeLaCuenta('DELIVERY_PLATFORM', false)).toBe('OTHER_DELIVERY')
    expect(canalDeLaCuenta('KIOSK', true)).toBe('KIOSK')
    expect(canalDeLaCuenta('PHONE', false)).toBe('PHONE')
    expect(canalDeLaCuenta('ALGO_NUEVO', false)).toBe('OTHER')
    expect(tipoDeLaCuenta('PICKUP')).toBe('PICKUP')
    expect(tipoDeLaCuenta('ALGO_NUEVO')).toBe('OTHER')
    // TPV · PAGO RÁPIDO guarda TAKEOUT, pero no es «para llevar»: es el cobro de un monto (Codex r1 #6).
    expect(tipoDeLaCuenta('TAKEOUT', true)).toBe('QUICK_PAYMENT')
  })
})

describe('repartirCentavos', () => {
  it('🔴 dos comisiones de $0.005 suman el $0.01 de la cabecera, no $0.02 ni $0.00', () => {
    expect(repartirCentavos([0.005, 0.005], 1)).toEqual([1, 0])
  })

  it('el residuo va al renglón con la fracción más grande y la suma es exacta', () => {
    const out = repartirCentavos([7.1283, 0.0051, 4.5, 9], 2063)
    expect(out).toEqual([713, 0, 450, 900])
    expect(out.reduce((s, v) => s + v, 0)).toBe(2063)
  })

  it('importes de dos decimales quedan tal cual, también los negativos', () => {
    expect(repartirCentavos([180, -30, 0.1], 15010)).toEqual([18000, -3000, 10])
  })
})

describe('computeSalesByChannel', () => {
  it('el QR viejo de Mindform sale como su propio renglón en las dos tablas, con lo que sumó la cabecera', async () => {
    const db = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) }
    const r = await computeSalesByChannel('v', new Date(), new Date(), { legacy: { amount: 300, tips: 30, count: 3 }, db: db as never })
    for (const filas of [r.byChannel, r.byOrderType]) {
      expect(filas).toEqual([
        expect.objectContaining({ key: 'QR_LEGACY', grossSales: 300, netSales: 300, tips: 30, totalCollected: 330, transactionCount: 3 }),
      ])
    }
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(2)
  })

  it('reparte los renglones por conjunto: (fuente, mesa) ⇒ canal y tipo ⇒ tipo de pedido', async () => {
    const cuentas = [
      {
        source: 'TPV',
        mesa: true,
        tipo: null,
        por_tipo: 1,
        bruto: '100',
        descuentos: '10',
        promo_centavos: '500',
        cortesias: '0',
        cuentas: 1,
      },
      {
        source: null,
        mesa: null,
        tipo: 'DINE_IN',
        por_tipo: 0,
        bruto: '100',
        descuentos: '10',
        promo_centavos: '500',
        cortesias: '0',
        cuentas: 1,
      },
    ]
    const cobros = [
      {
        source: 'TPV',
        mesa: true,
        tipo: null,
        por_tipo: 1,
        propinas: '9',
        cobros: 1,
        comision: '1.5',
        terceros: '0',
        devuelto: '-20',
        reabierto: '0',
        devoluciones: 1,
        devoluciones_de_abono: 0,
      },
      {
        source: null,
        mesa: null,
        tipo: 'DINE_IN',
        por_tipo: 0,
        propinas: '9',
        cobros: 1,
        comision: '1.5',
        terceros: '0',
        devuelto: '-20',
        reabierto: '0',
        devoluciones: 1,
        devoluciones_de_abono: 0,
      },
    ]
    const db = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce(cuentas).mockResolvedValueOnce(cobros) }
    const r = await computeSalesByChannel('v', new Date(), new Date(), { db: db as never })
    // La promoción de $5 va a los dos lados (como la cabecera): bruto 105, descuentos 15; neto 105 − 15 − 20 = 70.
    const esperado = {
      grossSales: 105,
      discounts: 15,
      refunds: 20,
      netSales: 70,
      tips: 9,
      platformFees: 1.5,
      totalCollected: 77.5,
      orderCount: 1,
      transactionCount: 1,
      refundCount: 1,
    }
    expect(r.byChannel).toEqual([{ key: 'TABLES', tenderCommissions: 0, ...esperado }])
    expect(r.byOrderType).toEqual([{ key: 'DINE_IN', tenderCommissions: 0, ...esperado }])
  })

  it('🔴 cada columna se reparte hasta la cifra de la cabecera (su resta en Number redondea distinto), sin esconder un descuadre real', async () => {
    const cobros = (comision: string) => [
      {
        source: 'TPV',
        mesa: false,
        tipo: null,
        por_tipo: 1,
        propinas: '0',
        cobros: 1,
        comision,
        terceros: '0',
        devuelto: '0',
        reabierto: '0',
        devoluciones: 0,
        devoluciones_de_abono: 0,
      },
    ]
    const cuentas = [
      {
        source: 'TPV',
        mesa: false,
        tipo: null,
        por_tipo: 1,
        bruto: '6.30',
        descuentos: '0',
        promo_centavos: '0',
        cortesias: '0',
        cuentas: 1,
      },
    ]
    // $6.30 − $0.3150: la cabecera enseña $5.98 (5.984999…); el decimal exacto redondearía a $5.99.
    let db = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce(cuentas).mockResolvedValueOnce(cobros('0.3150')) }
    let r = await computeSalesByChannel('v', new Date(), new Date(), { db: db as never, cabecera: { totalCollected: 6.3 - 0.315 } })
    expect(r.byChannel[0].totalCollected).toBe(5.98)
    // Si la cabecera dice otra cosa que no es redondeo, la tabla dice lo suyo (y lo avisa en el log): no reparte un descuadre.
    db = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce(cuentas).mockResolvedValueOnce(cobros('0.3150')) }
    r = await computeSalesByChannel('v', new Date(), new Date(), { db: db as never, cabecera: { totalCollected: 10 } })
    expect(r.byChannel[0].totalCollected).toBe(5.98)
    expect(centavosComoSeVen(6.3 - 0.315)).toBe(598)
    expect(centavosComoSeVen(-(6.3 - 0.315))).toBe(-598)
  })
})
