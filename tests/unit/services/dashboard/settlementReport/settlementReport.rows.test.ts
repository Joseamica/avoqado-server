import {
  agruparDepositos,
  clasificarOperacion,
  desglosarComision,
  diasDeRetroceso,
  neutralizarFormula,
  reglaEsValida,
  type TransactionRow,
} from '@/services/dashboard/settlementReport/settlementReport.rows'

const fila = (o: Partial<TransactionRow>): TransactionRow => ({
  paymentId: 'p',
  venueName: 'V',
  folio: 'f',
  fechaCobro: '2026-08-31 18:38',
  terminal: null,
  autorizacion: null,
  ultimos4: null,
  tipoTarjeta: 'DEBIT',
  operacion: 'SALE',
  marca: null,
  consumo: 60,
  propina: 0,
  total: 60,
  comision: 1.17,
  ivaComision: 0.19,
  totalComision: 1.36,
  montoADepositar: 58.64,
  fechaDeposito: '2026-09-01',
  motivoSinFecha: null,
  ...o,
})

describe('clasificarOperacion', () => {
  it('venta, devolución y devolución de propina', () => {
    expect(clasificarOperacion(60, 0)).toBe('SALE')
    expect(clasificarOperacion(0, 5)).toBe('SALE')
    expect(clasificarOperacion(-65, 0)).toBe('REFUND')
    expect(clasificarOperacion(-65, -5)).toBe('REFUND')
    expect(clasificarOperacion(0, -5)).toBe('TIP_REFUND')
  })
})

describe('reglaEsValida (D10)', () => {
  it('acepta 0..30 de los dos tipos y rechaza lo demás', () => {
    expect(reglaEsValida({ settlementDays: 0, settlementDayType: 'BUSINESS_DAYS' })).toBe(true)
    expect(reglaEsValida({ settlementDays: 30, settlementDayType: 'CALENDAR_DAYS' })).toBe(true)
    expect(reglaEsValida({ settlementDays: 31, settlementDayType: 'BUSINESS_DAYS' })).toBe(false)
    expect(reglaEsValida({ settlementDays: -1, settlementDayType: 'BUSINESS_DAYS' })).toBe(false)
    expect(reglaEsValida({ settlementDays: 1.5, settlementDayType: 'BUSINESS_DAYS' })).toBe(false)
    expect(reglaEsValida({ settlementDays: 1, settlementDayType: 'RARO' as never })).toBe(false)
  })
})

describe('diasDeRetroceso', () => {
  it('toma el horizonte mayor de las reglas válidas', () => {
    expect(diasDeRetroceso([])).toBe(0)
    expect(diasDeRetroceso([{ settlementDays: 11, settlementDayType: 'BUSINESS_DAYS' }])).toBe(32) // ceil(15.4)=16 +1 +15
    expect(diasDeRetroceso([{ settlementDays: 2, settlementDayType: 'CALENDAR_DAYS' }])).toBe(3)
    expect(diasDeRetroceso([{ settlementDays: 30, settlementDayType: 'BUSINESS_DAYS' }])).toBe(58)
    // una inválida no cuenta: sus cobros salen «Sin calcular»
    expect(diasDeRetroceso([{ settlementDays: 400, settlementDayType: 'BUSINESS_DAYS' }])).toBe(0)
  })
})

describe('desglosarComision', () => {
  const ev = { includesTax: false, taxRate: '0.16' }
  it('separa base e IVA; base + IVA = total exacto', () => {
    expect(desglosarComision(1.36, ev, 0)).toEqual({ comision: 1.17, iva: 0.19 })
    expect(desglosarComision(0.03, ev, 0)).toEqual({ comision: 0.03, iva: 0 })
    expect(desglosarComision(-3.91, { includesTax: true, taxRate: '0.16' }, 0)).toEqual({ comision: -3.37, iva: -0.54 })
  })
  it('tasa 0: todo es base', () => {
    expect(desglosarComision(2, { includesTax: true, taxRate: '0' }, 0)).toEqual({ comision: 2, iva: 0 })
  })
  it('sin evidencia, includesTax nulo, tasa nula o ilegible, o con cargo fijo ⇒ vacío', () => {
    const vacio = { comision: null, iva: null }
    expect(desglosarComision(1.36, null, 0)).toEqual(vacio)
    expect(desglosarComision(1.36, { includesTax: null, taxRate: '0.16' }, 0)).toEqual(vacio)
    expect(desglosarComision(1.36, { includesTax: false, taxRate: null }, 0)).toEqual(vacio)
    expect(desglosarComision(1.36, { includesTax: false, taxRate: 'x' }, 0)).toEqual(vacio)
    expect(desglosarComision(1.36, ev, 0.5)).toEqual(vacio)
  })
})

describe('neutralizarFormula', () => {
  it('antepone apóstrofo a lo que una hoja interpretaría como fórmula', () => {
    for (const s of ['=1+1', '+52', '-3', '@SUM(A1)', '\tx', '\rx', '\nx', ' =1', ' =1', '　=1']) {
      expect(neutralizarFormula(s)).toBe(`'${s}`)
    }
    expect(neutralizarFormula('000123')).toBe('000123')
    expect(neutralizarFormula('Visa')).toBe('Visa')
  })
})

describe('agruparDepositos', () => {
  it('suma los renglones ya redondeados por día; el desglose del día sólo si todos lo tienen', () => {
    const r = agruparDepositos([
      fila({ paymentId: 'a', consumo: 60, total: 60, comision: 0.03, ivaComision: 0, totalComision: 0.03, montoADepositar: 59.97 }),
      fila({
        paymentId: 'b',
        consumo: 60,
        total: 60,
        comision: 0.03,
        ivaComision: 0,
        totalComision: 0.03,
        montoADepositar: 59.97,
        fechaCobro: '2026-08-31 19:00',
      }),
      fila({ paymentId: 'c', fechaDeposito: '2026-09-02', comision: null, ivaComision: null }),
    ])
    expect(r.depositos).toEqual([
      {
        fechaDeposito: '2026-09-01',
        primerCobro: '2026-08-31',
        ultimoCobro: '2026-08-31',
        cobros: 2,
        consumo: 120,
        propinas: 0,
        total: 120,
        comision: 0.06,
        ivaComision: 0,
        totalComision: 0.06,
        depositoNeto: 119.94,
      },
      {
        fechaDeposito: '2026-09-02',
        primerCobro: '2026-08-31',
        ultimoCobro: '2026-08-31',
        cobros: 1,
        consumo: 60,
        propinas: 0,
        total: 60,
        comision: null,
        ivaComision: null,
        totalComision: 1.36,
        depositoNeto: 58.64,
      },
    ])
    expect(r.sinFecha).toBeNull()
  })
  it('lo sin fecha va aparte, sin comisión ni neto, y nunca se suma a un día', () => {
    const r = agruparDepositos([
      fila({ paymentId: 'a' }),
      fila({
        paymentId: 's',
        fechaCobro: '2026-08-20 10:00',
        fechaDeposito: null,
        motivoSinFecha: 'SIN_COSTO',
        totalComision: null,
        montoADepositar: null,
        comision: null,
        ivaComision: null,
        consumo: 100,
        total: 100,
      }),
      fila({ paymentId: 't', fechaCobro: '2026-08-25 10:00', fechaDeposito: null, motivoSinFecha: 'SIN_REGLA', consumo: -65, total: -65 }),
    ])
    expect(r.depositos).toHaveLength(1)
    expect(r.depositos[0].total).toBe(60)
    expect(r.sinFecha).toEqual({ cobros: 2, consumo: 35, propinas: 0, total: 35, desde: '2026-08-20', hasta: '2026-08-25' })
  })
})
