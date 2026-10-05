/**
 * Plan 3b T7-R1: the paid-but-open repair path (`reconcileOrderFromPayments` → `updateOrderTotalsForStandalonePayment`,
 * direct branch) pre-reads the Order and its payments, so a writer can commit between that read and the write. The
 * write transaction locks the Order first and rereads the inputs under the lock: on a change it reruns once from a
 * fresh read; if the rerun sees another change it writes nothing and warns (the sweep takes the order on its next tick).
 *  - The first two tests pause BEFORE the write transaction opens: they prove the reread, the rerun and the skip.
 *  - The third pauses INSIDE it, right after the reread: it proves the Order lock is already held there (a writer is
 *    blocked on real PostgreSQL). With the lock after the reread, or without it, that writer commits and is overwritten.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { reconcileOrderFromPayments, settleStandalonePaymentInTx } from '@/services/tpv/payment.tpv.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { lockExistingOrderForPayment } from '@/services/shared/paymentShiftClaim'
import { releaseTableIfSettled } from '@/services/tpv/table.tpv.service'
import {
  aplicarReasignacion,
  type CobroFoto,
  type DepsAplicar,
  type EscritorReasignacion,
  type OrdenFoto,
} from '@/services/shared/reasignarCobro'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  !/^\/(codex_testarudo_test_|avoqado_[a-z0-9]+_test_)/.test(database.pathname)
) {
  throw new Error('This suite requires an explicitly selected isolated local test database.')
}
const venueId = `reconcile-lost-update-${randomUUID()}`

function barrier<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    release = resolve
  })
  return { promise, release }
}
async function backendPid(tx: Pick<Prisma.TransactionClient, '$queryRaw'>) {
  const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
  return pid
}
/** Some connection is blocked by `pid` (row lock). */
async function blockedBy(pid: number) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
    if (count > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`No connection waited on backend ${pid}`)
}

/**
 * Pauses the repair pass each time it opens a transaction — always after its pre-read. Work run through `meanwhile`
 * (another device's writer) passes straight through, so `opened()` counts only the repair's transactions.
 */
function pauseRepairTransactions(times: number) {
  const gates = Array.from({ length: times }, () => ({ entered: barrier(), finish: barrier() }))
  const original = prisma.$transaction.bind(prisma)
  let opened = 0
  let outside = false
  jest.spyOn(prisma, '$transaction').mockImplementation((async (...args: any[]) => {
    if (!outside) {
      const gate = gates[opened++]
      if (gate) {
        gate.entered.release()
        await gate.finish.promise
      }
    }
    return (original as any)(...args)
  }) as any)
  return {
    gates,
    opened: () => opened,
    async meanwhile(write: () => Promise<unknown>) {
      outside = true
      try {
        await write()
      } finally {
        outside = false
      }
    },
  }
}

/**
 * Pauses the repair pass INSIDE its write transaction, right after it rereads the Order (its last read before writing).
 * Everything else — including other writers' transactions once it paused — passes straight through.
 */
function pauseAfterRepairReread() {
  const entered = barrier<number>()
  const finish = barrier()
  const original = prisma.$transaction.bind(prisma)
  let paused = false
  const bound = (target: object, key: string | symbol) => {
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  }
  jest.spyOn(prisma, '$transaction').mockImplementation(((body: any, options?: any) => {
    if (paused || typeof body !== 'function') return (original as any)(body, options)
    return (original as any)(async (tx: any) => {
      const order = new Proxy(tx.order, {
        get: (delegate, key) =>
          key !== 'findFirst'
            ? bound(delegate, key)
            : async (...args: unknown[]) => {
                const row = await delegate.findFirst(...args)
                if (!paused) {
                  paused = true
                  entered.release(await backendPid(tx))
                  await finish.promise
                }
                return row
              },
      })
      return body(new Proxy(tx, { get: (client, key) => (key === 'order' ? order : bound(client, key)) }))
    }, options)
  }) as any)
  return {
    entered: (repair: Promise<unknown>) =>
      Promise.race([entered.promise, repair.then(() => Promise.reject(new Error('repair never reread inside its transaction')))]),
    release: () => finish.release(),
  }
}

/** Paid but open: the $150 payment is COMPLETED, the transition to PAID never landed. */
function paidButOpenOrder() {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      subtotal: 150,
      taxAmount: 0,
      total: 150,
      remainingBalance: 150,
      items: { create: { productName: 'Plato', quantity: 1, unitPrice: 150, taxAmount: 0, total: 150 } },
      payments: { create: { venueId, amount: 150, feePercentage: 0, feeAmount: 0, netAmount: 150, method: 'CASH', status: 'COMPLETED' } },
    },
  })
}

/** Another device adds a $20 line (a real TPV writer: Order lock, reread, totals, commit). */
async function addDessert(orderId: string) {
  const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
  await addItemsToOrder(venueId, orderId, [{ customName: 'Postre', customUnitPriceCents: 2000, quantity: 1 }], version)
}

async function state(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  return {
    subtotal: Number(o.subtotal),
    total: Number(o.total),
    paid: Number(o.paidAmount),
    remaining: Number(o.remainingBalance),
    tip: Number(o.tipAmount),
    paymentStatus: o.paymentStatus,
    status: o.status,
    completedAt: o.completedAt,
  }
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value, error: undefined as unknown }),
    error => ({ value: undefined, error }),
  )

async function untilOpened(gate: { entered: { promise: Promise<void> } }, repair: Promise<unknown>) {
  await Promise.race([gate.entered.promise, repair.then(() => Promise.reject(new Error('repair did not open that transaction')))])
}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId } })
})
beforeEach(() => jest.mocked(logger.warn).mockClear())
afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.inventoryPosting.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

it('a line added while the repair pass computes is not overwritten by its stale totals', async () => {
  const order = await paidButOpenOrder()
  const tx = pauseRepairTransactions(1)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  await tx.meanwhile(() => addDessert(order.id))
  tx.gates[0].finish.release()
  expect((await repair).error).toBeUndefined()

  // $170 of goods, $150 paid: the check stays open with $20 due — never PAID with an unpaid line.
  expect(await state(order.id)).toMatchObject({ subtotal: 170, total: 170, paid: 150, remaining: 20, paymentStatus: 'PARTIAL' })
  // The stale attempt wrote nothing; the rerun read the committed line and wrote once.
  expect(tx.opened()).toBe(2)
  expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('[StandaloneTotals]'), expect.anything())
})

it('a second change during the rerun leaves the order as that writer committed it, and warns', async () => {
  const order = await paidButOpenOrder()
  const tx = pauseRepairTransactions(2)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  await tx.meanwhile(() => addDessert(order.id))
  tx.gates[0].finish.release()
  await untilOpened(tx.gates[1], repair)
  await tx.meanwhile(() => addDessert(order.id))
  const committed = await state(order.id)
  tx.gates[1].finish.release()

  // Nothing was written (T8-R3): the paid-order sweep must not audit this pass as reconciled.
  expect(await repair).toEqual({ value: { orderId: order.id, warning: null, written: false }, error: undefined })
  expect(committed).toMatchObject({ subtotal: 190, total: 190, paymentStatus: 'PENDING', completedAt: null })
  expect(await state(order.id)).toEqual(committed)
  expect(tx.opened()).toBe(2)
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('[StandaloneTotals]'),
    expect.objectContaining({ orderId: order.id, venueId }),
  )
})

it('a line arriving while the repair pass holds the Order waits for it, then sees the committed PAID and is refused', async () => {
  const order = await paidButOpenOrder()
  const hold = pauseAfterRepairReread()
  const repair = settle(reconcileOrderFromPayments(order.id))
  let adding: Promise<{ error: unknown }> | undefined
  try {
    const pid = await hold.entered(repair)
    adding = settle(addDessert(order.id))
    // Real PostgreSQL: the other device's writer is blocked by the repair pass's transaction, after its reread.
    await blockedBy(pid)
  } finally {
    hold.release()
    await repair
    await adding
  }

  expect(await repair).toEqual({ value: { orderId: order.id, warning: null, written: true }, error: undefined })
  // The writer read the committed PAID under the lock and refused: no unpaid line inside a paid check.
  expect((await adding!).error).toMatchObject({ message: 'Cannot add items to a paid order' })
  expect(await state(order.id)).toMatchObject({
    subtotal: 150,
    total: 150,
    paid: 150,
    remaining: 0,
    paymentStatus: 'PAID',
    status: 'COMPLETED',
  })
  expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1)
})

it('🔴 Codex r6 #2: un IVA que el puente cambia mientras la reconciliación calcula no se pisa — relee y escribe $116 con $16 pendientes (la v6 cerraba PAGADA en $100)', async () => {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      contratoDePrecio: 'IVA_APARTE',
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } },
      payments: { create: { venueId, amount: 100, feePercentage: 0, feeAmount: 0, netAmount: 100, method: 'CASH', status: 'COMPLETED' } },
    },
  })
  const tx = pauseRepairTransactions(1)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  // Lo que escribe el puente cuando llega la cabecera de SoftRestaurant (`posSyncOrder.service.ts:343-347`): sólo IVA y total.
  // Subtotal, descuento, cargo, estado de pago, mesero y cobros siguen iguales: la huella de la v6 no lo distinguía.
  await tx.meanwhile(() => prisma.order.update({ where: { id: order.id }, data: { taxAmount: 16, total: 116 } }))
  tx.gates[0].finish.release()
  expect((await repair).error).toBeUndefined()
  expect(await state(order.id)).toMatchObject({ subtotal: 100, total: 116, paid: 100, remaining: 16, paymentStatus: 'PARTIAL' })
  expect(tx.opened()).toBe(2) // la pasada vieja no escribió; la relectura escribió una vez
})

/**
 * Codex r7 #3: una carrera por entrada de la huella. Cuenta de $100 con IVA 16 escrito y `cobrado` pesos cobrados (100 por
 * defecto); `cambio` corre mientras la reconciliación calcula.
 */
async function carrera(contratoDePrecio: 'IVA_APARTE' | 'DESCONOCIDO', cambio: Prisma.OrderUpdateInput, cobrado = 100) {
  const order = await prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      contratoDePrecio,
      subtotal: 100,
      taxAmount: 16,
      total: 116,
      remainingBalance: 116,
      items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 16, total: 100 } },
      ...(cobrado > 0 && {
        payments: {
          create: { venueId, amount: cobrado, feePercentage: 0, feeAmount: 0, netAmount: cobrado, method: 'CASH', status: 'COMPLETED' },
        },
      }),
    },
  })
  const tx = pauseRepairTransactions(1)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair) // la lectura vieja: debe $116, tiene $100 ⇒ PARCIAL con $16
  await tx.meanwhile(() => prisma.order.update({ where: { id: order.id }, data: cambio }))
  tx.gates[0].finish.release()
  expect((await repair).error).toBeUndefined()
  return { order, opened: tx.opened() }
}

it('🔴 Codex r7 #3: un cambio SÓLO de contrato (DESCONOCIDO → IVA_INCLUIDO, lo que escribe confirmar una venta vieja) se relee: el IVA deja de sumar y la cuenta queda PAGADA en $100 (sin el contrato en la huella: PARCIAL con $16)', async () => {
  const { order, opened } = await carrera('DESCONOCIDO', { contratoDePrecio: 'IVA_INCLUIDO' })
  expect(await state(order.id)).toMatchObject({ total: 100, paid: 100, remaining: 0, paymentStatus: 'PAID', status: 'COMPLETED' })
  expect(opened).toBe(2)
})

it('🔴 Codex r7 #3 (v10, sin cobros): un cambio de CLASE de estado (PENDING → CANCELLED) se relee: la cancelada no debe IVA y guarda $100 por cobrar = el saldo reconstruido; sin dinero no se reabre ni se cierra (sin la clase en la huella: $116 guardados contra $100)', async () => {
  // Sin cobros a propósito: desde la Tarea 6a una cancelada CON dinero se reabre, y la clase deja de cambiar el resultado. Sin dinero
  // sigue siendo la entrada que separa «debe $116» (viva) de «debe $100» (cancelada).
  const { order, opened } = await carrera('IVA_APARTE', { status: 'CANCELLED' }, 0)
  expect(await state(order.id)).toMatchObject({ total: 100, paid: 0, remaining: 100, paymentStatus: 'PENDING', status: 'CANCELLED' })
  expect(opened).toBe(2)
})

it('control — Codex r7 #2: cambios entre estados VIVOS (PENDING → CONFIRMED, y CONFIRMED → PREPARING si hubiera reintento) no gastan el reintento: una sola pasada escribe y la cuenta cubierta queda PAGADA (con el literal: dos pasadas y `written: false`)', async () => {
  const order = await paidButOpenOrder() // $150 de cuenta, $150 cobrados
  const tx = pauseRepairTransactions(2)
  const repair = settle(reconcileOrderFromPayments(order.id))
  await untilOpened(tx.gates[0], repair)
  await tx.meanwhile(() => prisma.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } }))
  // Sólo si (mal) reintenta: un segundo cambio entre estados vivos, como el que hace el dashboard sin tocar dinero.
  void tx.gates[1].entered.promise.then(async () => {
    await tx.meanwhile(() => prisma.order.update({ where: { id: order.id }, data: { status: 'PREPARING' } }))
    tx.gates[1].finish.release()
  })
  tx.gates[0].finish.release()
  expect(await repair).toEqual({ value: { orderId: order.id, warning: null, written: true }, error: undefined })
  expect(tx.opened()).toBe(1)
  expect(await state(order.id)).toMatchObject({ total: 150, remaining: 0, paymentStatus: 'PAID' })
})

describe('Codex r6 #1: reasignar un cobro a una cancelada con IVA aparte, con la reconciliación real', () => {
  const crearCobro = (orderId: string, importe: number) =>
    prisma.payment.create({
      data: { venueId, orderId, amount: importe, feePercentage: 0, feeAmount: 0, netAmount: importe, method: 'CASH', status: 'COMPLETED' },
    })
  /** El origen: su cuenta de $116 cubierta por su cobro + el cobro AJENO de `importe`. El destino: CANCELADA de $100 + $16 aparte, sin cobros. */
  async function pareja(importe: number, destinoExtra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
    const origen = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 116,
        taxAmount: 0,
        total: 116,
        remainingBalance: 0,
        completedAt: new Date(),
        items: { create: { productName: 'Plato', quantity: 1, unitPrice: 116, taxAmount: 0, total: 116 } },
      },
    })
    await crearCobro(origen.id, 116)
    const ajeno = await crearCobro(origen.id, importe)
    const destino = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
        contratoDePrecio: 'IVA_APARTE',
        subtotal: 100,
        taxAmount: 16,
        total: 116,
        remainingBalance: 116,
        items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 16, total: 100 } },
        ...destinoExtra,
      },
    })
    return { origen, destino, ajeno }
  }
  // `db` = el `tx` cuando se relee bajo el candado (Codex r11 #7); por omisión, `prisma` (la foto de afuera).
  async function ordenFoto(orderId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<OrdenFoto> {
    const o = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        payments: {
          where: { status: 'COMPLETED' },
          select: { id: true, status: true, type: true, amount: true, tipAmount: true },
          take: 10,
        },
        items: { select: { areaTicketLineId: true }, take: 10 },
      },
    })
    return {
      id: o.id,
      venueId: o.venueId,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      shiftId: o.shiftId,
      completedAt: o.completedAt,
      subtotal: o.subtotal,
      discountAmount: o.discountAmount,
      serviceChargeAmount: o.serviceChargeAmount,
      contratoDePrecio: o.contratoDePrecio,
      taxAmount: o.taxAmount,
      source: o.source,
      externalId: o.externalId,
      tableId: o.tableId,
      items: o.items,
      cobros: o.payments,
    }
  }
  async function cobroFoto(paymentId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<CobroFoto> {
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } })
    return {
      id: p.id,
      venueId: p.venueId,
      orderId: p.orderId!,
      status: p.status,
      type: p.type,
      amount: p.amount,
      tipAmount: p.tipAmount,
      shiftId: p.shiftId,
      createdAt: p.createdAt,
    }
  }
  let estadoAlGuardar: string[] = []
  beforeEach(() => {
    estadoAlGuardar = []
  })
  /** Las MISMAS dependencias que el script (`scripts/reasignar-cobro-a-su-orden.ts`), con una falla inyectable DESPUÉS de cada paso. */
  const depsReales = (fallaEn?: keyof EscritorReasignacion): DepsAplicar => ({
    enTransaccion: fn =>
      prisma.$transaction(tx => {
        const tras = async <T>(nombre: keyof EscritorReasignacion, hecho: Promise<T>): Promise<T> => {
          const valor = await hecho
          if (fallaEn === nombre) throw new Error(`falla inyectada en ${nombre}`)
          return valor
        }
        return fn({
          bloquear: ids =>
            tras(
              'bloquear',
              (async () => {
                for (const id of ids)
                  if (!(await lockExistingOrderForPayment(tx, { venueId, orderId: id }))) throw new Error(`orden ${id} ajena`)
              })(),
            ),
          releer: async antes => ({
            cobro: await cobroFoto(antes.cobro.id, tx),
            origen: await ordenFoto(antes.origen.id, tx),
            destino: await ordenFoto(antes.destino.id, tx),
          }),
          moverCobro: (paymentId, de, a) =>
            tras(
              'moverCobro',
              tx.payment
                .updateMany({ where: { id: paymentId, orderId: de, status: 'COMPLETED' }, data: { orderId: a } })
                .then(r => r.count),
            ),
          prepararDestino: (id, data) =>
            tras(
              'prepararDestino',
              tx.order.update({ where: { id }, data }).then(() => undefined),
            ),
          guardarTotales: (id, cobro, conEfectos) =>
            tras(
              'guardarTotales',
              (async () => {
                // Codex r9 #4: el estado de la cuenta al guardar sus totales. El cierre también reabre una cancelada con dinero
                // (Tarea 6a), así que el resultado final no distingue quién la reabrió; esto sí.
                if (cobro) estadoAlGuardar.push((await tx.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status)
                const pago = cobro
                  ? {
                      id: cobro.id,
                      amount: new Prisma.Decimal((cobro.amount ?? 0).toString()),
                      tipAmount: new Prisma.Decimal((cobro.tipAmount ?? 0).toString()),
                    }
                  : { amount: new Prisma.Decimal(0), tipAmount: new Prisma.Decimal(0) }
                await settleStandalonePaymentInTx(tx, venueId, id, pago, undefined, false, conEfectos)
              })(),
            ),
          fijarCompletadoEn: (id, cuando) =>
            tras(
              'fijarCompletadoEn',
              tx.order.update({ where: { id }, data: { completedAt: cuando } }).then(() => undefined),
            ),
          bitacora: p =>
            tras(
              'bitacora',
              tx.activityLog
                .create({
                  data: {
                    staffId: null,
                    venueId: p.venueId,
                    action: p.action,
                    entity: p.entity,
                    entityId: p.entityId,
                    data: p.data as Prisma.InputJsonValue,
                  },
                })
                .then(() => undefined),
            ),
        })
      }),
    liberarMesa: (venue, tableId) => releaseTableIfSettled(venue, tableId),
  })
  const reasignar = async (p: Awaited<ReturnType<typeof pareja>>, fallaEn?: keyof EscritorReasignacion) =>
    aplicarReasignacion(
      depsReales(fallaEn),
      { paymentId: p.ajeno.id, deOrden: p.origen.orderNumber, aOrden: p.destino.orderNumber, motivo: 'Codex r6 #1' },
      await cobroFoto(p.ajeno.id),
      await ordenFoto(p.origen.id),
      await ordenFoto(p.destino.id),
    )

  it('🔴 acepta los $116 correctos: el destino se reabre y la reconciliación lo cierra PAGADO en $116; el origen sigue cubierto (la v6 los rechazaba)', async () => {
    const p = await pareja(116)
    expect((await reasignar(p)).ok).toBe(true)
    const d = await prisma.order.findUniqueOrThrow({ where: { id: p.destino.id } })
    expect([d.status, d.paymentStatus, Number(d.total), Number(d.remainingBalance)]).toEqual(['COMPLETED', 'PAID', 116, 0])
    const o = await prisma.order.findUniqueOrThrow({ where: { id: p.origen.id } })
    expect([o.paymentStatus, Number(o.total), Number(o.remainingBalance)]).toEqual(['PAID', 116, 0])
    expect(o.loyaltyEligibleAt).toBeNull() // Codex r10 #6: el origen sólo guarda totales (`efectosDeCierre = false`)
    // M-3 (revisión 6d): el destino SÍ se cierra con sus efectos de saldar: su vale de venta y su lealtad.
    expect(await prisma.inventoryPosting.count({ where: { venueId, orderId: p.destino.id, effectKind: 'SALE' } })).toBe(1)
    expect(d.loyaltyEligibleAt).not.toBeNull()
    // r9 #4: la reabrió la reasignación (a PENDING, en la misma transacción que movió el cobro), no la red del cierre.
    expect(estadoAlGuardar).toEqual(['PENDING'])
    expect(await prisma.activityLog.count({ where: { entityId: p.destino.id, action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT' } })).toBe(0)
    expect(await prisma.activityLog.count({ where: { entityId: { in: [p.origen.id, p.destino.id] }, action: 'PAYMENT_REASSIGNED' } })).toBe(
      2,
    )
  })

  // Jest no admite `%2$s`: la etiqueta va primero para que el título la lea en orden.
  it.each([
    ['🔴', 'guardarTotales'],
    ['🔴', 'fijarCompletadoEn'],
    ['🔴', 'bitacora'],
    // Controles (Codex r11 #8): en la v10 una falla al mover o al preparar ya revertía su primera transacción (`reasignarCobro.ts:193`).
    ['control —', 'moverCobro'],
    ['control —', 'prepararDestino'],
  ] as const)(
    '%s Codex r10 #6: si falla «%s», NADA queda escrito: el cobro sigue en el origen, el destino CANCELADO con sus totales y sin bitácora (la v10, en las tres rojas: la reapertura ya estaba comprometida y totales y bitácora iban después, sueltos)',
    async (_etiqueta, paso) => {
      const p = await pareja(116)
      const antes = await prisma.order.findUniqueOrThrow({ where: { id: p.destino.id } })
      await expect(reasignar(p, paso)).rejects.toThrow(`falla inyectada en ${paso}`)
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.ajeno.id } })).orderId).toBe(p.origen.id)
      const d = await prisma.order.findUniqueOrThrow({ where: { id: p.destino.id } })
      expect([d.status, d.paymentStatus, Number(d.total), Number(d.remainingBalance)]).toEqual([
        antes.status,
        antes.paymentStatus,
        Number(antes.total),
        Number(antes.remainingBalance),
      ])
      expect(
        await prisma.activityLog.count({
          where: {
            entityId: { in: [p.origen.id, p.destino.id] },
            action: { in: ['PAYMENT_REASSIGNED', 'ORDER_REOPENED_BY_CAPTURED_PAYMENT'] },
          },
        }),
      ).toBe(0)
    },
  )

  it('🔴 Codex r11 #7: dos casos del MISMO origen con fotos tomadas antes (como el script, que carga todo antes de aplicar): el primero mueve su cobro; el segundo se rechaza al revalidar bajo el candado y el origen sigue PAGADO con su cobro (la v11: los dos `ok` y el origen PAGADO con $0 cobrados y $100 de saldo)', async () => {
    const origen = await prisma.order.create({
      data: {
        venueId,
        orderNumber: randomUUID(),
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        contratoDePrecio: 'IVA_INCLUIDO',
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        remainingBalance: 0,
        completedAt: new Date(),
        items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } },
      },
    })
    const [a, b] = [await crearCobro(origen.id, 100), await crearCobro(origen.id, 100)]
    const destino = () =>
      prisma.order.create({
        data: {
          venueId,
          orderNumber: randomUUID(),
          status: 'PENDING',
          paymentStatus: 'PENDING',
          contratoDePrecio: 'IVA_INCLUIDO',
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          remainingBalance: 100,
          items: { create: { productName: 'Plato', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 } },
        },
      })
    const [d1, d2] = [await destino(), await destino()]
    // Las fotos de los dos casos, tomadas ANTES de aplicar el primero.
    const fotos = await Promise.all(
      [a, b].map(async (cobro, i) => ({
        cobro: await cobroFoto(cobro.id),
        origen: await ordenFoto(origen.id),
        destino: await ordenFoto([d1, d2][i].id),
      })),
    )
    const aplicar = (i: number) =>
      aplicarReasignacion(
        depsReales(),
        { paymentId: fotos[i].cobro.id, deOrden: origen.orderNumber, aOrden: fotos[i].destino.orderNumber, motivo: 'Codex r11 #7' },
        fotos[i].cobro,
        fotos[i].origen,
        fotos[i].destino,
      )
    expect((await aplicar(0)).ok).toBe(true)
    const segundo = await aplicar(1)
    expect(segundo.ok).toBe(false)
    if (!segundo.ok) expect(segundo.motivos.join(' ')).toContain('el origen quedaría con saldo de $100.00')
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: b.id } })).orderId).toBe(origen.id)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: origen.id } })
    expect([o.paymentStatus, Number(o.paidAmount), Number(o.remainingBalance)]).toEqual(['PAID', 100, 0])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: d2.id } })).paymentStatus).toBe('PENDING')
  })

  it('🔴 rechaza los $100 sin mover nada (la v6 los movía y la reconciliación dejaba el destino PARCIAL con $16)', async () => {
    const p = await pareja(100)
    expect(await reasignar(p)).toEqual({ ok: false, motivos: ['el cobro no cubre la cuenta del destino: faltan $16.00'] })
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.ajeno.id } })).orderId).toBe(p.origen.id)
    const d = await prisma.order.findUniqueOrThrow({ where: { id: p.destino.id } })
    expect([d.status, d.paymentStatus]).toEqual(['CANCELLED', 'PENDING'])
  })

  it('🔴 I-1 (revisión 6d): un destino INTEGRADO (SoftRestaurant: POS con `externalId`) guarda sus totales SIN efectos de saldar — ni vale de venta ni lealtad, como en `recordOrderPayment` — y el resumen avisa que el inventario va aparte', async () => {
    const p = await pareja(116, { source: 'POS', externalId: `SR-${randomUUID()}`, originSystem: 'POS_SOFTRESTAURANT' })
    const r = await reasignar(p)
    expect(r.ok && r.resumen.destinoConEfectosDeCierre).toBe(false)
    const d = await prisma.order.findUniqueOrThrow({ where: { id: p.destino.id } })
    expect([d.status, d.paymentStatus, Number(d.total), Number(d.remainingBalance)]).toEqual(['COMPLETED', 'PAID', 116, 0])
    expect(await prisma.inventoryPosting.count({ where: { venueId, orderId: p.destino.id } })).toBe(0)
    expect(d.loyaltyEligibleAt).toBeNull()
  })

  it('🔴 M-1 (revisión 6d): la mesa del destino se libera al terminar (la reconciliación de antes lo hacía; el cierre dentro de la transacción no)', async () => {
    const p = await pareja(116)
    const mesa = await prisma.table.create({
      data: {
        venueId,
        number: `T-${randomUUID().slice(0, 8)}`,
        capacity: 4,
        qrCode: randomUUID(),
        status: 'OCCUPIED',
        currentOrderId: p.destino.id,
      },
    })
    await prisma.order.update({ where: { id: p.destino.id }, data: { tableId: mesa.id } })
    expect((await reasignar(p)).ok).toBe(true)
    expect(await prisma.table.findUniqueOrThrow({ where: { id: mesa.id }, select: { status: true, currentOrderId: true } })).toEqual({
      status: 'AVAILABLE',
      currentOrderId: null,
    })
  })
})
