// tests/integration/fiscal/orderContratoDePrecio.transformaciones.test.ts
//
// IVA por producto, plan 2, tarea 5: separar cuenta (por artículos o por asiento) COPIA el
// contrato del origen a la cuenta nueva — es la MISMA venta, partida en dos recibos; el precio
// que el cliente ya vio no cambia. Fusionar dos cuentas COMBINA los contratos
// (`combinarContratos`, tarea 1): si coinciden se conserva, si difieren nadie sabe ya cuál era
// el precio real de la cuenta resultante y el contrato pasa a DESCONOCIDO. La fusión NUNCA se
// bloquea por esto — es una degradación silenciosa del dato, no un error de negocio.
//
// No existe ningún harness de integración reusable para `splitOrderItems`/`splitOrderBySeat`
// (grep vacío el 25-sep); `mergeOrders` sí lo tiene en
// `tests/integration/payments/orderCancelRoutes.integration.test.ts`, pero ese archivo lo usa
// para probar candados de concurrencia, no el contrato de precio — se replica aquí el patrón de
// siembra (Organization + Venue + Order + OrderItem mínimos) en vez de importar ese archivo.
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { splitOrderItems, splitOrderBySeat, mergeOrders } from '@/services/mobile/order.mobile.service'

describe('Order.contratoDePrecio — separar y fusionar cuentas (integración)', () => {
  beforeAll(() => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '')
    expect(['localhost', '127.0.0.1']).toContain(url.hostname)
    expect(url.pathname).toMatch(/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_|av_db_25_iva_test)/)
  })

  const fixture = `contrato-transf-${randomUUID().slice(0, 8)}`
  let venueId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000000' },
    })
    venueId = (await prisma.venue.create({ data: { id: fixture, organizationId: org.id, name: fixture, slug: fixture } })).id
  })

  afterAll(async () => {
    await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
    await prisma.order.deleteMany({ where: { venueId } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: fixture } })
    await prisma.$disconnect()
  })

  /** Una orden mínima válida, con `n` renglones de $50 (sin asiento salvo que se pida). */
  async function nuevaOrdenConArticulos(n: number, seats?: number[]) {
    const orden = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `${fixture}-${randomUUID().slice(0, 8)}`,
        subtotal: new Prisma.Decimal(50 * n),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50 * n),
      } as Prisma.OrderUncheckedCreateInput,
    })
    for (let i = 0; i < n; i++) {
      await prisma.orderItem.create({
        data: {
          orderId: orden.id,
          productName: `Artículo ${i + 1}`,
          quantity: 1,
          unitPrice: new Prisma.Decimal(50),
          taxAmount: new Prisma.Decimal(0),
          total: new Prisma.Decimal(50),
          seat: seats?.[i] ?? null,
        } as Prisma.OrderItemUncheckedCreateInput,
      })
    }
    const items = await prisma.orderItem.findMany({ where: { orderId: orden.id }, select: { id: true }, orderBy: { id: 'asc' } })
    return { ...orden, itemIds: items.map(i => i.id) }
  }

  /** Fija el contrato de precio DESPUÉS de sembrar (el `create` de la orden siempre nace DESCONOCIDO por default). */
  async function fijarContrato(orderId: string, contrato: 'IVA_INCLUIDO' | 'IVA_APARTE' | 'DESCONOCIDO') {
    await prisma.$executeRawUnsafe(`UPDATE "Order" SET "contratoDePrecio" = $1::"ContratoDePrecio" WHERE id = $2`, contrato, orderId)
  }

  async function contratoDe(orderId: string) {
    return (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { contratoDePrecio: true } })).contratoDePrecio
  }

  // ─── Separar cuenta ────────────────────────────────────────────────────────────────────────

  it('1. separar una orden IVA_APARTE ⇒ la orden nueva es IVA_APARTE', async () => {
    const origen = await nuevaOrdenConArticulos(2)
    await fijarContrato(origen.id, 'IVA_APARTE')

    const { created } = await splitOrderItems(venueId, origen.id, [origen.itemIds[0]])

    expect(await contratoDe(created.id)).toBe('IVA_APARTE')
    // El origen conserva SU contrato — separar no lo toca.
    expect(await contratoDe(origen.id)).toBe('IVA_APARTE')
  })

  it('2. separar por asiento una orden IVA_INCLUIDO con renglones en 2 asientos ⇒ cada orden nueva es IVA_INCLUIDO', async () => {
    const origen = await nuevaOrdenConArticulos(2, [1, 2])
    await fijarContrato(origen.id, 'IVA_INCLUIDO')

    const { created } = await splitOrderBySeat(venueId, origen.id)

    expect(created.length).toBeGreaterThan(0)
    for (const nueva of created) {
      expect(await contratoDe(nueva.id)).toBe('IVA_INCLUIDO')
    }
    expect(await contratoDe(origen.id)).toBe('IVA_INCLUIDO')
  })

  // ─── Fusionar cuentas ──────────────────────────────────────────────────────────────────────

  it('3. fusionar IVA_INCLUIDO (destino) + IVA_INCLUIDO (origen) ⇒ destino IVA_INCLUIDO', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await fijarContrato(destino.id, 'IVA_INCLUIDO')
    await fijarContrato(origen.id, 'IVA_INCLUIDO')

    await mergeOrders(venueId, destino.id, origen.id)

    expect(await contratoDe(destino.id)).toBe('IVA_INCLUIDO')
  })

  it('4. (Review Focus) fusionar DESCONOCIDO (destino) + IVA_INCLUIDO (origen) ⇒ destino DESCONOCIDO; la fusión OCURRE sin error', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await fijarContrato(destino.id, 'DESCONOCIDO')
    await fijarContrato(origen.id, 'IVA_INCLUIDO')

    await expect(mergeOrders(venueId, destino.id, origen.id)).resolves.not.toThrow()

    expect(await contratoDe(destino.id)).toBe('DESCONOCIDO')
    // Los renglones del origen se movieron al destino — la fusión ocurrió de verdad, no se abortó.
    expect(await prisma.orderItem.count({ where: { orderId: destino.id } })).toBe(2)
    expect(await prisma.orderItem.count({ where: { orderId: origen.id } })).toBe(0)
    // El origen queda en el estado final que `mergeOrders` YA le asignaba antes de esta tarea (CANCELLED).
    const origenFinal = await prisma.order.findUniqueOrThrow({ where: { id: origen.id }, select: { status: true } })
    expect(origenFinal.status).toBe('CANCELLED')
  })

  it('5. fusionar IVA_INCLUIDO (destino) + IVA_APARTE (origen) ⇒ destino DESCONOCIDO, sin error', async () => {
    const destino = await nuevaOrdenConArticulos(1)
    const origen = await nuevaOrdenConArticulos(1)
    await fijarContrato(destino.id, 'IVA_INCLUIDO')
    await fijarContrato(origen.id, 'IVA_APARTE')

    await expect(mergeOrders(venueId, destino.id, origen.id)).resolves.not.toThrow()

    expect(await contratoDe(destino.id)).toBe('DESCONOCIDO')
  })
})
