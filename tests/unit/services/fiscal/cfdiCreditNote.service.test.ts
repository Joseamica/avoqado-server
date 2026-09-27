import { LoadedRefundForCreditNote, buildCreditNoteLines, checkCreditNoteEligibility } from '@/services/fiscal/cfdiCreditNote.service'
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
