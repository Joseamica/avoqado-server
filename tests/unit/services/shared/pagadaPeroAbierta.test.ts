import { Prisma } from '@prisma/client'
import { criterioPagadaPeroAbiertaSql, findPaidButOpenOrders } from '@/services/shared/pagadaPeroAbierta'

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

  it('compara la suma de cobros COMPLETED que NO son REFUND contra lo que la cuenta DEBE, con tolerancia de un centavo', () => {
    expect(sql).toMatch(
      /SELECT COALESCE\(SUM\(p\.amount\), 0\) FROM "Payment" p\s+WHERE p\."orderId" = o\.id AND p\.status = 'COMPLETED' AND p\.type IS DISTINCT FROM 'REFUND'\s*\)\s*>=/,
    )
  })

  /**
   * 🔴 EL CARGO POR SERVICIO ES PARTE DE LO QUE LA CUENTA DEBE (auditoría de Codex, 2-sep-2026).
   *
   * El schema lo dice con todas sus letras (`Order.serviceChargeAmount`): «A DIFERENCIA de la
   * propina, esto es INGRESO GRAVABLE del negocio: SUMA al total y entra al corte y al CFDI».
   * Comparando sólo contra `subtotal − descuento`, una cuenta de $100 + $10 de cargo con $100
   * cobrados salía elegida como «pagada»: el barrido la cerraba, `reconcileOrderFromPayments`
   * le REESCRIBÍA el total hacia abajo y la mesa se liberaba — $10 perdidos, sin rastro.
   *
   * La propina se queda FUERA a propósito: no es deuda de la cuenta sino dinero del mesero, y
   * `computeOrderBalance` (`shared/orderBalance.ts`) la pone a los DOS lados de la comparación
   * (entra al total y entra a lo pagado), así que se cancela. Lo que el criterio compara es lo
   * mismo que aquélla: `mercancía + cargo por servicio` contra `Σ amount`.
   */
  it('lo que la cuenta debe INCLUYE el cargo por servicio y EXCLUYE la propina', () => {
    expect(sql).toMatch(
      /GREATEST\(0, o\.subtotal - COALESCE\(o\."discountAmount", 0\)\) \+ COALESCE\(o\."serviceChargeAmount", 0\) - 0\.01/,
    )

    // El alias manda también aquí: el cargo se lee de la MISMA tabla que el subtotal.
    expect(criterioPagadaPeroAbiertaSql('x')).toContain('COALESCE(x."serviceChargeAmount", 0)')

    // 🔴 Guarda contra la «simplificación» que reintroduce el defecto: la base NO puede volver
    // a terminar en el descuento. Con el término del cargo borrado, esta línea falla.
    expect(sql).not.toMatch(/COALESCE\(o\."discountAmount", 0\)\) - 0\.01/)

    // La propina NUNCA entra: sumarla haría que una cuenta saldada pareciera deber la propina.
    expect(sql).not.toContain('tipAmount')
  })
})

/**
 * La consulta que arma `findPaidButOpenOrders`. Se prueba contra un doble de `$queryRaw`
 * porque lo que hay que fijar es la FORMA de la plantilla —la ventana de gracia, el tope de
 * antigüedad, el orden y el límite—, no lo que devuelva Postgres.
 */
describe('findPaidButOpenOrders — la consulta que arma', () => {
  const AHORA = new Date('2026-09-02T20:00:00Z')
  const DESDE = new Date('2026-08-03T20:00:00Z')
  const GRACIA_MS = 300_000

  const dobleDb = () => ({ $queryRaw: jest.fn().mockResolvedValue([]) })
  type DobleDb = ReturnType<typeof dobleDb>
  const comoDb = (db: DobleDb) => db as unknown as Parameters<typeof findPaidButOpenOrders>[0]

  /**
   * `$queryRaw` se invoca como plantilla etiquetada, así que el doble recibe
   * `(strings, ...values)`. Volver a armarla con `Prisma.sql` es exactamente lo que Prisma
   * hace por dentro: APLANA los fragmentos anidados (`Prisma.raw`, `utcTs`) y deja el texto
   * completo con `?` más la lista PLANA de valores ligados. Sin eso, un `strings.join('?')`
   * pelón no vería lo que aporta un fragmento anidado.
   */
  const consultaCapturada = (db: DobleDb) => {
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]]
    return Prisma.sql(strings, ...values)
  }

  it('acota por la ventana de gracia y por `since`, ordena de la más vieja y limita', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA, since: DESDE })

    const q = consultaCapturada(db)
    expect(q.sql).toContain('o."updatedAt" <')
    expect(q.sql).toContain('o."createdAt" >=')
    expect(q.sql).toContain('ORDER BY o."createdAt" ASC')
    expect(q.sql).toContain('LIMIT')
    // El criterio compartido viaja DENTRO, verbatim: nadie reescribe el WHERE a mano.
    expect(q.sql).toContain(criterioPagadaPeroAbiertaSql('o'))

    // 🔴 Aquí se cae un signo invertido en la aritmética de la gracia: la ventana mira
    // HACIA ATRÁS (20:00 − 5 min), nunca hacia adelante.
    expect(q.values).toEqual([new Date('2026-09-02T19:55:00.000Z'), DESDE, 50])
  })

  it('sin `since` NO acota por fecha de creación — así el barrido a mano alcanza el rezago viejo', async () => {
    const db = dobleDb()
    await findPaidButOpenOrders(comoDb(db), { graceMs: GRACIA_MS, limit: 50, now: AHORA })

    const q = consultaCapturada(db)
    expect(q.sql).not.toContain('o."createdAt" >=')
    expect(q.values).toEqual([new Date('2026-09-02T19:55:00.000Z'), 50])
  })
})
