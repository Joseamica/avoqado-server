// tests/unit/services/fiscal/fiscalScope.test.ts
import { paymentInFiscalScope, metodoParaAlcanceFiscal } from '../../../../src/services/fiscal/fiscalScope'

describe('paymentInFiscalScope (¿el pago entra a los libros fiscales?)', () => {
  it('EFECTIVO: gobernado por el opt-in del emisor, no por merchant', () => {
    expect(paymentInFiscalScope('CASH', null, false)).toBe(false) // default: efectivo fuera
    expect(paymentInFiscalScope('CASH', null, true)).toBe(true) // opt-in: efectivo dentro
    // el flag de merchant es irrelevante para efectivo (el efectivo no trae merchant)
    expect(paymentInFiscalScope('CASH', false, true)).toBe(true)
  })

  it('TARJETA/electrónico: dentro salvo que su merchant esté excluido', () => {
    expect(paymentInFiscalScope('CREDIT_CARD', true, false)).toBe(true)
    expect(paymentInFiscalScope('CREDIT_CARD', null, false)).toBe(true) // sin config → default dentro
    expect(paymentInFiscalScope('CREDIT_CARD', undefined, false)).toBe(true)
    expect(paymentInFiscalScope('DEBIT_CARD', false, true)).toBe(false) // merchant excluido → fuera
  })

  it('el opt-in del efectivo NO afecta a los pagos con tarjeta', () => {
    expect(paymentInFiscalScope('CREDIT_CARD', true, false)).toBe(true)
    expect(paymentInFiscalScope('CREDIT_CARD', true, true)).toBe(true)
  })
})

describe('metodoParaAlcanceFiscal (una devolución sigue a su VENTA)', () => {
  it('usa el método original guardado en el reembolso', () => {
    expect(metodoParaAlcanceFiscal('BANK_TRANSFER', { originalMethod: 'CASH' })).toBe('CASH')
  })
  it('sin originalMethod (reembolsos viejos o ventas) usa su propio método', () => {
    expect(metodoParaAlcanceFiscal('CASH', {})).toBe('CASH')
    expect(metodoParaAlcanceFiscal('CREDIT_CARD', null)).toBe('CREDIT_CARD')
    expect(metodoParaAlcanceFiscal('CASH', { originalMethod: 42 })).toBe('CASH')
  })
})
