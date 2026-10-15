/**
 * 🔴 H6 (auditoría de Codex del código, 15-oct-2026): la lista de clientes topaba los CLIENTES (100) pero hidrataba TODAS sus
 * cuentas pendientes para calcular `pendingOrderCount` y `pendingBalance` en JavaScript. Ahora salen de UN agregado en la base
 * para los clientes de la página. Esta prueba fija que los dos campos tienen los MISMOS valores que la consulta de antes
 * (que aquí se repite tal cual como referencia), contra Postgres real.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { getCustomers } from '@/services/dashboard/customer.dashboard.service'

describe('saldo pendiente de cada cliente de la lista: mismos valores, sin hidratar las cuentas (integración)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    orgId = (
      await prisma.organization.create({ data: { name: 'ITEST Saldos', email: `itest-saldos-${sello}@test.com`, phone: '5550000000' } })
    ).id
    venueId = (
      await prisma.venue.create({
        data: { name: `itest-saldos-${sello}`, slug: `itest-saldos-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
      })
    ).id
    const dia = (d: number) => new Date(Date.UTC(2026, 9, d, 18, 0, 0))
    for (const [i, nombre] of ['Ana', 'Beto', 'Carla', 'Dany'].entries()) {
      ids[nombre] = (await prisma.customer.create({ data: { venueId, firstName: nombre, createdAt: dia(i + 1) } })).id
    }
    let k = 0
    const cuenta = async (
      quien: string,
      paymentStatus: 'PENDING' | 'PARTIAL' | 'PAID',
      remainingBalance: number,
      status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'DELETED' = 'PENDING',
    ) => {
      const o = await prisma.order.create({
        data: {
          venueId: venueId!,
          orderNumber: `ITEST-SALDO-${sello}-${++k}`,
          subtotal: 500,
          taxAmount: 0,
          total: 500,
          remainingBalance,
          paymentStatus,
          status,
        },
      })
      await prisma.orderCustomer.create({ data: { orderId: o.id, customerId: ids[quien], isPrimary: true } })
    }
    // Ana: dos que cuentan (pendiente y parcial) y tres que NO (pagada, cancelada con saldo, borrada con saldo).
    await cuenta('Ana', 'PENDING', 100.5)
    await cuenta('Ana', 'PARTIAL', 20.25)
    await cuenta('Ana', 'PAID', 0, 'COMPLETED')
    await cuenta('Ana', 'PENDING', 300, 'CANCELLED')
    await cuenta('Ana', 'PARTIAL', 40, 'DELETED')
    // Beto: una pendiente en cero (no cuenta: `remainingBalance > 0`) y tres con centavos.
    await cuenta('Beto', 'PENDING', 0)
    await cuenta('Beto', 'PARTIAL', 12.34)
    await cuenta('Beto', 'PENDING', 56.78)
    await cuenta('Beto', 'PENDING', 0.01)
    // Carla: sólo cuentas que no cuentan. Dany: ninguna cuenta.
    await cuenta('Carla', 'PAID', 0, 'COMPLETED')
    await cuenta('Carla', 'PENDING', 80, 'CANCELLED')
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA.
    if (!venueId || !orgId) return
    await prisma.order.deleteMany({ where: { venueId } }) // OrderCustomer cae en cascada
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  /** La consulta de ANTES (el `include` de `orderAssociations` y la suma en JavaScript), repetida aquí como referencia. */
  async function comoAntes(): Promise<Record<string, { pendingOrderCount: number; pendingBalance: number }>> {
    const filas = await prisma.customer.findMany({
      where: { venueId },
      select: {
        id: true,
        orderAssociations: {
          where: {
            order: {
              paymentStatus: { in: ['PENDING', 'PARTIAL'] },
              remainingBalance: { gt: 0 },
              status: { notIn: ['CANCELLED', 'DELETED'] },
            },
          },
          include: { order: { select: { id: true, remainingBalance: true } } },
        },
      },
      take: 10,
    })
    return Object.fromEntries(
      filas.map(c => [
        c.id,
        {
          pendingOrderCount: c.orderAssociations?.length || 0,
          pendingBalance: c.orderAssociations?.reduce((sum, oc) => sum + Number(oc.order.remainingBalance), 0) || 0,
        },
      ]),
    )
  }

  /**
   * Mismo valor AL CENTAVO. La suma de antes era en punto flotante dentro de JavaScript (12.34 + 56.78 + 0.01 =
   * 69.13000000000001); la de ahora es la suma EXACTA de Postgres (69.13). Las dos se pintan «$69.13»: la diferencia es ruido
   * de flotante de la versión vieja, no dinero.
   */
  const mismoValor = (
    ahora: { pendingOrderCount: number; pendingBalance: number },
    antes: { pendingOrderCount: number; pendingBalance: number },
  ) => {
    expect(ahora.pendingOrderCount).toBe(antes.pendingOrderCount)
    expect(Math.round(ahora.pendingBalance * 100)).toBe(Math.round(antes.pendingBalance * 100))
  }

  it('🔴 pendingOrderCount y pendingBalance iguales a la consulta de antes, cliente por cliente', async () => {
    const antes = await comoAntes()
    const ahora = await getCustomers(venueId!, 1, 100)
    expect(ahora.data).toHaveLength(4)
    for (const c of ahora.data) mismoValor(c, antes[c.id])
    const de = (nombre: string) => ahora.data.find(c => c.id === ids[nombre])!
    expect(de('Ana')).toMatchObject({ pendingOrderCount: 2, pendingBalance: 120.75 })
    expect(de('Beto')).toMatchObject({ pendingOrderCount: 3, pendingBalance: 69.13 })
    expect(de('Carla')).toMatchObject({ pendingOrderCount: 0, pendingBalance: 0 })
    expect(de('Dany')).toMatchObject({ pendingOrderCount: 0, pendingBalance: 0 })
    // La respuesta no lleva la relación (antes se borraba con `orderAssociations: undefined`).
    expect(ahora.data.every(c => (c as Record<string, unknown>).orderAssociations === undefined)).toBe(true)
  })

  it('una página parcial calcula sólo sus clientes y con los mismos valores', async () => {
    const antes = await comoAntes()
    const pagina = await getCustomers(venueId!, 2, 2) // más nuevos primero: Beto y Ana
    expect(pagina.data.map(c => c.id)).toEqual([ids.Beto, ids.Ana])
    for (const c of pagina.data) mismoValor(c, antes[c.id])
  })

  it('el filtro «con saldo pendiente» y el saldo mostrado siguen la MISMA regla', async () => {
    const r = await getCustomers(venueId!, 1, 100, undefined, undefined, undefined, undefined, 'createdAt', 'desc', true)
    expect(r.data.map(c => c.id).sort()).toEqual([ids.Ana, ids.Beto].sort())
    expect(r.data.every(c => c.pendingOrderCount > 0 && c.pendingBalance > 0)).toBe(true)
  })
})
