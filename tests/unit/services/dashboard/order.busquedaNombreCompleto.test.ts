/**
 * D2 (28-oct): buscar una venta por el nombre completo del cliente («Ana López») no la encontraba. La búsqueda pedía el texto
 * entero dentro del nombre O dentro del apellido, y ninguno de los dos contiene «Ana López». Ahora, con dos o más palabras, cada
 * una debe estar en el nombre o en el apellido del MISMO cliente. Lo de antes (texto entero, folio, monto, teléfono) sigue igual.
 * El listado (Prisma) y su resumen (SQL) se espejan; la paridad contra Postgres está en
 * `tests/integration/dashboard/listSummary-sql-parity.integration.test.ts`.
 */
import { buildOrdersWhereClause } from '@/services/dashboard/order.dashboard.service'
import { ordersSqlScope } from '@/services/dashboard/orderSummary.dashboard.service'
import { palabrasDeBusqueda } from '@/services/dashboard/listSummary.shared'

const VENUE = 'venue-1'

const ramaDeNombreCompleto = (where: any) =>
  (where.OR as any[]).find(r => Array.isArray(r?.orderCustomers?.some?.customer?.AND))?.orderCustomers.some.customer.AND

const palabra = (p: string) => ({
  OR: [{ firstName: { contains: p, mode: 'insensitive' } }, { lastName: { contains: p, mode: 'insensitive' } }],
})

describe('búsqueda de ventas por nombre completo del cliente (D2)', () => {
  it('«Ana López»: cada palabra en el nombre o en el apellido del mismo cliente', () => {
    const where = buildOrdersWhereClause(VENUE, { search: 'Ana López' })
    expect(ramaDeNombreCompleto(where)).toEqual([palabra('Ana'), palabra('López')])
  })

  it('el orden no importa y los espacios de más no estorban («  lópez   ana »)', () => {
    const where = buildOrdersWhereClause(VENUE, { search: '  lópez   ana ' })
    expect(ramaDeNombreCompleto(where)).toEqual([palabra('lópez'), palabra('ana')])
  })

  it('una sola palabra no agrega la rama nueva (queda como antes)', () => {
    const where = buildOrdersWhereClause(VENUE, { search: 'Ana' })
    expect(ramaDeNombreCompleto(where)).toBeUndefined()
  })

  it('lo de antes sigue: el texto entero en folio, nombre, apellido o teléfono', () => {
    const where = buildOrdersWhereClause(VENUE, { search: 'Ana López' })
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { orderNumber: { contains: 'Ana López', mode: 'insensitive' } },
        {
          orderCustomers: {
            some: {
              customer: {
                OR: [
                  { firstName: { contains: 'Ana López', mode: 'insensitive' } },
                  { lastName: { contains: 'Ana López', mode: 'insensitive' } },
                  { phone: { contains: 'Ana López', mode: 'insensitive' } },
                ],
              },
            },
          },
        },
      ]),
    )
  })

  it('el resumen (SQL) busca cada palabra por separado, además del texto entero', () => {
    const sql = ordersSqlScope(VENUE, { search: 'Ana López' })
    expect(sql.values).toEqual(expect.arrayContaining(['%Ana López%', '%Ana%', '%López%']))
  })

  it('el resumen con una sola palabra no cambia', () => {
    const sql = ordersSqlScope(VENUE, { search: 'Ana' })
    expect(sql.values.filter(v => v === '%Ana%')).toHaveLength(4) // folio, nombre, apellido y teléfono
  })

  it('palabrasDeBusqueda tiene tope: un texto de cien palabras no arma cien comparaciones', () => {
    expect(palabrasDeBusqueda(Array.from({ length: 100 }, (_, i) => `p${i}`).join(' '))).toHaveLength(5)
  })
})
