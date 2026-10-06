import { LoadedRefundForCreditNote, buildCreditNoteLines, checkCreditNoteEligibility } from '@/services/fiscal/cfdiCreditNote.service'
import { huellaDeEntrada } from '@/services/fiscal/entradaDocumental'
function makeOriginal(over: Partial<LoadedRefundForCreditNote['original']> = {}) {
  return {
    id: 'cfdi-ingreso-1',
    orderId: 'o1',
    protocoloIva: null,
    entrada: null,
    entradaHuella: null,
    uuid: 'UUID-INGRESO-1',
    serie: 'F',
    folio: '12',
    status: 'STAMPED',
    cancelStatus: null,
    subtotalCents: 10000,
    taxCents: 1600,
    totalCents: 11600,
    formaPago: '04',
    metodoPago: 'PUE' as const,
    receptorRfc: 'EKU9003173C9',
    receptorNombre: 'ESCUELA KEMPER URGATE SA DE CV',
    receptorRegimen: '601',
    receptorCp: '64000',
    receptorEmail: 'cliente@example.com',
    fiscalEmisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
    ...over,
  } as LoadedRefundForCreditNote['original']
}

function makeLoaded(over: Partial<LoadedRefundForCreditNote> = {}): LoadedRefundForCreditNote {
  return {
    venueId: 'v1',
    venueSlug: 'demo',
    refund: {
      id: 'pay-refund-1',
      orderId: 'o1',
      type: 'REFUND',
      status: 'COMPLETED',
      // El reembolso se guarda NEGATIVO; el loader lo entrega en centavos POSITIVOS ya separado.
      salesRefundCents: 11600,
      tipRefundCents: 0,
      method: 'CREDIT_CARD',
      tenderSatFormaPago: null,
    },
    original: makeOriginal(),
    // El desglose real de tasas de la orden (una sola tasa 16% por defecto).
    grossByRate: [{ rate: 0.16, grossCents: 11600 }],
    alreadyCreditedCents: 0,
    ...over,
  }
}

describe('checkCreditNoteEligibility (puro) — lo que decide si el botón se pinta', () => {
  it('caso normal → elegible, sin mensaje', () => {
    expect(checkCreditNoteEligibility(makeLoaded())).toEqual({ eligible: true, reason: null, message: null })
  })

  it('🔴 cuando NO procede, siempre trae un motivo Y un texto en español (apagado se VE y se EXPLICA)', () => {
    const cases: Array<[LoadedRefundForCreditNote, string]> = [
      [makeLoaded({ original: null }), 'NO_ORIGINAL_CFDI'],
      [makeLoaded({ original: makeOriginal({ cancelStatus: 'CANCELLED' }) }), 'ORIGINAL_CANCELLED'],
      [makeLoaded({ alreadyCreditedCents: 11600 }), 'EXCEEDS_REMAINING'],
    ]
    for (const [loaded, reason] of cases) {
      const res = checkCreditNoteEligibility(loaded)
      expect(res.eligible).toBe(false)
      expect(res.reason).toBe(reason)
      expect(res.message && res.message.length).toBeGreaterThan(10)
    }
  })

  it('acreditar EXACTAMENTE el saldo restante sí procede (el tope es inclusivo)', () => {
    const loaded = makeLoaded({ alreadyCreditedCents: 5000 })
    loaded.refund.salesRefundCents = 6600 // 11600 - 5000
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Helper puro de reparto (cuadre al centavo)
// ─────────────────────────────────────────────────────────────────────────────
describe('buildCreditNoteLines (puro)', () => {
  it('una sola tasa → una partida por el importe completo', () => {
    const lines = buildCreditNoteLines(11600, [{ rate: 0.16, grossCents: 11600 }], 0.16)
    expect(lines).toEqual([{ grossCents: 11600, rate: 0.16 }])
  })

  it('sin desglose de la orden → una partida a la tasa de respaldo', () => {
    expect(buildCreditNoteLines(5000, [], 0)).toEqual([{ grossCents: 5000, rate: 0 }])
  })

  it('🔴 reparto proporcional que NO divide exacto: las partes suman EXACTAMENTE el importe', () => {
    const lines = buildCreditNoteLines(
      1000,
      [
        { rate: 0.16, grossCents: 3333 },
        { rate: 0.08, grossCents: 3333 },
        { rate: 0, grossCents: 3334 },
      ],
      0.16,
    )
    expect(lines.reduce((a, l) => a + l.grossCents, 0)).toBe(1000)
  })

  it('descarta las tasas a las que no les tocó ni un centavo', () => {
    const lines = buildCreditNoteLines(
      100,
      [
        { rate: 0.16, grossCents: 1000000 },
        { rate: 0, grossCents: 1 },
      ],
      0.16,
    )
    expect(lines.every(l => l.grossCents > 0)).toBe(true)
    expect(lines.reduce((a, l) => a + l.grossCents, 0)).toBe(100)
  })
})

describe('precondiciones fiscales conservadas', () => {
  it.each([
    ['type', 'REGULAR', 'NOT_A_REFUND'],
    ['status', 'PENDING', 'REFUND_NOT_COMPLETED'],
    ['salesRefundCents', 0, 'TIP_ONLY'],
  ] as const)('%s inválido no permite emitir', (field, value, reason) => {
    const loaded = makeLoaded()
    Object.assign(loaded.refund, { [field]: value })
    expect(checkCreditNoteEligibility(loaded)).toMatchObject({ eligible: false, reason })
  })
  it('sólo protocoloNULL sin entrada puede usar compatibilidad histórica', () => {
    const loaded = makeLoaded()
    loaded.original!.protocoloIva = 1
    expect(checkCreditNoteEligibility(loaded).reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
    loaded.original!.protocoloIva = null
    expect(checkCreditNoteEligibility(loaded).eligible).toBe(true)
  })
})

describe('D9: la nota relee el precio por kilo de 6 decimales de la factura original', () => {
  const entradaPeso = (unitPriceDecimal: string) => ({
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    clasificacion: 'TODO_16',
    paidCents: 6916,
    montos: { subtotalCents: 5962, taxCents: 954, totalCents: 6916 },
    renglones: [{ orderItemId: 'oi-jamon', tratamiento: 'IVA_16' }],
    params: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '50112000',
          satUnitKey: 'KGM',
          description: 'Jamón',
          quantity: 1.537,
          unitPriceCents: 4500,
          unitPriceDecimal,
          discountCents: 0,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'o1',
    },
  })
  const conEntrada = (entrada: any) =>
    makeLoaded({
      refund: { ...makeLoaded().refund, salesRefundCents: 6916 },
      original: makeOriginal({
        protocoloIva: 1,
        entrada,
        entradaHuella: huellaDeEntrada(entrada),
        subtotalCents: 5962,
        taxCents: 954,
        totalCents: 6916,
      }),
      grossByRate: [{ rate: 0.16, grossCents: 6916 }],
    })

  it('🔴 con el precio decimal, la entrada cuadra y la nota procede (con $45.00 daría 69.17 y la tomaría por inválida)', () => {
    expect(checkCreditNoteEligibility(conEntrada(entradaPeso('44.996747')))).toEqual({ eligible: true, reason: null, message: null })
  })
  it('control: un precio decimal mal formado (7 decimales) invalida la entrada', () => {
    expect(checkCreditNoteEligibility(conEntrada(entradaPeso('44.9967471'))).reason).toBe('ORIGINAL_ENTRADA_INVALIDA')
  })
})

describe('6b: una factura ajustada guarda los montos del PAC (base neta, IVA por tasa, total = lo cobrado)', () => {
  // $65 con $2.50 propios, IVA incluido: el PAC daba $62.49, el cargador bajó el descuento a $2.49 y guardó lo que dice el XML.
  const entradaAjustada = (montos: { subtotalCents: number; taxCents: number; totalCents: number }) => ({
    version: 1,
    orderId: 'o1',
    fiscalEmisorId: 'e1',
    replacesCfdiId: null,
    contratoDePrecio: 'IVA_INCLUIDO',
    paymentStatus: 'PAID',
    clasificacion: 'TODO_16',
    paidCents: 6250,
    montos,
    renglones: [{ orderItemId: 'oi-latte', tratamiento: 'IVA_16' }],
    params: {
      receptor: {
        rfc: 'EKU9003173C9',
        razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
        regimenFiscal: '601',
        codigoPostal: '64000',
        usoCfdi: 'G03',
      },
      items: [
        {
          satProductKey: '90101500',
          satUnitKey: 'E48',
          description: 'Latte',
          quantity: 1,
          unitPriceCents: 6500,
          discountCents: 249,
          objetoImp: '02',
          taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          taxIncluded: true,
        },
      ],
      formaPago: '04',
      metodoPago: 'PUE',
      serie: 'F',
      idempotencyKey: 'o1',
    },
  })
  const conMontos = (montos: { subtotalCents: number; taxCents: number; totalCents: number }) => {
    const entrada = entradaAjustada(montos)
    return makeLoaded({
      refund: { ...makeLoaded().refund, salesRefundCents: 6250 },
      original: makeOriginal({ protocoloIva: 1, entrada, entradaHuella: huellaDeEntrada(entrada), ...montos }),
      grossByRate: [{ rate: 0.16, grossCents: 6250 }],
    })
  }

  it('6b: una factura ajustada (montos del PAC) se puede acreditar', () => {
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5388, taxCents: 862, totalCents: 6250 }))).toEqual({
      eligible: true,
      reason: null,
      message: null,
    })
  })
  it('6b: montos que suman bien pero no son ni por concepto ni del PAC ⇒ ORIGINAL_ENTRADA_INVALIDA', () => {
    // 5389 + 861 = 6250: suman, así que sólo la regla nueva (Codex r2 N8) puede rechazarlos.
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5389, taxCents: 861, totalCents: 6250 })).reason).toBe(
      'ORIGINAL_ENTRADA_INVALIDA',
    )
  })
  it('control: montos que ni siquiera suman ⇒ ORIGINAL_ENTRADA_INVALIDA', () => {
    expect(checkCreditNoteEligibility(conMontos({ subtotalCents: 5388, taxCents: 862, totalCents: 6251 })).reason).toBe(
      'ORIGINAL_ENTRADA_INVALIDA',
    )
  })
})
