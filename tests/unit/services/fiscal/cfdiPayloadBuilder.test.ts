// tests/unit/services/fiscal/cfdiPayloadBuilder.test.ts
import {
  buildCreateInvoiceParams,
  buildGlobalInvoiceParams,
  CLAVE_NOTA,
  CLAVE_NOTA_V1,
  conceptosDeNota,
  formaPagoDeLaGlobal,
  groupOrderIntoGlobalLines,
  AvoqadoSaleInput,
  GlobalInvoiceLine,
  GlobalLineItemInput,
} from '../../../../src/services/fiscal/cfdiPayloadBuilder'

const baseInput: AvoqadoSaleInput = {
  venueType: 'RESTAURANT',
  receptor: { rfc: 'EKU9003173C9', razonSocial: 'X', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' },
  paymentMethod: 'CASH',
  metodoPago: 'PUE',
  tipCents: 1500, // excluded from CFDI
  idempotencyKey: 'k1',
  items: [
    {
      description: 'Tacos',
      quantity: 2,
      unitPriceCents: 5000,
      discountCents: 0,
      taxRate: 0.16,
      satProductKey: null,
      satUnitKey: null,
      categoryDefaultProductKey: null,
      categoryDefaultUnitKey: null,
      objetoImp: null,
      taxExempt: false,
    },
  ],
}

describe('buildCreateInvoiceParams', () => {
  it('maps the unit price straight to ValorUnitario and adds IVA traslado (NET by default)', () => {
    const p = buildCreateInvoiceParams(baseInput)
    expect(p.formaPago).toBe('01')
    expect(p.metodoPago).toBe('PUE')
    expect(p.items).toHaveLength(1)
    const it = p.items[0]
    expect(it.unitPriceCents).toBe(5000) // unchanged
    expect(it.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }])
    expect(it.objetoImp).toBe('02')
    expect(it.taxIncluded).toBe(false) // no flag → NET
  })

  it('carries taxIncluded:true through for IVA-included (gross) sales', () => {
    const p = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], taxIncluded: true }],
    })
    expect(p.items[0].taxIncluded).toBe(true)
  })

  it('resolves SAT keys: product override ?? category default ?? sector default', () => {
    const override = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], satProductKey: '12345678', satUnitKey: 'KGM' }],
    })
    expect(override.items[0].satProductKey).toBe('12345678')
    expect(override.items[0].satUnitKey).toBe('KGM')

    const cat = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], categoryDefaultProductKey: '99999999', categoryDefaultUnitKey: 'E48' }],
    })
    expect(cat.items[0].satProductKey).toBe('99999999')

    const sector = buildCreateInvoiceParams(baseInput) // nothing set → RESTAURANT sector default
    expect(sector.items[0].satProductKey).toBe('90101500')
    expect(sector.items[0].satUnitKey).toBe('E48')
  })

  it('NEVER includes the tip in the items (D2 — propina excluida)', () => {
    const p = buildCreateInvoiceParams(baseInput)
    const total = p.items.reduce((s, it) => s + it.unitPriceCents * it.quantity - it.discountCents, 0)
    expect(total).toBe(10000) // 2 × 5000, tip 1500 NOT included
  })

  it('exento item → objetoImp 01 and no traslado', () => {
    const p = buildCreateInvoiceParams({
      ...baseInput,
      items: [{ ...baseInput.items[0], taxRate: 0, taxExempt: true }],
    })
    expect(p.items[0].objetoImp).toBe('01')
    expect(p.items[0].taxes).toEqual([])
  })
})

describe('buildGlobalInvoiceParams', () => {
  const emisor = { lugarExpedicion: '83000', serie: null }
  const period = { facturaPeriodicity: 'month', meses: '05', anio: 2026 } as any

  it('gross order (priceIncludesIva) → sends the IVA-included total with tax_included so the stamp == paid', () => {
    const lines: GlobalInvoiceLine[] = [
      { orderId: 'o1', subtotalCents: 10000, taxCents: 1600, totalCents: 11600, formaPago: '01', priceIncludesIva: true },
    ]
    const params = buildGlobalInvoiceParams(emisor, lines, period)
    const item = params.items[0]
    expect(item.unitPriceCents).toBe(11600) // gross total — what the customer paid
    expect(item.taxIncluded).toBe(true)
    expect(item.satProductKey).toBe('01010101')
  })

  it('net order (separated tax) → sends the base with tax_included:false (unchanged legacy behaviour)', () => {
    const lines: GlobalInvoiceLine[] = [
      { orderId: 'o1', subtotalCents: 10000, taxCents: 1600, totalCents: 11600, formaPago: '01', priceIncludesIva: false },
    ]
    const params = buildGlobalInvoiceParams(emisor, lines, period)
    const item = params.items[0]
    expect(item.unitPriceCents).toBe(10000) // NET base — PAC adds IVA → 11600
    expect(item.taxIncluded).toBe(false)
  })

  it('uses the line REAL rate, not a hard-coded 16% (8% frontera)', () => {
    const lines: GlobalInvoiceLine[] = [
      {
        orderId: 'o1',
        subtotalCents: 10000,
        taxCents: 800,
        totalCents: 10800,
        formaPago: '01',
        priceIncludesIva: true,
        taxRate: 0.08,
        objetoImp: '02',
      },
    ]
    const item = buildGlobalInvoiceParams(emisor, lines, period).items[0]
    expect(item.objetoImp).toBe('02')
    expect(item.taxes).toEqual([{ type: 'IVA', factor: 'Tasa', rate: 0.08, withholding: false }])
  })

  it('exento group → objetoImp 01 and NO traslado (never invents 16% IVA on exempt sales)', () => {
    const lines: GlobalInvoiceLine[] = [
      {
        orderId: 'o1',
        subtotalCents: 10000,
        taxCents: 0,
        totalCents: 10000,
        formaPago: '01',
        priceIncludesIva: true,
        taxRate: 0,
        objetoImp: '01',
      },
    ]
    const item = buildGlobalInvoiceParams(emisor, lines, period).items[0]
    expect(item.objetoImp).toBe('01')
    expect(item.taxes).toEqual([])
  })
})

describe('C1 · buildGlobalInvoiceParams: folio (H3) y la forma que suma más (H4, sumada por forma en la ronda 1 de la T6)', () => {
  const linea = (orderId: string, totalCents: number, formaPago: string, orderNumber: string | null = `N-${orderId}`) => ({
    orderId,
    orderNumber,
    totalCents,
    subtotalCents: Math.round(totalCents / 1.16),
    taxCents: totalCents - Math.round(totalCents / 1.16),
    formaPago,
    priceIncludesIva: true,
    taxRate: 0.16,
    objetoImp: '02',
  })
  const periodo = {
    periodStart: new Date(),
    periodEnd: new Date(),
    meses: '05',
    anio: 2026,
    satPeriodicidad: '04' as const,
    facturaPeriodicity: 'month' as const,
  }
  it('sku = folio; sin número, el id', () => {
    expect(
      buildGlobalInvoiceParams({ lugarExpedicion: '01000' }, [linea('o1', 11600, '04'), linea('o2', 5800, '04', null)], periodo).items.map(
        i => i.sku,
      ),
    ).toEqual(['N-o1', 'o2'])
  })
  // Ronda 1 de la T6 (I3): el título decía «la del ticket de mayor monto»; con dos tickets y una forma cada uno, la forma que suma más es la
  // del ticket mayor: la expectativa ('04') no cambia.
  it('🔴 formas distintas ⇒ la forma que suma más, no «99»', () => {
    expect(
      buildGlobalInvoiceParams({ lugarExpedicion: '01000' }, [linea('o1', 5800, '01'), linea('o2', 11600, '04')], periodo).payment_form,
    ).toBe('04')
  })
  // Ronda 1 de la T6 (I3): el título decía «empate ⇒ la del primero por id»; con un ticket por forma, empate de sumas = empate de ticket mayor y
  // decide el menor id: la expectativa ('28') no cambia.
  it('empate de sumas y de ticket mayor ⇒ la forma del ticket de menor id (la guía deja elegir)', () => {
    expect(
      buildGlobalInvoiceParams({ lugarExpedicion: '01000' }, [linea('o2', 5800, '04'), linea('o1', 5800, '28')], periodo).payment_form,
    ).toBe('28')
    // En el otro orden también (sin esto, un `>=` que se queda con el último pasaría por casualidad).
    expect(
      buildGlobalInvoiceParams({ lugarExpedicion: '01000' }, [linea('o1', 5800, '28'), linea('o2', 5800, '04')], periodo).payment_form,
    ).toBe('28')
  })
  // Ronda 1 de la T6 (I3): la guía del SAT («la forma con la que se liquida la mayor cantidad»; empate «cuando se reciban dos o más formas de pago
  // con el mismo importe») ⇒ se suma POR FORMA entre los tickets.
  it('🔴 I3: dos tickets de $300 con tarjeta y uno de $500 en efectivo ⇒ tarjeta (suma $600), no la del ticket mayor', () => {
    expect(
      buildGlobalInvoiceParams(
        { lugarExpedicion: '01000' },
        [linea('o1', 30000, '04'), linea('o2', 30000, '04'), linea('o3', 50000, '01')],
        periodo,
      ).payment_form,
    ).toBe('04')
  })
  it('control — I3: un ticket con dos líneas (dos tasas) cuenta ENTERO como ticket mayor al desempatar', () => {
    // Sumas empatadas: efectivo 30000 + 25000 (un solo ticket, o1) contra tarjeta 55000 (o2). Ticket mayor: o1 = 55000 entero (no su línea de
    // 30000) empata con o2 ⇒ menor id ⇒ efectivo. Si las líneas no se sumaran por orden, ganaría la tarjeta.
    expect(
      buildGlobalInvoiceParams(
        { lugarExpedicion: '01000' },
        [linea('o1', 30000, '01'), linea('o1', 25000, '01'), linea('o2', 55000, '04')],
        periodo,
      ).payment_form,
    ).toBe('01')
  })
})

describe('C1 · formaPagoDeLaGlobal (ronda 1 de la T6, I3: sumada por forma)', () => {
  const t = (orderId: string, paidCents: number, formaPago: string) => ({ orderId, paidCents, formaPago })
  it('🔴 la forma que suma más gana aunque su ticket mayor sea menor', () => {
    expect(formaPagoDeLaGlobal([t('o1', 30000, '04'), t('o2', 30000, '04'), t('o3', 50000, '01')])).toBe('04')
  })
  it('control — empate de sumas ⇒ la forma con el ticket mayor ($300 + $200 con tarjeta contra $500 en efectivo ⇒ efectivo)', () => {
    expect(formaPagoDeLaGlobal([t('o1', 30000, '04'), t('o2', 20000, '04'), t('o3', 50000, '01')])).toBe('01')
  })
  it('control — empate de sumas y de ticket mayor ⇒ la forma del ticket mayor de menor id (en cualquier orden)', () => {
    expect(formaPagoDeLaGlobal([t('o9', 20000, '01'), t('o1', 20000, '04'), t('o2', 20000, '01'), t('o3', 20000, '04')])).toBe('04')
    expect(formaPagoDeLaGlobal([t('o3', 20000, '04'), t('o2', 20000, '01'), t('o1', 20000, '04'), t('o9', 20000, '01')])).toBe('04')
  })
  it('control — sin tickets ⇒ «99» (sólo la captura vacía, que es diagnóstica)', () => {
    expect(formaPagoDeLaGlobal([])).toBe('99')
  })
  // Re-revisión de la T6 (menor, se cierra en la T7): la garantía «'99' sólo con la lista vacía» no puede descansar sólo en que
  // `ticketParaGlobal` excluya esos tickets. Un ticket «por definir» no es una forma de pago: si hay otra forma, nunca decide la global.
  it('🔴 T7: un ticket «99» nunca decide la forma de la global aunque sea el mayor: $900 «99» y $100 con tarjeta ⇒ 04', () => {
    expect(formaPagoDeLaGlobal([t('o1', 90000, '99'), t('o2', 10000, '04')])).toBe('04')
    expect(formaPagoDeLaGlobal([t('o2', 10000, '04'), t('o1', 90000, '99')])).toBe('04')
  })
  it('control — T7: sólo tickets «99» ⇒ «99» (la validación previa detiene la global: «La forma de pago no está definida»)', () => {
    expect(formaPagoDeLaGlobal([t('o1', 90000, '99'), t('o2', 10000, '99')])).toBe('99')
  })
})

describe('groupOrderIntoGlobalLines (derive real IVA per product, not assumed 16%)', () => {
  const meta = { orderId: 'o1', orderNumber: '42', formaPago: '01', priceIncludesIva: true }

  it('uniform 16% order → ONE 16% line, total stays == paid', () => {
    const items: GlobalLineItemInput[] = [
      { grossCents: 11600, taxRate: 0.16, objetoImp: '02' },
      { grossCents: 5800, taxRate: 0.16, objetoImp: '02' },
    ]
    const lines = groupOrderIntoGlobalLines(items, meta)
    expect(lines).toHaveLength(1)
    expect(lines[0].totalCents).toBe(17400) // 11600 + 5800 = exactly what was paid
    expect(lines[0].subtotalCents + lines[0].taxCents).toBe(17400)
    expect(lines[0].taxRate).toBe(0.16)
  })

  it('mixed cart (16% + exento) → TWO lines, each with its own rate; exento carries no IVA', () => {
    const items: GlobalLineItemInput[] = [
      { grossCents: 11600, taxRate: 0.16, objetoImp: '02' },
      { grossCents: 10000, taxRate: 0, objetoImp: '01' },
    ]
    const lines = groupOrderIntoGlobalLines(items, meta)
    expect(lines).toHaveLength(2)
    const taxable = lines.find(l => l.taxRate === 0.16)!
    const exempt = lines.find(l => l.taxRate === 0)!
    expect(taxable.taxCents).toBe(1600)
    expect(exempt.taxCents).toBe(0)
    expect(exempt.objetoImp).toBe('01')
    // grand total across lines == what the customer paid
    expect(lines.reduce((s, l) => s + l.totalCents, 0)).toBe(21600)
  })

  it('fully exempt order → ONE exento line, zero IVA (not 16%)', () => {
    const lines = groupOrderIntoGlobalLines([{ grossCents: 10000, taxRate: 0, objetoImp: '01' }], meta)
    expect(lines).toHaveLength(1)
    expect(lines[0].taxCents).toBe(0)
    expect(lines[0].objetoImp).toBe('01')
    expect(lines[0].totalCents).toBe(10000)
  })
})

// ─── C2 · Tarea 7 ──────────────────────────────────────────────────────────────
describe('C2 · conceptosDeNota (Apéndice 5: 84111506/ACT)', () => {
  it('un concepto por tratamiento, IVA incluido, objeto y traslado de cada uno, clave 84111506 y unidad ACT', () => {
    const items = conceptosDeNota({ IVA_16: 5800, IVA_0: 2500, EXENTO: 3000, NO_OBJETO: 2000 }, 'F12')
    expect(
      items.map(i => [i.satProductKey, i.satUnitKey, i.unitPriceCents, i.objetoImp, i.taxes.map(t => `${t.factor}:${t.rate}`).join(',')]),
    ).toEqual([
      ['84111506', 'ACT', 5800, '02', 'Tasa:0.16'],
      ['84111506', 'ACT', 2500, '02', 'Tasa:0'],
      ['84111506', 'ACT', 3000, '02', 'Exento:0'],
      ['84111506', 'ACT', 2000, '01', ''],
    ])
    expect(items.every(i => i.description === 'Devolución sobre factura F12' && i.taxIncluded && i.sku === undefined)).toBe(true)
  })
  it('con sku (nota a una global): NoIdentificacion = folio del ticket', () => {
    // (el plan leía `[0].sku`; con el cuerpo neutro es un TypeError: se compara la lista, rojo por aserción)
    expect(conceptosDeNota({ IVA_16: 100 }, 'G-1', { sku: 'ORD-2' }).map(i => i.sku)).toEqual(['ORD-2'])
  })
  it('control — las claves: la nueva es 84111506 y la de las notas v1 (ya timbradas) sigue siendo 01010101', () => {
    expect([CLAVE_NOTA, CLAVE_NOTA_V1]).toEqual(['84111506', '01010101'])
  })
  it('un tratamiento en cero no da concepto; el orden es el de TRATAMIENTOS_DE_NOTA aunque el objeto llegue en otro', () => {
    expect(conceptosDeNota({ NO_OBJETO: 5, IVA_16: 0, IVA_0: 7 }, 'X').map(i => i.unitPriceCents)).toEqual([7, 5])
  })
})
