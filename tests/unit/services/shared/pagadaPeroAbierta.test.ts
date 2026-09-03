import { criterioPagadaPeroAbiertaSql } from '@/services/shared/pagadaPeroAbierta'

describe('criterio SQL «pagada pero abierta»', () => {
  const sql = criterioPagadaPeroAbiertaSql('o')

  it('excluye los estados terminales de la orden', () => {
    expect(sql).toMatch(/o\.status NOT IN \('COMPLETED', ?'CANCELLED', ?'DELETED'\)/)
  })

  it('cuenta REGULAR y FAST, nunca REFUND ni TEST, y exige al menos un cobro positivo', () => {
    expect(sql).toMatch(/p\.type IN \('REGULAR', ?'FAST'\)/)
    expect(sql).toMatch(/p\.amount > 0/)
    expect(sql).not.toMatch(/'TEST'/)
  })

  it('compara la suma de cobros COMPLETED (con reembolsos negativos) contra la base sin propina, con tolerancia de un centavo', () => {
    expect(sql).toMatch(/GREATEST\(0, o\.subtotal - COALESCE\(o\."discountAmount", 0\)\) - 0\.01/)
    expect(sql).toMatch(
      /SELECT COALESCE\(SUM\(p\.amount\), 0\) FROM "Payment" p\s+WHERE p\."orderId" = o\.id AND p\.status = 'COMPLETED'\s*\)\s*>=/,
    )
  })
})
