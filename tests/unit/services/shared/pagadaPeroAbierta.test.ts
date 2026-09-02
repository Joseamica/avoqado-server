import { criterioPagadaPeroAbiertaSql } from '@/services/shared/pagadaPeroAbierta'

describe('criterio SQL «pagada pero abierta»', () => {
  const sql = criterioPagadaPeroAbiertaSql('o')

  it('excluye los estados terminales de la orden', () => {
    expect(sql).toMatch(/o\.status NOT IN \('COMPLETED', ?'CANCELLED', ?'DELETED'\)/)

    // El alias manda de verdad: con otro alias, el criterio habla de ESA tabla y de ninguna otra.
    const conAlias = criterioPagadaPeroAbiertaSql('x')
    expect(conAlias).toMatch(/x\.status NOT IN \('COMPLETED', ?'CANCELLED', ?'DELETED'\)/)
    expect(conAlias).not.toMatch(/o\.status/)
  })

  it('exige al menos un cobro REGULAR o FAST positivo; la suma ignora el tipo salvo REFUND', () => {
    expect(sql).toMatch(/p\.type IN \('REGULAR', ?'FAST'\)/)
    expect(sql).toMatch(/p\.amount > 0/)
    expect(sql).toMatch(/SUM\(p\.amount\)[\s\S]*?p\.status = 'COMPLETED' AND p\.type IS DISTINCT FROM 'REFUND'/)
  })

  it('compara la suma de cobros COMPLETED que NO son REFUND contra la base sin propina, con tolerancia de un centavo', () => {
    expect(sql).toMatch(/GREATEST\(0, o\.subtotal - COALESCE\(o\."discountAmount", 0\)\) - 0\.01/)
    expect(sql).toMatch(
      /SELECT COALESCE\(SUM\(p\.amount\), 0\) FROM "Payment" p\s+WHERE p\."orderId" = o\.id AND p\.status = 'COMPLETED' AND p\.type IS DISTINCT FROM 'REFUND'\s*\)\s*>=/,
    )
  })
})
