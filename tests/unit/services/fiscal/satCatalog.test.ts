// tests/unit/services/fiscal/satCatalog.test.ts
import { mapFormaPago, sectorSatDefaults, isValidRegimen, isFormaPagoAmbiguous } from '../../../../src/services/fiscal/satCatalog'

describe('satCatalog', () => {
  it('maps Avoqado PaymentMethod → SAT c_FormaPago', () => {
    expect(mapFormaPago('CASH')).toBe('01')
    expect(mapFormaPago('CREDIT_CARD')).toBe('04')
    expect(mapFormaPago('DEBIT_CARD')).toBe('28')
    expect(mapFormaPago('BANK_TRANSFER')).toBe('03')
  })

  it('returns 99 (por definir) for ambiguous methods and flags them', () => {
    expect(mapFormaPago('OTHER')).toBe('99')
    expect(mapFormaPago('CRYPTOCURRENCY')).toBe('99')
    expect(mapFormaPago('DIGITAL_WALLET')).toBe('99') // disambiguation deferred (spec §10)
  })

  it('gives a per-sector SAT key default', () => {
    expect(sectorSatDefaults('RESTAURANT').productKey).toBe('90101500')
    expect(sectorSatDefaults('RESTAURANT').unitKey).toBe('E48')
    expect(sectorSatDefaults('RETAIL_STORE').unitKey).toBe('H87') // pieza
  })

  it('validates régimen codes (numeric, 3 digits)', () => {
    expect(isValidRegimen('601')).toBe(true)
    expect(isValidRegimen('616')).toBe(true)
    expect(isValidRegimen('99')).toBe(false)
    expect(isValidRegimen('abc')).toBe(false)
  })
})

/**
 * 🔴 FISCAL — el tipo de pago del negocio declara SU forma SAT, y esa gana.
 *
 * Un cobro con un tipo del catálogo se guarda con `method = OTHER`, que mapea a **'99'
 * (por definir)**. O sea: un negocio que YA declaró "Vale de despensa = 05" al dar de alta
 * el tipo veía sus facturas salir con "por definir" — el dato correcto estaba en la base y
 * el CFDI lo ignoraba. El SAT rechaza o marca esas facturas, y el comercio no tiene forma
 * de saber por qué desde el POS.
 */
describe('mapFormaPago — snapshot del tipo de pago del negocio', () => {
  it('usa la forma SAT declarada en el tipo, no el 99 de OTHER', () => {
    expect(mapFormaPago('OTHER' as any, '05')).toBe('05')
  })

  it('el snapshot también gana sobre un método conocido (el negocio sabe más que el default)', () => {
    // Una "Terminal BBVA" declarada como débito (28) no se factura como crédito (04)
    // sólo porque el tender base sea CREDIT_CARD.
    expect(mapFormaPago('CREDIT_CARD' as any, '28')).toBe('28')
  })

  it('un snapshot "99" NO se usa: es exactamente lo que hay que evitar, así que cae al método', () => {
    expect(mapFormaPago('CASH' as any, '99')).toBe('01')
  })

  it('sin snapshot, el comportamiento histórico queda intacto', () => {
    expect(mapFormaPago('CASH' as any)).toBe('01')
    expect(mapFormaPago('OTHER' as any)).toBe('99')
    expect(mapFormaPago('CREDIT_CARD' as any, null)).toBe('04')
  })

  it('isFormaPagoAmbiguous deja de marcar el cobro que YA tiene forma declarada', () => {
    expect(isFormaPagoAmbiguous('OTHER' as any)).toBe(true)
    expect(isFormaPagoAmbiguous('OTHER' as any, '05')).toBe(false)
  })
})
