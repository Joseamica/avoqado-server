/**
 * Integration: el relleno de cliente de la venta rápida contra POSTGRES REAL.
 *
 * 🔴 POR QUÉ ESTA SUITE EXISTE Y EL UNIT NO BASTA.
 *
 * La corrección depende de un **índice único PARCIAL** que sólo Postgres hace cumplir:
 *
 *   CREATE UNIQUE INDEX "OrderCustomer_orderId_isPrimary_unique"
 *   ON "OrderCustomer" ("orderId") WHERE "isPrimary" = true;
 *   -- migración 20251211171115_add_partial_unique_index_order_customer_primary
 *
 * El `prismaMock` de los unit tests NO puede hacerlo cumplir: un `create` con
 * `isPrimary: true` sobre una orden que ya tiene primario simplemente "funciona" en el
 * mock. O sea que el bug —crear a ciegas un segundo primario— era **invisible** para
 * cualquier prueba unitaria, por muchos casos que tuviera.
 *
 * El escenario que se reproduce aquí es real y alcanzable en producción:
 *
 *   1. Se abre una cuenta sin cliente.
 *   2. Desde la TPV el cajero agrega al cliente B (`addCustomerToOrder`,
 *      `order.tpv.service.ts`) → nace `OrderCustomer(B, isPrimary=true)` y
 *      **`Order.customerId` SIGUE NULL** (esa función jamás lo escribe).
 *   3. El cobro se manda a la terminal y se registra por `/fast` con `customerId = A`.
 *   4. Mirando sólo `Order.customerId` parecería "sin cliente" → se intentaría rellenar
 *      con A como primario → **choque contra el índice**.
 *
 * @see src/services/tpv/fastPaymentCustomer.ts
 */

import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { linkCustomerToExistingOrder } from '@/services/tpv/fastPaymentCustomer'

describe('FastPayment · cliente primario contra el índice único parcial (Postgres real)', () => {
  let venueId: string
  let otroVenueId: string
  let clienteA: string
  let clienteB: string
  let organizationId: string

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'FastPay Customer Org', email: `fastpay-${Date.now()}@test.com`, phone: '5550000000' },
    })
    organizationId = org.id

    const venue = await prisma.venue.create({
      data: {
        name: 'FastPay Customer Venue',
        slug: `fastpay-customer-${Date.now()}`,
        organizationId: org.id,
        address: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id

    const otroVenue = await prisma.venue.create({
      data: {
        name: 'FastPay Otro Venue',
        slug: `fastpay-otro-${Date.now()}`,
        organizationId: org.id,
        address: 'Test',
        city: 'Test',
        state: 'Test',
        country: 'MX',
        zipCode: '12345',
        timezone: 'America/Mexico_City',
      },
    })
    otroVenueId = otroVenue.id

    const a = await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'Ruiz', phone: '5551110000' } })
    const b = await prisma.customer.create({ data: { venueId, firstName: 'Beto', lastName: 'Lima', phone: '5552220000' } })
    clienteA = a.id
    clienteB = b.id
  })

  afterAll(async () => {
    // `Order_venueId_fkey` NO es cascade: hay que borrar las órdenes a mano antes del
    // venue (OrderCustomer sí cae por cascade desde Order).
    const venues = [venueId, otroVenueId]
    await prisma.orderCustomer.deleteMany({ where: { order: { venueId: { in: venues } } } })
    await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.customer.deleteMany({ where: { venueId: { in: venues } } })
    await prisma.venue.deleteMany({ where: { id: { in: venues } } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
  })

  /** Una venta rápida ya cobrada, sin cliente. */
  async function ordenFast() {
    return prisma.order.create({
      data: {
        venueId,
        orderNumber: `FAST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        paidAmount: 100,
      },
    })
  }

  it('🔴 el índice parcial EXISTE y de verdad rechaza un segundo primario', async () => {
    // Guardrail de la propia suite: si esta aserción dejara de fallar, todo lo demás de
    // aquí abajo estaría probando contra una base sin la restricción y no valdría nada.
    const order = await ordenFast()
    await prisma.orderCustomer.create({ data: { orderId: order.id, customerId: clienteB, isPrimary: true } })

    await expect(prisma.orderCustomer.create({ data: { orderId: order.id, customerId: clienteA, isPrimary: true } })).rejects.toMatchObject(
      {
        code: 'P2002',
      },
    )
  })

  it('cliente puesto desde la TPV (OrderCustomer primario, Order.customerId NULL) ⇒ CONFLICT, sin escribir', async () => {
    const order = await ordenFast()
    await prisma.orderCustomer.create({ data: { orderId: order.id, customerId: clienteB, isPrimary: true } })

    const link = await linkCustomerToExistingOrder(venueId, order.id, clienteA)

    expect(link.status).toBe('CONFLICT')
    expect(link.customerId).toBe(clienteB)
    expect(link.requestedCustomerId).toBe(clienteA)
    // 🔴 Lo que de verdad importa: el aviso NO puede decir que la venta quedó sin
    // cliente, porque sí tiene uno. Ese era el mensaje falso del bug.
    expect(link.warning).not.toMatch(/sin cliente/i)

    // Y nada se escribió: B sigue siendo el único, y sigue siendo primario.
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ customerId: clienteB, isPrimary: true })
    const recargada = await prisma.order.findUnique({ where: { id: order.id }, select: { customerId: true } })
    expect(recargada?.customerId).toBeNull()
  })

  it('venta realmente sin cliente ⇒ se rellena: Order.customerId + OrderCustomer primario', async () => {
    const order = await ordenFast()

    const link = await linkCustomerToExistingOrder(venueId, order.id, clienteA)

    expect(link.status).toBe('LINKED')
    expect(link.customerId).toBe(clienteA)

    const recargada = await prisma.order.findUnique({
      where: { id: order.id },
      select: { customerId: true, customerName: true, customerPhone: true },
    })
    expect(recargada).toMatchObject({ customerId: clienteA, customerName: 'Ana Ruiz', customerPhone: '5551110000' })

    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ customerId: clienteA, isPrimary: true })
  })

  it('nuestro cliente ya vinculado como NO primario y sin primario ⇒ se PROMUEVE, no se duplica', async () => {
    const order = await ordenFast()
    await prisma.orderCustomer.create({ data: { orderId: order.id, customerId: clienteA, isPrimary: false } })

    const link = await linkCustomerToExistingOrder(venueId, order.id, clienteA)

    expect(link.status).toBe('LINKED')
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id } })
    expect(filas).toHaveLength(1) // no se duplicó la fila
    expect(filas[0].isPrimary).toBe(true) // se promovió
  })

  it('otro cliente NO primario presente ⇒ el nuestro entra SIN chocar (y como primario)', async () => {
    // Multi-cliente sin primario: `isPrimary` se calcula, no se hardcodea.
    const order = await ordenFast()
    await prisma.orderCustomer.create({ data: { orderId: order.id, customerId: clienteB, isPrimary: false } })

    const link = await linkCustomerToExistingOrder(venueId, order.id, clienteA)

    expect(link.status).toBe('LINKED')
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id }, orderBy: { addedAt: 'asc' } })
    expect(filas).toHaveLength(2)
    expect(filas.filter(f => f.isPrimary)).toHaveLength(1)
    expect(filas.find(f => f.isPrimary)?.customerId).toBe(clienteA)
  })

  it('reintento con el MISMO cliente ⇒ idempotente (ni duplica fila ni rompe el índice)', async () => {
    const order = await ordenFast()

    await linkCustomerToExistingOrder(venueId, order.id, clienteA)
    const segundo = await linkCustomerToExistingOrder(venueId, order.id, clienteA)

    expect(segundo.status).toBe('LINKED')
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id } })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ customerId: clienteA, isPrimary: true })
  })

  it('🔴 un cliente de OTRO venue jamás se vincula, ni siquiera con la orden vacía', async () => {
    const ajeno = await prisma.customer.create({ data: { venueId: otroVenueId, firstName: 'Ajeno', phone: '5559990000' } })
    const order = await ordenFast()

    const link = await linkCustomerToExistingOrder(venueId, order.id, ajeno.id)

    expect(link.status).toBe('NOT_FOUND')
    expect(link.customerId).toBeNull()
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: order.id } })
    expect(filas).toHaveLength(0)
    const recargada = await prisma.order.findUnique({ where: { id: order.id }, select: { customerId: true } })
    expect(recargada?.customerId).toBeNull()
  })

  it('una orden de OTRO venue no se toca aunque el cliente sea válido aquí', async () => {
    const ordenAjena = await prisma.order.create({
      data: {
        venueId: otroVenueId,
        orderNumber: `FAST-ajena-${Date.now()}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    })

    const link = await linkCustomerToExistingOrder(venueId, ordenAjena.id, clienteA)

    expect(link.status).toBe('UNVERIFIED')
    const filas = await prisma.orderCustomer.findMany({ where: { orderId: ordenAjena.id } })
    expect(filas).toHaveLength(0)
  })

  it('carrera REAL: dos rellenos concurrentes con clientes distintos ⇒ uno gana, el otro CONFLICT (nunca dos primarios)', async () => {
    // Esta es la prueba que el unit sólo podía SIMULAR: aquí el índice parcial de
    // Postgres es el que arbitra de verdad.
    const order = await ordenFast()

    const [r1, r2] = await Promise.all([
      linkCustomerToExistingOrder(venueId, order.id, clienteA),
      linkCustomerToExistingOrder(venueId, order.id, clienteB),
    ])

    const estados = [r1.status, r2.status].sort()
    // Cualquiera de los dos puede ganar; lo que NO puede pasar es que ganen los dos,
    // ni que el perdedor mienta con "la venta se registró sin cliente".
    expect(estados).toEqual(['CONFLICT', 'LINKED'])
    expect([r1, r2].every(r => !/sin cliente/i.test(r.warning ?? ''))).toBe(true)

    const primarios = await prisma.orderCustomer.findMany({ where: { orderId: order.id, isPrimary: true } })
    expect(primarios).toHaveLength(1)
  })
})
