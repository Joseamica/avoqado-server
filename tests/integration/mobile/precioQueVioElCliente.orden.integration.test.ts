/**
 * 🔴 DINERO — «se cobra el precio que vio el cliente» contra Postgres REAL (Task 4).
 *
 * Una venta, una orden: con `externalId`, la creación toma primero el candado de su llave y re-verifica dentro de la
 * transacción, así que un reintento tardío (la cola sin red reintentando mientras el primer intento sigue en vuelo) recibe
 * la MISMA orden, nunca un 409 ni un 500. Y el dinero que sale de la regla cuadra al centavo al cobrar.
 *
 * Correr (base desechable, nunca av-db-25):
 *   TEST_DATABASE_URL="$DESECHABLE" DATABASE_URL="$DESECHABLE" npx jest --selectProjects=integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/precioQueVioElCliente.orden.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems, payCashOrder, UNICO_LLAVE_DE_LA_ORDEN } from '@/services/mobile/order.mobile.service'
import {
  addTicketToCheckout,
  createAreaTicketCheckout,
  issueAreaTicket,
  materializeAreaTicketCheckout,
} from '@/services/mobile/areaTicketV7.mobile.service'
import { esChoqueDelUnico } from '@/services/shared/turnoDeCaja'
import { aTiempo, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
}))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(database.pathname)) {
  throw new Error('Esta suite exige una base desechable local (avoqado_<tarea>_test_<fecha>).')
}

const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const HORA = 3_600_000
const HACE_4_DIAS = () => new Date(Date.now() - 96 * HORA).toISOString()
const pausa = (ms: number) => new Promise(r => setTimeout(r, ms))
const resultado = <T>(p: Promise<T>) =>
  p.then(
    value => ({ value, error: undefined as any }),
    error => ({ value: undefined as unknown as T, error }),
  )

let organizationId: string
let venueId: string
let staffId: string
let categoryId: string
let tableId: string
let areaId: string
const ISSUE_DEVICE = `emite-${s}`
const CHECKOUT_DEVICE = `caja-${s}`

const producto = (precio: string | number, nombre = `P ${Math.random()}`) =>
  prisma.product.create({ data: { venueId, categoryId, sku: `SKU-${Math.random()}`, name: nombre, price: new Prisma.Decimal(precio) } })
const precioHistorico = (productId: string) =>
  prisma.productPriceHistory.findMany({ where: { productId }, orderBy: { validFrom: 'asc' }, take: 10 })
const cobrar = (orderId: string, centavos: number) =>
  payCashOrder(venueId, orderId, { amount: centavos, tip: 0, staffId, idempotencyKey: `cobro-${randomUUID()}` })

beforeAll(async () => {
  organizationId = (
    await prisma.organization.create({ data: { name: `Vio orden ${s}`, email: `vio-orden-${s}@example.com`, phone: '5555555555' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId, name: `Vio orden ${s}`, slug: `vio-orden-${s}`, seatCapExempt: true } }))
    .id
  staffId = (await prisma.staff.create({ data: { email: `vio-orden-${s}@staff.test`, firstName: 'Caja', lastName: 'Precio' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
  tableId = (await prisma.table.create({ data: { venueId, number: '7', capacity: 4, qrCode: `qr-${s}` } })).id
  // Vales (prueba 4): una cremería que emite y una caja que cobra.
  areaId = (await prisma.fulfillmentArea.create({ data: { venueId, name: `Cremería ${s}` } })).id
  await prisma.venueAreaTicketSettings.create({ data: { venueId, enabled: true } })
  await prisma.terminal.createMany({
    data: [
      {
        venueId,
        name: 'Cremería',
        type: 'POS_ANDROID',
        status: 'ACTIVE',
        deviceUid: ISSUE_DEVICE,
        fulfillmentAreaId: areaId,
        canIssueAreaTickets: true,
      },
      { venueId, name: 'Caja', type: 'POS_ANDROID', status: 'ACTIVE', deviceUid: CHECKOUT_DEVICE, canCheckoutAreaTickets: true },
    ],
  })
})

afterAll(async () => {
  if (!venueId) return // sin fixture, un deleteMany sin filtro borraría la tabla entera
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.paymentEffect.deleteMany({ where: { venueId } })
  await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
  await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
  await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.modifierGroup.deleteMany({ where: { venueId } }) // extras e historial de extras, en cascada
  await prisma.product.deleteMany({ where: { venueId } }) // el historial se va en cascada
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.table.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
  await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (organizationId) await prisma.organization.deleteMany({ where: { id: organizationId } })
})

describe('precio que vio el cliente — la orden contra Postgres', () => {
  it('1. una creación aceptada en curso con la misma llave gana; el intento tardío no recibe 409', async () => {
    const p = await producto(50)
    const K = `venta-${randomUUID()}`
    const linea = { productId: p.id, quantity: 1, externalId: 'linea-1' }

    // T retiene la mesa (lockTableOrderScope la toma FOR NO KEY UPDATE): A se queda esperando DENTRO de su transacción,
    // ya con el candado de K.
    let soltarT!: () => void
    const puedeTerminar = new Promise<void>(r => (soltarT = r))
    let avisarPid!: (pid: number) => void
    const pidDeT = new Promise<number>(r => (avisarPid = r))
    const T = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Table" WHERE id = ${tableId} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        avisarPid(Number(pid))
        await puedeTerminar
      },
      { timeout: 30_000 },
    )
    let A: ReturnType<typeof resultado<Awaited<ReturnType<typeof createOrderWithItems>>>> | undefined
    let B: typeof A
    let esperaDeB: Awaited<ReturnType<typeof esperarBloqueado>> = null
    try {
      const pidT = await aTiempo(pidDeT, 5_000, 'T tomó la mesa')
      // A: precio válido (lo que muestra la tablet es lo de hoy).
      A = resultado(
        createOrderWithItems(venueId, {
          staffId,
          externalId: K,
          tableId,
          source: 'AVOQADO_ANDROID',
          items: [{ ...linea, displayedUnitPrice: 5000, catalogAt: new Date().toISOString() }],
        } as any),
      )
      const esperaDeA = await esperarBloqueado(prisma, { bloqueadoPor: [pidT], consulta: /"Table"/ })
      expect(esperaDeA).not.toBeNull()

      // B: la MISMA venta reintentada por la cola, con un catálogo de hace 4 días y un precio menor. Sola sería 409.
      B = resultado(
        createOrderWithItems(venueId, {
          staffId,
          externalId: K,
          tableId,
          source: 'AVOQADO_ANDROID',
          items: [{ ...linea, displayedUnitPrice: 4000, catalogAt: HACE_4_DIAS() }],
        } as any),
      )
      esperaDeB = await Promise.race([
        esperarBloqueado(prisma, { bloqueadoPor: [esperaDeA!.pid], consulta: /pg_advisory_xact_lock/ }),
        B.then(() => null),
      ])
      await pausa(300)
    } finally {
      soltarT()
      await T
    }
    const [a, b] = [await A!, await B!]

    expect(b.error).toBeUndefined()
    expect(a.error).toBeUndefined()
    expect(b.value.id).toBe(a.value.id)
    expect(await prisma.order.count({ where: { venueId, externalId: K } })).toBe(1)
    // B esperó el candado de la llave (detrás de A), no la mesa.
    expect(esperaDeB).not.toBeNull()
  })

  it('2. descuento de CUENTA del 10 %: el monto que viajó se conserva y el cobro cierra la cuenta', async () => {
    const p = await producto(100)
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: p.id }, data: { price: new Prisma.Decimal(80) } })

    const orden = await createOrderWithItems(venueId, {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      discount: 1000,
      items: [{ productId: p.id, quantity: 1, externalId: 'l1', displayedUnitPrice: 10000, catalogAt }],
    } as any)

    expect(orden.total).toBe(70)
    expect(orden.priceChanges).toEqual([
      expect.objectContaining({ externalId: 'l1', displayedUnitPriceCents: 10000, unitPriceCents: 8000 }),
    ])
    const guardada = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(Number(guardada.discountAmount)).toBe(10)
    expect(Number(guardada.remainingBalance)).toBe(70)
    // El descuento de CUENTA es su propia fila (B2), con el monto que viajó.
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: orden.id }, take: 5 })
    expect(filas.map(f => Number(f.amount))).toEqual([10])

    await cobrar(orden.id, 7000)
    const cobrada = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(cobrada.paymentStatus).toBe('PAID')
    expect(Number(cobrada.remainingBalance)).toBe(0)
  })

  it('3. $1,000,000 respetado: crear → cobrar → saldo 0', async () => {
    const p = await producto('1000000.00')
    const catalogAt = new Date().toISOString()
    await prisma.product.update({ where: { id: p.id }, data: { price: new Prisma.Decimal('1100000.00') } })
    expect((await precioHistorico(p.id)).map(h => [Number(h.price), h.validTo === null])).toEqual([
      [1000000, false],
      [1100000, true],
    ])

    const orden = await createOrderWithItems(venueId, {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [{ productId: p.id, quantity: 1, externalId: 'l1', displayedUnitPrice: 100_000_000, catalogAt }],
    } as any)

    expect(orden.total).toBe(1000000)
    expect(orden).not.toHaveProperty('priceChanges')
    await cobrar(orden.id, 100_000_000)
    const cobrada = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(cobrada.paymentStatus).toBe('PAID')
    expect(Number(cobrada.remainingBalance)).toBe(0)
    const rastro = await prisma.activityLog.findMany({
      where: { venueId, action: 'ORDER_PREVIOUS_PRICE_HONORED', entityId: orden.id },
      take: 5,
    })
    expect(rastro).toHaveLength(1)
    expect((rastro[0].data as any).lineas).toEqual([expect.objectContaining({ precioRespetado: 1000000, precioActual: 1100000 })])
  })

  it('4. carrito mixto con vale: los campos nuevos no cambian nada', async () => {
    const delVale = await producto(30, 'Queso del vale')
    const deCaja = await producto(15, 'Papas de caja')
    const vale = await issueAreaTicket(venueId, {
      idempotencyKey: `vale-${s}`,
      deviceUid: ISSUE_DEVICE,
      staffId,
      lines: [{ clientLineId: `vale-linea-${s}`, productId: delVale.id, quantity: '1' }],
    })
    const sesion = await createAreaTicketCheckout(venueId, { idempotencyKey: `cobro-vale-${s}`, deviceUid: CHECKOUT_DEVICE, staffId })
    await addTicketToCheckout(venueId, sesion.id, vale.code, { idempotencyKey: `reclamo-${s}`, deviceUid: CHECKOUT_DEVICE, staffId })

    const venta = await materializeAreaTicketCheckout(venueId, sesion.id, {
      idempotencyKey: `materializa-${s}`,
      deviceUid: CHECKOUT_DEVICE,
      staffId,
      source: 'AVOQADO_ANDROID',
      normalItems: [{ productId: deCaja.id, quantity: 1, externalId: 'caja-1', displayedUnitPrice: 1000, catalogAt: HACE_4_DIAS() }],
    })

    expect(venta.order.total).toBe('45.00') // 30 del vale + 15 de la base, no 10 del mostrado
    const lineaDeCaja = await prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.order.id, productId: deCaja.id } })
    expect(Number(lineaDeCaja.unitPrice)).toBe(15)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'ORDER_PREVIOUS_PRICE_HONORED', entityId: venta.order.id } })).toBe(0)
  })

  it('5. (S3) producto + extra cuyo precio subió en la ventana: el extra a lo mostrado; el reintento trae externalId por renglón', async () => {
    const p = await producto(50)
    const grupo = await prisma.modifierGroup.create({ data: { venueId, name: `Leches ${s}` } })
    const avena = await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Leche de avena', price: new Prisma.Decimal(10) } })
    const catalogAt = new Date().toISOString()
    await prisma.modifier.update({ where: { id: avena.id }, data: { price: new Prisma.Decimal(15) } })
    const cuerpo = {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [
        {
          productId: p.id,
          quantity: 2,
          externalId: 'l1',
          modifierIds: [avena.id],
          displayedUnitPrice: 5000,
          displayedModifierPrices: { [avena.id]: 1000 },
          catalogAt,
        },
        { name: 'Otro importe', unitPrice: 2500, quantity: 1, externalId: 'l2' },
      ],
    } as any

    const orden = await createOrderWithItems(venueId, cuerpo)

    expect(orden.total).toBe(145) // (50 + 10) × 2 + 25
    expect(orden).not.toHaveProperty('priceChanges')
    expect(orden.items.map(i => i.externalId).sort()).toEqual(['l1', 'l2'])
    const conExtra = orden.items.find(i => i.externalId === 'l1')!
    expect(conExtra.modifiers).toEqual([expect.objectContaining({ id: avena.id, price: 10 })])
    const guardado = await prisma.orderItemModifier.findFirstOrThrow({ where: { orderItem: { orderId: orden.id } } })
    expect(Number(guardado.price)).toBe(10)
    const libre = await prisma.orderItem.findFirstOrThrow({ where: { orderId: orden.id, productId: null } })
    expect(libre.externalId).toBe('l2')
    const rastro = await prisma.activityLog.findFirstOrThrow({
      where: { venueId, action: 'ORDER_PREVIOUS_PRICE_HONORED', entityId: orden.id },
    })
    expect((rastro.data as any).lineas).toEqual([
      expect.objectContaining({ modifierId: avena.id, extra: 'Leche de avena', precioRespetado: 10, precioActual: 15, cantidad: 2 }),
    ])

    // La respuesta se perdió: el reintento recupera la MISMA orden, con su externalId por renglón y sin cambios de precio.
    const recuperada = await createOrderWithItems(venueId, cuerpo)
    expect(recuperada.id).toBe(orden.id)
    expect(recuperada.items.map(i => i.externalId).sort()).toEqual(['l1', 'l2'])
    expect(recuperada).not.toHaveProperty('priceChanges')

    await cobrar(orden.id, 14500)
    const cobrada = await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })
    expect(cobrada.paymentStatus).toBe('PAID')
    expect(Number(cobrada.remainingBalance)).toBe(0)
  })

  it('5b. (S3) un precio de extra que nunca fue real: en línea 409; desde la cola, el vigente con el aviso', async () => {
    const p = await producto(50)
    const grupo = await prisma.modifierGroup.create({ data: { venueId, name: `Toppings ${s}` } })
    const chispas = await prisma.modifier.create({ data: { groupId: grupo.id, name: 'Chispas', price: new Prisma.Decimal(15) } })
    const linea = {
      productId: p.id,
      quantity: 1,
      externalId: 'l1',
      modifierIds: [chispas.id],
      displayedUnitPrice: 5000,
      displayedModifierPrices: { [chispas.id]: 700 },
      catalogAt: new Date().toISOString(),
    }

    await expect(
      createOrderWithItems(venueId, { staffId, externalId: `venta-${randomUUID()}`, source: 'AVOQADO_ANDROID', items: [linea] } as any),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PRICE_CHANGED' })

    const deLaCola = await createOrderWithItems(venueId, {
      staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      isOfflineReplay: true,
      createdAtLocal: Date.now(),
      items: [linea],
    } as any)
    expect(deLaCola.total).toBe(65)
    expect(deLaCola.priceChanges).toEqual([
      expect.objectContaining({ externalId: 'l1', modifierId: chispas.id, displayedUnitPriceCents: 700, unitPriceCents: 1500 }),
    ])
  })

  it('la forma del choque se midió: la llave de la ORDEN se reconoce como carrera; la de una línea, no', async () => {
    const p = await producto(10)
    const K = `forma-${randomUUID()}`
    const cabecera = (n: string) => ({
      venueId,
      orderNumber: `FORMA-${n}-${s}`,
      subtotal: new Prisma.Decimal(10),
      discountAmount: new Prisma.Decimal(0),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(10),
      remainingBalance: new Prisma.Decimal(10),
    })
    const linea = { productId: p.id, productName: 'x', quantity: 1, unitPrice: 10, taxAmount: 0, total: 10, externalId: 'repetida' }
    await prisma.order.create({ data: { ...cabecera('1'), externalId: K } })
    const deLaOrden = await prisma.order.create({ data: { ...cabecera('2'), externalId: K } }).catch(e => e)
    const deLaLinea = await prisma.order
      .create({ data: { ...cabecera('3'), externalId: `${K}-b`, items: { create: [linea, linea] } } })
      .catch(e => e)

    expect(deLaOrden).toMatchObject({ code: 'P2002', meta: { target: ['venueId', 'externalId'] } })
    expect(deLaLinea).toMatchObject({ code: 'P2002', meta: { target: ['orderId', 'externalId'] } })
    expect(esChoqueDelUnico(deLaOrden, UNICO_LLAVE_DE_LA_ORDEN)).toBe(true)
    expect(esChoqueDelUnico(deLaLinea, UNICO_LLAVE_DE_LA_ORDEN)).toBe(false)
  })
})
