/**
 * 🔴 DINERO — cortesías y descuento de catálogo de la cuenta en la orden de mobile, contra Postgres REAL («Cobrar sin red», S4).
 *
 * El recorrido de la cola de la terminal: crea la orden (cortesía al 100 % ⇒ total 0, sin cerrarse), paga $0 (la cierra), y
 * el reintento de las dos llamadas con sus mismas llaves devuelve lo mismo: una orden, un cobro, UN vale de inventario.
 *
 * Correr (base desechable, nunca av-db-25):
 *   node scripts/run-with-launch-campaigns-test-db.cjs npx jest --selectProjects integration --runInBand \
 *     --runTestsByPath tests/integration/mobile/cortesiaEnLaOrden.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems, payCashOrder } from '@/services/mobile/order.mobile.service'

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

// Sin limpieza a propósito: la base es desechable (el script la borra al terminar) y los nombres son únicos por corrida.
const s = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let venueId: string
let staffId: string
let categoryId: string

const producto = (precio: number, nombre: string) =>
  prisma.product.create({ data: { venueId, categoryId, sku: `SKU-${randomUUID()}`, name: nombre, price: new Prisma.Decimal(precio) } })

beforeAll(async () => {
  const organizationId = (
    await prisma.organization.create({ data: { name: `Cortesía ${s}`, email: `cortesia-${s}@example.com`, phone: '5555555555' } })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId, name: `Cortesía ${s}`, slug: `cortesia-${s}`, seatCapExempt: true } })).id
  staffId = (await prisma.staff.create({ data: { email: `cortesia-${s}@staff.test`, firstName: 'Caja', lastName: 'Cortesía' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'CASHIER' } })
  categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat ${s}`, slug: `cat-${s}` } })).id
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('cortesía en la orden de mobile — contra Postgres', () => {
  it('1. orden toda en cortesía: nace en $0 sin cerrarse, el /pay de $0 la cierra, y los reintentos no duplican nada', async () => {
    const cafe = await producto(50, `Café ${s}`)
    const K = `venta-${randomUUID()}`
    const P = `cobro-${randomUUID()}`
    const venta = {
      staffId,
      canCompItems: true,
      performedBy: staffId,
      externalId: K,
      source: 'TPV',
      orderType: 'TAKEOUT',
      isOfflineReplay: true,
      items: [
        { productId: cafe.id, quantity: 2, externalId: `${K}:0`, isCortesia: true, cortesiaReason: 'Invitación de la casa' },
        { name: 'Galleta', unitPrice: 1500, quantity: 1, externalId: `${K}:1`, isCortesia: true, cortesiaReason: 'Invitación de la casa' },
      ],
    } as any

    const creada = await createOrderWithItems(venueId, venta)
    expect(creada).toMatchObject({ total: 0, subtotal: 115, discountAmount: 115, paymentStatus: 'PENDING', status: 'CONFIRMED' })
    const renglones = await prisma.orderItem.findMany({ where: { orderId: creada.id }, orderBy: { total: 'desc' }, take: 5 })
    expect(renglones.map(r => [r.isCortesia, r.cortesiaReason, Number(r.total), Number(r.discountAmount)])).toEqual([
      [true, 'Invitación de la casa', 100, 100],
      [true, 'Invitación de la casa', 15, 15],
    ])

    // El /pay de $0 de la cola (como Android) la cierra.
    const pago = await payCashOrder(venueId, creada.id, { amount: 0, tip: 0, staffId, idempotencyKey: P, isOfflineReplay: true })
    expect(pago).toMatchObject({ amount: 0, orderPaymentStatus: 'PAID', remainingBalanceCents: 0 })

    // La respuesta se perdió: la cola reintenta las dos llamadas con sus mismas llaves.
    const otraVez = await createOrderWithItems(venueId, venta)
    expect(otraVez.id).toBe(creada.id)
    expect(otraVez.paymentStatus).toBe('PAID')
    const pagoOtraVez = await payCashOrder(venueId, creada.id, { amount: 0, tip: 0, staffId, idempotencyKey: P, isOfflineReplay: true })
    expect(pagoOtraVez.paymentId).toBe(pago.paymentId)

    expect(await prisma.order.count({ where: { venueId, externalId: K } })).toBe(1)
    expect(await prisma.payment.count({ where: { orderId: creada.id } })).toBe(1)
    // UN vale de inventario para la venta, aunque se pidió dos veces.
    expect(await prisma.inventoryPosting.count({ where: { venueId, sourceId: creada.id, effectKind: 'SALE' } })).toBe(1)
    const filas = await prisma.orderDiscount.findMany({ where: { orderId: creada.id }, take: 5 })
    expect(filas.map(f => [f.type, f.name, Number(f.amount), f.appliedToItemIds.length])).toEqual([['COMP', 'Cortesía', 115, 2]])
    expect(await prisma.orderAction.count({ where: { orderId: creada.id, actionType: 'COMP', performedById: staffId } })).toBe(2)
    const cerrada = await prisma.order.findUniqueOrThrow({ where: { id: creada.id } })
    expect(cerrada.paymentStatus).toBe('PAID')
    expect(Number(cerrada.total)).toBe(0)
  })

  it('2. descuento de catálogo de la cuenta sobre lo que no es cortesía: fila con reparto sincronizado y currentUses++', async () => {
    const cafe = await producto(50, `Café 2 ${s}`)
    const pan = await producto(30, `Pan ${s}`)
    const jugo = await producto(20, `Jugo ${s}`)
    const diez = await prisma.discount.create({
      data: { venueId, name: `Diez ${s}`, type: 'PERCENTAGE', value: new Prisma.Decimal(10), scope: 'ORDER' },
    })

    const orden = await createOrderWithItems(venueId, {
      staffId,
      canCompItems: true,
      performedBy: staffId,
      externalId: `venta-${randomUUID()}`,
      source: 'TPV',
      orderType: 'TAKEOUT',
      isOfflineReplay: true,
      orderDiscountId: diez.id,
      items: [
        { productId: cafe.id, quantity: 2, isCortesia: true, cortesiaReason: 'Cliente frecuente' },
        { productId: pan.id, quantity: 1 },
        { productId: jugo.id, quantity: 1 },
      ],
    } as any)

    // 150 bruto − 100 de cortesía = 50 ⇒ 10 % = 5; total 45.
    expect(orden).toMatchObject({ subtotal: 150, discountAmount: 105, total: 45 })
    const deCuenta = await prisma.orderDiscount.findFirstOrThrow({ where: { orderId: orden.id, discountId: diez.id } })
    expect(Number(deCuenta.amount)).toBe(5)
    const reparto = deCuenta.reparto as any
    expect(reparto).toMatchObject({ alcance: 'CUENTA', conPromociones: false })
    const renglonesSinCortesia = (await prisma.orderItem.findMany({ where: { orderId: orden.id, isCortesia: false }, take: 5 })).map(
      r => r.id,
    )
    expect([...reparto.base].sort()).toEqual([...renglonesSinCortesia].sort())
    // Los 500 centavos repartidos entre pan y jugo, nada a la cortesía.
    expect(Object.values(reparto.renglones as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(500)
    expect(Object.keys(reparto.renglones).sort()).toEqual([...renglonesSinCortesia].sort())
    expect((await prisma.discount.findUniqueOrThrow({ where: { id: diez.id } })).currentUses).toBe(1)

    const pago = await payCashOrder(venueId, orden.id, { amount: 4500, tip: 0, staffId, idempotencyKey: `cobro-${randomUUID()}` })
    expect(pago).toMatchObject({ orderPaymentStatus: 'PAID', remainingBalanceCents: 0, orderTotalCents: 4500 })
  })
})

describe('Task4: Order lock entre primer cierre0 y admisión real de terminal', () => {
  let terminalId: string
  let socketId: string
  let registry: typeof import('@/communication/sockets/terminal-registry').terminalRegistry
  let terminal: typeof import('@/services/terminal-payment.service').terminalPaymentService

  const barrera = () => {
    let liberar!: () => void
    const promise = new Promise<void>(resolve => { liberar = resolve })
    return { promise, liberar }
  }
  const resultado = <T>(promise: Promise<T>) => promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )

  beforeEach(async () => {
    terminal = (await import('@/services/terminal-payment.service')).terminalPaymentService
    registry = (await import('@/communication/sockets/terminal-registry')).terminalRegistry
    const manager = (await import('@/communication/sockets/managers/socketManager')).default
    terminalId = `cierre0-${randomUUID()}`
    socketId = `socket-${randomUUID()}`
    registry.register(terminalId, socketId, venueId)
    // Sólo el borde de transporte: tras admitir realmente, el socket perdido deja UNKNOWN y libera su timer sin esperar5min.
    jest.spyOn(manager, 'getServer').mockReturnValue({ sockets: { sockets: new Map() } } as any)
  })

  afterEach(() => {
    registry?.unregisterBySocketId(socketId)
    jest.restoreAllMocks()
  })

  async function cuenta(cortesia = true) {
    const product = await prisma.product.create({ data: {
      venueId, categoryId, sku: `cierre0-${randomUUID()}`, name: `Artículo ${s}`, price: new Prisma.Decimal(110),
      trackInventory: true, inventoryMethod: 'QUANTITY',
    } })
    const inventory = await prisma.inventory.create({ data: { venueId, productId: product.id, currentStock: new Prisma.Decimal(5) } })
    const order = await createOrderWithItems(venueId, {
      staffId, performedBy: staffId, canCompItems: true, externalId: randomUUID(), source: 'AVOQADO_ANDROID', orderType: 'TAKEOUT',
      items: [{ productId: product.id, quantity: 1, externalId: randomUUID(), isCortesia: cortesia, cortesiaReason: cortesia ? 'Especial del administrador' : undefined }],
    } as any)
    for (const id of [product.id, inventory.id, order.id]) expect(id).toMatch(/^c[a-z0-9]{24}$/)
    return { orderId: order.id, inventoryId: inventory.id }
  }

  const solicitud = (orderId: string) => ({ terminalId, venueId, orderId, requestId: randomUUID(), amountCents: 11000, requestedBy: staffId })
  const pago = (orderId: string, key: string, amount = 0) => payCashOrder(venueId, orderId, {
    amount, tip: 0, staffId, idempotencyKey: key, isOfflineReplay: true,
  })
  async function huella(f: Awaited<ReturnType<typeof cuenta>>) {
    return {
      order: await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } }),
      pagos: await prisma.payment.count({ where: { venueId, orderId: f.orderId } }),
      postings: await prisma.inventoryPosting.count({ where: { venueId, sourceId: f.orderId, effectKind: 'SALE' } }),
      stock: (await prisma.inventory.findUniqueOrThrow({ where: { id: f.inventoryId } })).currentStock.toFixed(3),
      movimientos: await prisma.inventoryMovement.count({ where: { inventoryId: f.inventoryId } }),
    }
  }
  // Sin buscar «FOR UPDATE» en el texto: `pg_stat_activity.query` se corta a 1024 bytes y el candado canónico de las Orders
  // (`lockExistingOrderForPayment`, un CTE recursivo) lo dice después del corte. Basta con que espere un Lock del titular.
  async function esperarOrderBloqueada(pidTitular: number) {
    const limite = Date.now() + 5000
    while (Date.now() < limite) {
      const rows = await prisma.$queryRaw<Array<{ pid: number }>>`
        SELECT a.pid FROM pg_stat_activity a
        WHERE a.datname = current_database() AND ${pidTitular}::int = ANY(pg_blocking_pids(a.pid))
          AND a.wait_event_type = 'Lock' AND a.query ILIKE '%"Order"%'`
      if (rows.length > 0) {
        expect(rows[0].pid).not.toBe(pidTitular)
        return rows[0].pid
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throw new Error(`No se observó otro backend esperando el Order lock del PID ${pidTitular}`)
  }

  it('la admisión real gana Order lock: pay0 espera su commit y rechaza sin pago ni inventario', async () => {
    const f = await cuenta()
    const antes = await huella(f)
    const request = solicitud(f.orderId)
    const dentro = barrera(), soltar = barrera()
    let pidTitular = 0
    const realTransaction = prisma.$transaction.bind(prisma)
    // Instrumentación de barrera, no algoritmo de admisión: sólo el reserve real y la solicitud de ESTE caso.
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((operation: any, options: any) => {
      if (typeof operation !== 'function' || operation.name !== 'reserve') return realTransaction(operation, options)
      return realTransaction(async (tx: Prisma.TransactionClient) => {
        const admission = await operation(tx)
        const own = await tx.terminalPaymentRequest.findUnique({ where: { requestId: request.requestId } })
        if (admission.tipo === 'creada' && own?.orderId === f.orderId) {
          expect(own.status).toBe('PENDING')
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
          pidTitular = backend.pid
          dentro.liberar()
          await soltar.promise
        }
        return admission
      }, options)
    }) as any)
    const card = resultado(terminal.sendPaymentToTerminal(request))
    let cash: ReturnType<typeof resultado<Awaited<ReturnType<typeof payCashOrder>>>> | undefined
    try {
      await Promise.race([dentro.promise, card.then(() => { throw new Error('La admisión terminó sin alcanzar la barrera propia') })])
      cash = resultado(pago(f.orderId, randomUUID()))
      expect(await esperarOrderBloqueada(pidTitular)).toEqual(expect.any(Number))
    } finally {
      soltar.liberar()
      spy.mockRestore()
      await Promise.allSettled([card, ...(cash ? [cash] : [])])
    }
    expect(await card).toMatchObject({ ok: true, value: { status: 'timeout' } })
    expect(await cash!).toMatchObject({ ok: false, error: { statusCode: 409, code: 'ORDER_CANCEL_BLOCKED_BY_TERMINAL_CHARGE', details: { requestId: request.requestId } } })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: request.requestId } })).status).toBe('UNKNOWN')
    expect(await huella(f)).toEqual(antes)
  }, 30000)

  it('pay0 gana Order lock: la admisión real espera y rechaza PAID sin entregar ni cobrar tarjeta', async () => {
    const f = await cuenta()
    const dentro = barrera(), soltar = barrera()
    let pidTitular = 0
    const key = randomUUID(), request = solicitud(f.orderId)
    const cash = resultado(payCashOrder(venueId, f.orderId, {
      amount: 0, tip: 0, staffId, idempotencyKey: key, isOfflineReplay: true,
      dentroDeLaTx: async (tx, cobro) => {
        expect(cobro.orderId).toBe(f.orderId)
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        pidTitular = backend.pid
        dentro.liberar()
        await soltar.promise
      },
    }))
    let card: ReturnType<typeof resultado<Awaited<ReturnType<typeof terminal.sendPaymentToTerminal>>>> | undefined
    try {
      await Promise.race([dentro.promise, cash.then(() => { throw new Error('El pago terminó sin alcanzar su barrera real') })])
      card = resultado(terminal.sendPaymentToTerminal(request))
      expect(await esperarOrderBloqueada(pidTitular)).toEqual(expect.any(Number))
    } finally {
      soltar.liberar()
      await Promise.allSettled([cash, ...(card ? [card] : [])])
    }
    expect(await cash).toMatchObject({ ok: true, value: { amount: 0, orderPaymentStatus: 'PAID' } })
    expect(await card!).toMatchObject({ ok: false, error: { statusCode: 409, code: 'ORDER_ALREADY_PAID' } })
    expect(await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: request.requestId } })).toMatchObject({ status: 'FAILED', failureCode: 'REJECTED_ORDER_PAID', deliveryAttempts: 0, deliveryProvenance: { deliveries: [] } })
    expect(await huella(f)).toMatchObject({ pagos: 1, postings: 1, stock: '4.000', movimientos: 1, order: { paymentStatus: 'PAID' } })
  }, 30000)

  it('K0 dedup-first recupera el pago pese a una obligación incierta posterior, sin repetir inventario', async () => {
    const f = await cuenta(), key = randomUUID()
    const first = await pago(f.orderId, key)
    // Estado histórico inconsistente: una admisión NUEVA sobre PAID se rechaza en el caso anterior; no se finge que se admitió.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.orderId} AND "venueId" = ${venueId} FOR UPDATE`
      await tx.terminalPaymentRequest.create({ data: {
        requestId: randomUUID(), venueId, terminalId, orderId: f.orderId, amountCents: 11000,
        status: 'UNKNOWN', expiresAt: new Date(), requestedById: staffId,
      } })
    })
    const antes = await huella(f)
    expect(await terminal.hasChargeBlockingOrderCancel(venueId, f.orderId)).toBe(true)
    expect((await pago(f.orderId, key)).paymentId).toBe(first.paymentId)
    expect(await huella(f)).toEqual(antes)
  }, 30000)

  it('efectivo positivo ya capturado sigue entrando íntegro con terminal incierta y venta ya cerrada', async () => {
    const f = await cuenta(false)
    const request = solicitud(f.orderId)
    expect(await terminal.sendPaymentToTerminal(request)).toMatchObject({ status: 'timeout' })
    expect((await prisma.terminalPaymentRequest.findUniqueOrThrow({ where: { requestId: request.requestId } })).status).toBe('UNKNOWN')
    await pago(f.orderId, randomUUID(), 11000)
    const antes = await huella(f)
    const late = await pago(f.orderId, randomUUID(), 11000)
    expect(late).toMatchObject({ amount: 11000, remainingBalanceCents: 0, orderPaymentStatus: 'PAID' })
    const despues = await huella(f)
    expect(despues).toMatchObject({ pagos: 2, postings: 1, stock: '4.000', movimientos: 1, order: { paymentStatus: 'PAID' } })
    expect(despues.postings).toBe(antes.postings)
    expect(despues.stock).toBe(antes.stock)
    expect((await prisma.payment.findMany({ where: { venueId, orderId: f.orderId }, take: 3 })).map(p => p.amount.toFixed(2))).toEqual(['110.00', '110.00'])
  }, 30000)
})
