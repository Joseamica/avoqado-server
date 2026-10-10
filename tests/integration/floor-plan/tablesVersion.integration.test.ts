/**
 * Plano en el POS (fase 4a, spec 2026-10-09 §3.1): el CONTRATO de la versión, contra Postgres real.
 * Cada ruta del servidor que cambia mesas, cuentas o plano tiene que mover su versión; si alguna no la moviera, el mesero
 * vería datos viejos EN SILENCIO. Una prueba por ruta, llamando a la MISMA función que llama el controlador.
 *
 *   TEST_DATABASE_URL='postgresql://…/avoqado_planopos_test_20261009' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/floor-plan/tablesVersion.integration.test.ts
 *
 * Sin limpieza a propósito (como tableAdmission): cada prueba crea su propio venue con id único y la base es desechable.
 * Si algún día se agrega una limpieza con `deleteMany({ where: { venueId } })`, va con `if (!venueId) return` antes.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { readTablesVersions, tablesVersionSql, type TablesVersions } from '@/services/mobile/tablesVersion.service'
import {
  assignTable,
  clearTable,
  createTable,
  deleteTable,
  moveOrderToTable,
  releaseTableIfSettled,
  setTableStatusInTransaction,
  updateTablePosition,
} from '@/services/tpv/table.tpv.service'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'
import { cancelOrder, mergeOrders, payCashOrder, splitOrderBySeat, splitOrderItems } from '@/services/mobile/order.mobile.service'
import { compOrderItem, compWholeOrder } from '@/services/mobile/comp-item.mobile.service'
import { processPosOrderItemEvent } from '@/services/pos-sync/posSyncOrderItem.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { recordOrderPayment } from '@/services/tpv/payment.tpv.service'
import { getFloorPlan, publishFloorPlan } from '@/services/dashboard/floorPlan/floorPlan.service'
import { createFloorElement, deleteFloorElement, updateFloorElement } from '@/services/tpv/floor-element.tpv.service'
import { updateOrder } from '@/services/dashboard/order.dashboard.service'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'
import type { DesiredTable, PlanTable, PublishFloorPlanInput } from '@/services/dashboard/floorPlan/floorPlan.types'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const target = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/avoqado_[a-z0-9]+_test_/.test(target.pathname)) {
  throw new Error('Exige una base de prueba local y desechable (p. ej. avoqado_planopos_test_20261009).')
}

jest.setTimeout(120_000)

// 🔴 Vacíos hasta que existan.
let venueId = ''
let staffId = ''
let productId = ''

async function nuevoVenue(): Promise<string> {
  const id = `planopos-${randomUUID()}`
  await prisma.organization.create({ data: { id, name: 'Plano POS org', email: `${id}@example.test`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id, organizationId: id, name: 'Plano POS', slug: id } })
  return id
}

beforeEach(async () => {
  venueId = await nuevoVenue()
  staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Plano', lastName: 'Mesero' } })).id
  await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })
  const categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${venueId}` } })).id
  productId = (await prisma.product.create({ data: { venueId, categoryId, sku: `CAFE-${venueId}`, name: 'Café', price: 50 } })).id
})

afterAll(() => prisma.$disconnect())

/** `updatedAt` guarda milisegundos: dos escrituras en el mismo milisegundo no se distinguirían. */
const pausa = () => new Promise(r => setTimeout(r, 5))

/** Rechaza a los `ms`: una espera entre dos conexiones nunca cuelga la suite. */
function conTope<T>(promesa: Promise<T>, ms: number, que: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const tope = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`${que}: más de ${ms} ms`)), ms)
  })
  return Promise.race([promesa, tope]).finally(() => clearTimeout(timer))
}

async function alrededorDe(accion: () => Promise<unknown>): Promise<{ antes: TablesVersions; despues: TablesVersions }> {
  const antes = await readTablesVersions(venueId)
  await pausa()
  await accion()
  return { antes, despues: await readTablesVersions(venueId) }
}

async function mesa(number = randomUUID().slice(0, 8)) {
  return prisma.table.create({ data: { venueId, number, capacity: 4, qrCode: randomUUID() } })
}

/** Una cuenta viva en la mesa, con dos renglones (separar necesita al menos dos), apuntada por la mesa. */
async function cuentaEnMesa(tableId: string, total = 100) {
  const order = await prisma.order.create({
    data: {
      venueId,
      tableId,
      orderNumber: randomUUID(),
      servedById: staffId,
      subtotal: total,
      taxAmount: 0,
      total,
      remainingBalance: total,
      contratoDePrecio: 'IVA_INCLUIDO',
      items: {
        create: [
          { productName: 'Café', quantity: 1, unitPrice: total / 2, total: total / 2, taxAmount: 0 },
          { productName: 'Pan', quantity: 1, unitPrice: total / 2, total: total / 2, taxAmount: 0 },
        ],
      },
    },
  })
  await prisma.table.update({ where: { id: tableId }, data: { status: 'OCCUPIED', currentOrderId: order.id } })
  return order
}

const pagoTerminal = (amountCents: number) => ({
  venueId,
  amount: amountCents,
  tip: 0,
  status: 'COMPLETED' as const,
  method: 'CASH' as const,
  source: 'TPV',
  splitType: 'EQUALPARTS' as const,
  tpvId: 'test-tpv',
  staffId,
  paidProductsId: [],
  currency: 'MXN',
  isInternational: false,
})

// Plano (mismos ayudantes que publishFloorPlan.integration.test.ts)
const mesaDelPlano = (clientId: string, number: string, extra: Partial<DesiredTable> = {}): DesiredTable => ({
  clientId,
  number,
  capacity: 4,
  shape: 'SQUARE',
  rotation: 0,
  positionX: 0.5,
  positionY: 0.5,
  areaRef: 'a1',
  ...extra,
})
const igual = (t: PlanTable, extra: Partial<DesiredTable> = {}): DesiredTable => ({
  id: t.id,
  number: t.number,
  capacity: t.capacity,
  shape: t.shape,
  rotation: t.rotation,
  positionX: t.positionX,
  positionY: t.positionY,
  areaRef: t.areaId,
  ...extra,
})
const publicar = (input: Partial<PublishFloorPlanInput> & { baseFingerprint: string }) =>
  publishFloorPlan(venueId, { saveId: randomUUID(), areas: [], tables: [], elements: [], ...input }, staffId)
const salonNuevo = { clientId: 'a1', name: 'Salón', floorShape: 'WIDE' as const, sortOrder: 0 }
const salon = (id: string, extra: Partial<{ name: string; floorShape: 'WIDE' | 'SQUARE' | 'TALL'; sortOrder: number }> = {}) => ({
  id,
  name: 'Salón',
  floorShape: 'WIDE' as const,
  sortOrder: 0,
  ...extra,
})

describe('la versión es estable', () => {
  it('leer dos veces sin cambios da la misma versión', async () => {
    const t = await mesa()
    await cuentaEnMesa(t.id)
    const a = await readTablesVersions(venueId)
    const b = await readTablesVersions(venueId)
    expect(b).toEqual(a)
    expect(a.tablesVersion).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('tablesVersion se mueve por cada ruta que cambia mesas o cuentas (spec §3.1)', () => {
  it('abrir una mesa (assignTable) — y NO mueve floorPlanVersion', async () => {
    const t = await mesa()
    const { antes, despues } = await alrededorDe(() => assignTable(venueId, t.id, staffId, 2))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(despues.floorPlanVersion).toBe(antes.floorPlanVersion)
  })

  it('agregar productos desde el POS móvil (ronda)', async () => {
    const t = await mesa()
    const { order } = await assignTable(venueId, t.id, staffId, 2)
    const { antes, despues } = await alrededorDe(() =>
      addItemsToOrder(venueId, order.id, [{ productId, quantity: 1 }], order.version, true),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('agregar productos desde la TPV (carrito completo)', async () => {
    const t = await mesa()
    const { order } = await assignTable(venueId, t.id, staffId, 2)
    const { antes, despues } = await alrededorDe(() => addItemsToOrder(venueId, order.id, [{ productId, quantity: 2 }], order.version))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('un cobro PARCIAL en efectivo desde el POS', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const { antes, despues } = await alrededorDe(() =>
      payCashOrder(venueId, o.id, { amount: 4_000, tip: 0, staffId, idempotencyKey: randomUUID() }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('el cobro que SALDA la cuenta desde el POS', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const { antes, despues } = await alrededorDe(() =>
      payCashOrder(venueId, o.id, { amount: 10_000, tip: 0, staffId, idempotencyKey: randomUUID() }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('un cobro parcial y luego el total desde la terminal (recordOrderPayment)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const parcial = await alrededorDe(() => recordOrderPayment(venueId, o.id, pagoTerminal(5_000), staffId))
    expect(parcial.despues.tablesVersion).not.toBe(parcial.antes.tablesVersion)
    const total = await alrededorDe(() => recordOrderPayment(venueId, o.id, pagoTerminal(5_000), staffId))
    expect(total.despues.tablesVersion).not.toBe(total.antes.tablesVersion)
  })

  it('liberar la mesa (clearTable) con la cuenta ya pagada', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    // Pagada pero todavía viva (en cocina): clearTable la acepta y libera la mesa.
    await prisma.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', status: 'CONFIRMED', remainingBalance: 0 } })
    const { antes, despues } = await alrededorDe(() => clearTable(venueId, t.id))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('liberar al saldarse la última cuenta (releaseTableIfSettled)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    await prisma.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', status: 'COMPLETED', remainingBalance: 0 } })
    const { antes, despues } = await alrededorDe(async () => expect(await releaseTableIfSettled(venueId, t.id)).toBe(true))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('anular la cuenta (cancelOrder)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const { antes, despues } = await alrededorDe(() => cancelOrder(venueId, o.id, 'Prueba', staffId))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('mover la cuenta a otra mesa (moveOrderToTable)', async () => {
    const origen = await mesa()
    const destino = await mesa()
    const o = await cuentaEnMesa(origen.id, 100)
    const { antes, despues } = await alrededorDe(() => moveOrderToTable(venueId, o.id, destino.id))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('unir dos cuentas de la mesa (mergeOrders)', async () => {
    const t = await mesa()
    const destino = await cuentaEnMesa(t.id, 100)
    const origen = await cuentaEnMesa(t.id, 60)
    const { antes, despues } = await alrededorDe(() => mergeOrders(venueId, destino.id, origen.id, staffId))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('separar artículos en otra cuenta (splitOrderItems)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const [primero] = await prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { id: 'asc' }, take: 2 })
    const { antes, despues } = await alrededorDe(() => splitOrderItems(venueId, o.id, [primero.id], staffId))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('la PAX mueve una mesa (updateTablePosition) — y NO mueve floorPlanVersion', async () => {
    const t = await mesa()
    const { antes, despues } = await alrededorDe(() => updateTablePosition(venueId, t.id, 0.3, 0.4))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(despues.floorPlanVersion).toBe(antes.floorPlanVersion)
  })

  // Corrección C1 (auditoría Codex, hallazgo 2): Prisma pone `updatedAt` al ESCRIBIR. Si A escribe primero y confirma
  // DESPUÉS que B, el `updatedAt` de A es menor que el máximo ya visto: con `MAX` la versión no se movería.
  // T2a (auditoría del código): la prueba afirma que ESE orden ocurrió de verdad (A < B leídos después) y ninguna espera
  // entre conexiones puede colgar la suite: todas tienen tope y A se suelta en `finally`.
  it('una transacción que confirma TARDE con un updatedAt menor también la mueve (dos conexiones)', async () => {
    const t1 = await mesa()
    const t2 = await mesa()
    const a = await cuentaEnMesa(t1.id)
    const b = await cuentaEnMesa(t2.id)
    let soltar!: () => void
    const espera = new Promise<void>(r => (soltar = r))
    let escribioA!: () => void
    const aEscribio = new Promise<void>(r => (escribioA = r))
    const transaccionA = prisma.$transaction(
      async tx => {
        await tx.order.update({ where: { id: a.id }, data: { customerName: 'A tarde' } })
        escribioA()
        await conTope(espera, 5_000, 'A esperando a que B escriba')
      },
      { timeout: 15_000 },
    )
    let antes: TablesVersions
    try {
      // Si A falla antes de escribir, la carrera lo dice al momento (no a los 120 s del timeout de jest).
      await conTope(Promise.race([aEscribio, transaccionA]), 5_000, 'esperando la escritura de A')
      await pausa()
      await prisma.order.update({ where: { id: b.id }, data: { customerName: 'B pronto' } })
      antes = await readTablesVersions(venueId)
    } finally {
      soltar()
    }
    await transaccionA
    const despues = await readTablesVersions(venueId)
    const [filaA, filaB] = await Promise.all(
      [a.id, b.id].map(id => prisma.order.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })),
    )
    // El caso que motivó la suma: A confirmó DESPUÉS de B y aun así quedó con el updatedAt MENOR.
    expect(filaA.updatedAt.getTime()).toBeLessThan(filaB.updatedAt.getTime())
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  // Corrección C2 (hallazgo 4): el PUT del dashboard deja `tableId = null` sin limpiar `Table.currentOrderId`, y /tables
  // sigue pintando esa cuenta por el puntero. Sus cambios siguientes tienen que mover la versión.
  it('una cuenta que la mesa apunta aunque ya no tenga tableId (PUT del dashboard) sigue moviendo la versión', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id)
    await updateOrder(venueId, o.id, { tableId: null } as any)
    const otro = (await prisma.staff.create({ data: { email: `${venueId}@otro.test`, firstName: 'Otro', lastName: 'Mesero' } })).id
    await prisma.staffVenue.create({ data: { venueId, staffId: otro, role: 'WAITER' } })
    const { antes, despues } = await alrededorDe(() => updateOrder(venueId, o.id, { servedById: otro } as any))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  // T2b (auditoría del código, «arreglar antes de publicar»): las rutas que faltaban, cada una por su función real.
  it('cambiar el estado de una mesa (setTableStatusInTransaction, la del MCP set_table_status) — y NO mueve floorPlanVersion', async () => {
    const t = await mesa()
    const { antes, despues } = await alrededorDe(() =>
      prisma.$transaction(tx => setTableStatusInTransaction(tx, venueId, t.id, 'RESERVED'), ORDER_LOCK_WAIT_BUDGET),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(despues.floorPlanVersion).toBe(antes.floorPlanVersion)
  })

  it('separar la cuenta por asiento (splitOrderBySeat, la del MCP split_table_check_by_seat)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const renglones = await prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { id: 'asc' }, take: 2 })
    await Promise.all(renglones.map((r, i) => prisma.orderItem.update({ where: { id: r.id }, data: { seat: i + 1 } })))
    const { antes, despues } = await alrededorDe(() => splitOrderBySeat(venueId, o.id, staffId))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('dar cortesía a toda la cuenta (compWholeOrder, la del MCP comp_table_check)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const { antes, despues } = await alrededorDe(() => compWholeOrder({ venueId, orderId: o.id, reason: 'Reclamo del cliente', staffId }))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('dar cortesía a UN artículo (compOrderItem, la del POS)', async () => {
    const t = await mesa()
    const o = await cuentaEnMesa(t.id, 100)
    const [primero] = await prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { id: 'asc' }, take: 1 })
    const { antes, despues } = await alrededorDe(() =>
      compOrderItem({ venueId, orderId: o.id, itemId: primero.id, reason: 'Reclamo del cliente', staffId }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  // El dashboard da de alta y archiva mesas sólo publicando el plano (cubierto abajo); fuera del plano, las rutas reales
  // son POST y DELETE /tpv/venues/:venueId/tables (createTable y deleteTable).
  it('dar de alta una mesa fuera del plano (createTable) — y NO mueve floorPlanVersion', async () => {
    const { antes, despues } = await alrededorDe(() => createTable(venueId, { number: 'Nueva', capacity: 4, shape: 'SQUARE' }))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(despues.floorPlanVersion).toBe(antes.floorPlanVersion)
  })

  it('archivar una mesa fuera del plano (deleteTable)', async () => {
    const t = await mesa()
    const { antes, despues } = await alrededorDe(() => deleteTable(venueId, t.id))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  // Corrección C3 (hallazgo 5): el switch «sólo el dueño de la mesa» viaja en /tables (`settings`).
  it('prender o apagar «sólo el dueño de la mesa» mueve tablesVersion y NO floorPlanVersion', async () => {
    await mesa()
    // Sin fila de VenueSettings a propósito: el primer «prender» va por el camino REAL de creación (`createData`), que
    // ahora sí copia el campo (V1).
    expect(await prisma.venueSettings.findUnique({ where: { venueId } })).toBeNull()
    const prender = await alrededorDe(() => updateVenueSettings(venueId, { enforceTableOwnership: true }, staffId))
    expect(prender.despues.tablesVersion).not.toBe(prender.antes.tablesVersion)
    expect(prender.despues.floorPlanVersion).toBe(prender.antes.floorPlanVersion)
    const apagar = await alrededorDe(() => updateVenueSettings(venueId, { enforceTableOwnership: false }, staffId))
    expect(apagar.despues.tablesVersion).not.toBe(apagar.antes.tablesVersion)
  })
})

// F4 (auditoría Codex del código, hallazgo 4): los artículos que llegan de SoftRestaurant cambian lo que pinta /tables
// (renglones, cantidades) y antes no tocaban la orden padre. Se llama al procesador real, el mismo punto de entrada que usa
// el dispatcher de RabbitMQ (`posSyncService.processPosOrderItemEvent`).
describe('SoftRestaurant: un artículo importado mueve tablesVersion sin tocar el dinero de la cabecera', () => {
  const PRODUCTO_POS = 'sr-cafe'

  async function cuentaImportada() {
    const t = await mesa()
    const categoryId = (await prisma.menuCategory.findFirstOrThrow({ where: { venueId }, select: { id: true } })).id
    await prisma.product.create({
      data: { venueId, categoryId, sku: `SR-${venueId}`, name: 'Café SR', price: 50, externalId: PRODUCTO_POS },
    })
    const externalId = `SR1:1:${randomUUID()}`
    const order = await prisma.order.create({
      data: {
        venueId,
        tableId: t.id,
        externalId,
        orderNumber: randomUUID(),
        originSystem: 'POS_SOFTRESTAURANT',
        subtotal: 100,
        taxAmount: 16,
        total: 116,
        remainingBalance: 116,
        contratoDePrecio: 'IVA_APARTE',
      },
    })
    await prisma.table.update({ where: { id: t.id }, data: { status: 'OCCUPIED', currentOrderId: order.id } })
    return { orderId: order.id, externalId }
  }
  const renglon = (parentOrderExternalId: string, externalId: string, itemData: Record<string, unknown> = {}) => ({
    venueId,
    parentOrderExternalId,
    itemData: {
      externalId,
      deleted: false,
      productExternalId: PRODUCTO_POS,
      productName: 'Café',
      quantity: 1,
      unitPrice: 50,
      taxAmount: 8,
      total: 50,
      ...itemData,
    },
  })
  /** La cabecera importada es la autoridad del dinero (IVA_APARTE): un evento de renglón nunca la recalcula. */
  const dineroDe = (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      select: { subtotal: true, taxAmount: true, total: true, remainingBalance: true, paidAmount: true, paymentStatus: true },
    })

  it('CREAR un artículo', async () => {
    const { orderId, externalId } = await cuentaImportada()
    const dinero = await dineroDe(orderId)
    const { antes, despues } = await alrededorDe(() => processPosOrderItemEvent(renglon(externalId, `${externalId}:L1`)))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(await dineroDe(orderId)).toEqual(dinero)
  })

  it('ACTUALIZAR la cantidad de un artículo', async () => {
    const { orderId, externalId } = await cuentaImportada()
    await processPosOrderItemEvent(renglon(externalId, `${externalId}:L1`))
    const dinero = await dineroDe(orderId)
    const { antes, despues } = await alrededorDe(() =>
      processPosOrderItemEvent(renglon(externalId, `${externalId}:L1`, { quantity: 3, total: 150, taxAmount: 24 })),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(await dineroDe(orderId)).toEqual(dinero)
  })

  it('BORRAR un artículo', async () => {
    const { orderId, externalId } = await cuentaImportada()
    await processPosOrderItemEvent(renglon(externalId, `${externalId}:L1`))
    const dinero = await dineroDe(orderId)
    const { antes, despues } = await alrededorDe(() => processPosOrderItemEvent(renglon(externalId, `${externalId}:L1`, { deleted: true })))
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
    expect(await dineroDe(orderId)).toEqual(dinero)
  })
})

describe('publicar un plano que mueve, quita o revive una mesa mueve tablesVersion', () => {
  async function salonConMesas(...tables: DesiredTable[]) {
    return publicar({ baseFingerprint: (await getFloorPlan(venueId)).fingerprint, areas: [salonNuevo], tables })
  }

  it('MUEVE una mesa', async () => {
    const plano = await salonConMesas(mesaDelPlano('t1', '1'))
    const { antes, despues } = await alrededorDe(() =>
      publicar({
        baseFingerprint: plano.fingerprint,
        areas: [salon(plano.areas[0].id)],
        tables: [igual(plano.tables[0], { positionX: 0.2 })],
      }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('QUITA una mesa', async () => {
    const plano = await salonConMesas(mesaDelPlano('t1', '1'), mesaDelPlano('t2', '2', { positionX: 0.2 }))
    const unaSola = plano.tables.filter(t => t.number === '1')
    const { antes, despues } = await alrededorDe(() =>
      publicar({ baseFingerprint: plano.fingerprint, areas: [salon(plano.areas[0].id)], tables: unaSola.map(t => igual(t)) }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })

  it('REVIVE una mesa archivada', async () => {
    const plano = await salonConMesas(mesaDelPlano('t1', '1'), mesaDelPlano('t5', '5', { positionX: 0.2 }))
    const sin5 = await publicar({
      baseFingerprint: plano.fingerprint,
      areas: [salon(plano.areas[0].id)],
      tables: plano.tables.filter(t => t.number !== '5').map(t => igual(t)),
    })
    const { antes, despues } = await alrededorDe(() =>
      publicar({
        baseFingerprint: sin5.fingerprint,
        areas: [salon(sin5.areas[0].id)],
        tables: [...sin5.tables.map(t => igual(t)), mesaDelPlano('t5b', '5', { areaRef: sin5.areas[0].id, positionX: 0.8 })],
      }),
    )
    expect(despues.tablesVersion).not.toBe(antes.tablesVersion)
  })
})

describe('floorPlanVersion se mueve con áreas y elementos', () => {
  it('publicar un plano que renombra el área o agrega un elemento', async () => {
    const plano = await publicar({ baseFingerprint: (await getFloorPlan(venueId)).fingerprint, areas: [salonNuevo] })
    const renombrar = await alrededorDe(() =>
      publicar({ baseFingerprint: plano.fingerprint, areas: [salon(plano.areas[0].id, { name: 'Salón principal' })] }),
    )
    expect(renombrar.despues.floorPlanVersion).not.toBe(renombrar.antes.floorPlanVersion)
    const actual = await getFloorPlan(venueId)
    const pared = await alrededorDe(() =>
      publicar({
        baseFingerprint: actual.fingerprint,
        areas: [salon(actual.areas[0].id, { name: 'Salón principal' })],
        elements: [{ type: 'WALL', areaRef: actual.areas[0].id, positionX: 0, positionY: 0, endX: 1, endY: 0, rotation: 0 }],
      }),
    )
    expect(pared.despues.floorPlanVersion).not.toBe(pared.antes.floorPlanVersion)
    expect(pared.despues.tablesVersion).toBe(pared.antes.tablesVersion)
  })

  it('la PAX crea, mueve y borra un elemento: cada paso la mueve (y no toca tablesVersion)', async () => {
    const crear = await alrededorDe(() =>
      createFloorElement(venueId, { type: 'BAR_COUNTER', positionX: 0.1, positionY: 0.1, width: 0.2, height: 0.05 }),
    )
    expect(crear.despues.floorPlanVersion).not.toBe(crear.antes.floorPlanVersion)
    expect(crear.despues.tablesVersion).toBe(crear.antes.tablesVersion)
    const [barra] = await prisma.floorElement.findMany({ where: { venueId }, take: 1 })
    const mover = await alrededorDe(() => updateFloorElement(venueId, barra.id, { positionX: 0.3 }))
    expect(mover.despues.floorPlanVersion).not.toBe(mover.antes.floorPlanVersion)
    const borrar = await alrededorDe(() => deleteFloorElement(venueId, barra.id))
    expect(borrar.despues.floorPlanVersion).not.toBe(borrar.antes.floorPlanVersion)
  })
})

describe('aislamiento entre negocios', () => {
  it('lo de otro venue no mueve la versión de éste', async () => {
    const t = await mesa()
    await cuentaEnMesa(t.id)
    const antes = await readTablesVersions(venueId)
    const otro = await nuevoVenue()
    await pausa()
    const ajena = await prisma.table.create({ data: { venueId: otro, number: '1', capacity: 4, qrCode: randomUUID() } })
    await prisma.order.create({
      data: {
        venueId: otro,
        tableId: ajena.id,
        orderNumber: randomUUID(),
        subtotal: 10,
        taxAmount: 0,
        total: 10,
        remainingBalance: 10,
        contratoDePrecio: 'IVA_INCLUIDO',
      },
    })
    await prisma.area.create({ data: { venueId: otro, name: 'Terraza' } })
    await createFloorElement(otro, { type: 'WALL', positionX: 0, positionY: 0, endX: 1, endY: 0 })
    expect(await readTablesVersions(venueId)).toEqual(antes)
  })
})

describe('costo con 500 mesas (spec §3.1: medir con EXPLAIN)', () => {
  // Corrección C4 (hallazgo 9): un negocio real acumula MUCHO historial cerrado y pocas cuentas vivas. La versión no
  // puede crecer con el historial: se siembran 20,000 cuentas cerradas con mesa y 5,000 sin mesa, y el EXPLAIN no puede
  // recorrer "Order" entera.
  it('una sola consulta, sin recorrer el historial de cuentas; el plan queda en la salida para la evidencia', async () => {
    await prisma.table.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({ venueId, number: `E${i + 1}`, capacity: 4, qrCode: randomUUID() })),
    })
    const mesas = await prisma.table.findMany({ where: { venueId }, select: { id: true }, orderBy: { number: 'asc' }, take: 150 })
    await prisma.order.createMany({
      data: mesas.map(m => ({
        venueId,
        tableId: m.id,
        orderNumber: randomUUID(),
        subtotal: 100,
        taxAmount: 0,
        total: 100,
        remainingBalance: 100,
        contratoDePrecio: 'IVA_INCLUIDO' as const,
      })),
    })
    await prisma.floorElement.createMany({
      data: Array.from({ length: 1500 }, () => ({ venueId, type: 'WALL' as const, positionX: 0, positionY: 0, endX: 1, endY: 0 })),
    })
    // Historial: 20,000 cuentas CERRADAS con mesa (en lotes) y 5,000 sin mesa (mostrador).
    for (let lote = 0; lote < 20; lote++) {
      await prisma.order.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({
          venueId,
          tableId: mesas[(lote * 1000 + i) % mesas.length].id,
          orderNumber: randomUUID(),
          status: 'COMPLETED' as const,
          paymentStatus: 'PAID' as const,
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          remainingBalance: 0,
          contratoDePrecio: 'IVA_INCLUIDO' as const,
        })),
      })
    }
    for (let lote = 0; lote < 5; lote++) {
      await prisma.order.createMany({
        data: Array.from({ length: 1000 }, () => ({
          venueId,
          orderNumber: randomUUID(),
          subtotal: 100,
          taxAmount: 0,
          total: 100,
          remainingBalance: 100,
          contratoDePrecio: 'IVA_INCLUIDO' as const,
        })),
      })
    }
    await prisma.$executeRawUnsafe('ANALYZE "Order"')
    await prisma.$executeRawUnsafe('ANALYZE "Table"')
    const spy = jest.spyOn(prisma, '$queryRaw')
    const inicio = Date.now()
    const v = await readTablesVersions(venueId)
    const ms = Date.now() - inicio
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
    expect(v.tablesVersion).toMatch(/^[0-9a-f]{16}$/)
    const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${tablesVersionSql(venueId)}`,
    )
    const texto = plan.map(r => r['QUERY PLAN']).join('\n')

    console.log(`[plano-pos] readTablesVersions con 500 mesas, 150 cuentas vivas, 25,000 de historial y 1500 elementos: ${ms} ms\n` + texto)
    expect(texto).toContain('Aggregate')
    // Las cuentas vivas se leen por índice; nunca se barre "Order" entera (crecería con el historial).
    expect(texto).not.toMatch(/Seq Scan on "Order"/)
  })
})
