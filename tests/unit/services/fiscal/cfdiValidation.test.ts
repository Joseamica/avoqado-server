// tests/unit/services/fiscal/cfdiValidation.test.ts
import { validateBeforeStamp, PreStampInput } from '../../../../src/services/fiscal/cfdiValidation'

const ok: PreStampInput = {
  csdStatus: 'ACTIVE',
  formaPago: '01',
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
      description: 'Servicio',
      quantity: 1,
      unitPriceCents: 10000,
      discountCents: 0,
      objetoImp: '02',
      taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
    },
  ],
  expectedSubtotalCents: 10000,
  expectedTaxCents: 1600,
  expectedTotalCents: 11600,
}

describe('validateBeforeStamp (D1)', () => {
  it('passes a clean payload', () => {
    expect(validateBeforeStamp(ok)).toEqual({ valid: true, reasons: [] })
  })

  it('rejects a missing SAT product key (the #1 blocker)', () => {
    const r = validateBeforeStamp({ ...ok, items: [{ ...ok.items[0], satProductKey: '' }] })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/clave SAT|ClaveProdServ/i)
  })

  it('rejects a bad RFC and a non-5-digit CP', () => {
    expect(validateBeforeStamp({ ...ok, receptor: { ...ok.receptor, rfc: 'BAD' } }).valid).toBe(false)
    expect(validateBeforeStamp({ ...ok, receptor: { ...ok.receptor, codigoPostal: '123' } }).valid).toBe(false)
  })

  it('rejects when money does not cuadrar al centavo', () => {
    const r = validateBeforeStamp({ ...ok, expectedTotalCents: 11601 })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/centavo|no cuadra/i)
  })

  it('rejects when the emisor CSD is not ACTIVE', () => {
    expect(validateBeforeStamp({ ...ok, csdStatus: 'EXPIRED' }).valid).toBe(false)
    expect(validateBeforeStamp({ ...ok, csdStatus: 'RESTRICTED' }).valid).toBe(false)
  })

  it('rejects objetoImp 02 with no traslado, and 01 with a traslado', () => {
    expect(validateBeforeStamp({ ...ok, items: [{ ...ok.items[0], objetoImp: '02', taxes: [] }] }).valid).toBe(false)
    expect(
      validateBeforeStamp({
        ...ok,
        items: [
          {
            ...ok.items[0],
            objetoImp: '01',
            taxes: [{ type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false }],
          },
        ],
      }).valid,
    ).toBe(false)
  })

  // ── XAXX010101000 "Público en General" gating ────────────────────────────

  it('rejects XAXX010101000 on an individual CFDI (isGlobal omitted → false)', () => {
    const r = validateBeforeStamp({
      ...ok,
      receptor: { ...ok.receptor, rfc: 'XAXX010101000' },
    })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/Público en General|global/i)
  })

  it('rejects XAXX010101000 on an individual CFDI (isGlobal explicitly false)', () => {
    const r = validateBeforeStamp({
      ...ok,
      receptor: { ...ok.receptor, rfc: 'XAXX010101000' },
      isGlobal: false,
    })
    expect(r.valid).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/Público en General|global/i)
  })

  it('allows XAXX010101000 on the global CFDI (isGlobal: true)', () => {
    const r = validateBeforeStamp({
      ...ok,
      receptor: { ...ok.receptor, rfc: 'XAXX010101000' },
      isGlobal: true,
    })
    // The XAXX reason must NOT appear; other fields may still be valid
    const xaxxReason = r.reasons.find(reason => /Público en General|XAXX/i.test(reason))
    expect(xaxxReason).toBeUndefined()
  })
})
