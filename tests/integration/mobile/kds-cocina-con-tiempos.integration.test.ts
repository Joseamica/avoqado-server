/**
 * D17 (founder, 20-nov-2026; Flautas) contra Postgres real: la comanda con tiempos sale del tablero cuando la cocina termina y
 * regresa con «Deshacer»; lo de un día del negocio terminado con la cuenta cerrada se archiva (sólo `archivedAt`), nunca lo de
 * una cuenta abierta ni el platillo que dividir la mesa movió a otra cuenta. Promesa: docs/audit/2026-11-20-cocina-con-tiempos/.
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { applyKitchenPreparation, listKitchenPreparation } from '@/services/kds/kitchenPreparation.service'
import { initialPreparation } from '@/services/kds/kitchenPreparation'
import { countKdsOrders, listKdsOrders, listRecentKdsOrders, recallKdsOrder } from '@/services/mobile/kds.mobile.service'
import { archivarComandas, comandasPorArchivar } from '@/services/kds/kdsArchive.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

const SUF = `cocinatiempos-${Date.now()}`
let orgId: string
let venueId: string
let staffId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `D17 ${SUF}`, email: `${SUF}@example.test`, phone: '5500000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `D17 ${SUF}`, slug: `d17-${SUF}`, status: 'ACTIVE', timezone: 'America/Mexico_City' },
    })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `${SUF}@example.test`, firstName: 'D17', lastName: 'Cocina' } })).id
  const feature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Pro', category: 'OPERATIONS', monthlyPrice: 0 },
  })
  await prisma.venueFeature.create({ data: { venueId, featureId: feature.id, monthlyPrice: 0 } })
})

afterAll(async () => {
  if (!orgId) return
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.kdsOrder.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.venueFeature.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

async function cuenta(status: 'PENDING' | 'COMPLETED') {
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: randomUUID(),
      status,
      paymentStatus: status === 'COMPLETED' ? 'PAID' : 'PENDING',
      subtotal: 99,
      taxAmount: 0,
      total: 99,
      contratoDePrecio: 'IVA_INCLUIDO',
    },
  })
}

/** Una comanda con tiempos: Primer tiempo (inmediato, PENDING) y Segundo (retenido, HELD). */
async function comanda(orderId: string, opts: { createdAt?: Date; orderItemId?: string; soloInmediato?: boolean } = {}) {
  return prisma.kdsOrder.create({
    data: {
      venueId,
      orderId,
      orderNumber: 'Mesa 4',
      sourceKey: `round:${randomUUID()}:none`,
      preparationVersion: 1,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      items: {
        create: [
          {
            productName: 'Flautas',
            quantity: 1,
            orderItemId: opts.orderItemId ?? randomUUID(),
            externalLineId: randomUUID(),
            preparation: initialPreparation(1, 'IMMEDIATE'),
          },
          ...(opts.soloInmediato
            ? []
            : [
                {
                  productName: 'Pozole',
                  quantity: 1,
                  orderItemId: randomUUID(),
                  externalLineId: randomUUID(),
                  preparation: initialPreparation(1, 'STANDARD'),
                },
              ]),
        ],
      },
    },
    include: { items: { orderBy: { productName: 'asc' } } },
  })
}

async function accion(orderId: string, itemId: string, action: string) {
  const row = await prisma.kdsOrderItem.findUniqueOrThrow({ where: { id: itemId } })
  return applyKitchenPreparation(
    venueId,
    orderId,
    { action, items: [{ id: row.id, expectedRevision: row.preparationRevision, quantity: 1 }] },
    staffId,
  )
}

const enTablero = async (id: string) => (await listKdsOrders(venueId)).some(o => o.id === id)

describe('D17 · sale del tablero cuando la cocina termina', () => {
  it('con un tiempo retenido se queda; con todo listo sale, la caja la sigue viendo y «Deshacer» la regresa', async () => {
    const order = await cuenta('PENDING')
    const k = await comanda(order.id)
    const [flautas, pozole] = k.items
    await accion(order.id, flautas.id, 'START')
    await accion(order.id, flautas.id, 'READY')
    expect(await enTablero(k.id)).toBe(true) // el Segundo tiempo sigue retenido

    await accion(order.id, pozole.id, 'RELEASE')
    await accion(order.id, pozole.id, 'START')
    await accion(order.id, pozole.id, 'READY')
    expect(await enTablero(k.id)).toBe(false)
    expect(await countKdsOrders(venueId)).toBe((await listKdsOrders(venueId)).length)
    const guardada = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: k.id } })
    expect(guardada.status).toBe('READY') // la caja la sigue viendo en «En servicio»
    expect(guardada.kitchenDoneAt).toBeInstanceOf(Date)
    expect((await listKitchenPreparation(venueId)).items.map(i => i.id)).toEqual(expect.arrayContaining([flautas.id, pozole.id]))

    const recientes = await listRecentKdsOrders(venueId, undefined, true)
    expect((await listRecentKdsOrders(venueId)).some(r => r.id === k.id)).toBe(false) // la tablet vieja no la recibe
    const reciente = recientes.find(r => r.id === k.id)
    expect(reciente?.completedAt).toBe(guardada.kitchenDoneAt!.toISOString())

    await expect(recallKdsOrder(venueId, k.id, staffId, '2020-01-01T00:00:00.000Z')).rejects.toMatchObject({ code: 'KDS_RECALL_STALE' })
    await recallKdsOrder(venueId, k.id, staffId, reciente!.completedAt)
    expect(await enTablero(k.id)).toBe(true)
    const regresada = await prisma.kdsOrderItem.findMany({ where: { kdsOrderId: k.id }, orderBy: { productName: 'asc' }, take: 5 })
    expect(regresada.map(r => (r.preparation as any).PREPARING)).toEqual([1, 1])
    expect(await prisma.kdsOrder.findUniqueOrThrow({ where: { id: k.id } })).toMatchObject({ status: 'PREPARING', kitchenDoneAt: null })
    expect(await prisma.activityLog.count({ where: { venueId, action: 'KITCHEN_RECALL', entityId: order.id } })).toBe(1)
  })
})

describe('D17 · archivado al cerrar el día del negocio', () => {
  // Ayer a las 20:00 en CDMX y hoy a las 05:05 (ya pasó el corte de las 04:00 y la hora de «Recientes» de lo de las 03:59).
  const ahora = new Date('2026-11-21T11:05:00Z')
  const ayer = new Date('2026-11-21T02:00:00Z')

  it('archiva sólo lo de cuenta cerrada, ni la cuenta abierta ni el platillo que dividir movió a una abierta, y no cambia el estado', async () => {
    const cerrada = await cuenta('COMPLETED')
    const abierta = await cuenta('PENDING')
    const kCerrada = await comanda(cerrada.id, { createdAt: ayer })
    const kAbierta = await comanda(abierta.id, { createdAt: ayer })
    // Dividir la mesa: el renglón ya es de la cuenta B (abierta) y la comanda sigue ligada a A (cerrada).
    const otraAbierta = await cuenta('PENDING')
    const movido = await prisma.orderItem.create({
      data: { orderId: otraAbierta.id, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50, productName: 'Flautas' } as any,
    })
    const kDividida = await comanda(cerrada.id, { createdAt: ayer, orderItemId: movido.id, soloInmediato: true })
    const hoy = await comanda(cerrada.id, { createdAt: new Date('2026-11-21T10:20:00Z') })
    // Codex r2 #1: la de las 03:59 es del día de la víspera y se archiva en la primera pasada después del corte, no 4 h después.
    const madrugada = await comanda(cerrada.id, { createdAt: new Date('2026-11-21T09:59:00Z') })
    // Codex r4 A1: dividir movió TODOS los platillos a la cuenta B (cerrada) y la cabecera sigue en A (abierta): se archiva.
    const cobradaB = await cuenta('COMPLETED')
    const deB = await prisma.orderItem.create({
      data: { orderId: cobradaB.id, quantity: 1, unitPrice: 50, taxAmount: 0, total: 50, productName: 'Flautas' } as any,
    })
    const kPartida = await comanda(abierta.id, { createdAt: ayer, orderItemId: deB.id, soloInmediato: true })

    // Sin tocarlas desde que se crearon (el día que cuenta es el de su último cambio).
    await prisma.$executeRaw`UPDATE "KdsOrder" SET "updatedAt" = "createdAt" WHERE "venueId" = ${venueId} AND "createdAt" < '2026-11-22'`
    const candidatas = (await comandasPorArchivar(prisma, ahora)).filter(c => c.venueId === venueId).map(c => c.id)
    expect(candidatas.sort()).toEqual([kCerrada.id, kPartida.id, madrugada.id].sort())
    // 04:30: la de las 03:59 todavía conserva su hora (la de ayer sí sale)
    expect((await comandasPorArchivar(prisma, new Date('2026-11-21T10:30:00Z'))).map(c => c.id)).not.toContain(madrugada.id)
    await expect(comandasPorArchivar(prisma, new Date('2026-11-21T09:30:00Z'))).resolves.not.toContainEqual(
      expect.objectContaining({ id: kCerrada.id }), // 03:30: todavía es el mismo día del negocio
    )

    const archivadas = await prisma.$transaction(tx =>
      archivarComandas(tx, [kCerrada.id, kAbierta.id, kDividida.id, hoy.id, madrugada.id, kPartida.id], ahora),
    )
    expect(archivadas.map(a => a.id).sort()).toEqual([kCerrada.id, kPartida.id, madrugada.id].sort())
    const guardada = await prisma.kdsOrder.findUniqueOrThrow({ where: { id: kCerrada.id } })
    expect(guardada).toMatchObject({ status: 'NEW', completedAt: null })
    expect(guardada.archivedAt).toEqual(ahora)
    expect(await enTablero(kCerrada.id)).toBe(false)
    expect(await enTablero(kAbierta.id)).toBe(true)
    expect(await enTablero(kDividida.id)).toBe(true)
    expect(await prisma.activityLog.count({ where: { venueId, action: 'KDS_ORDERS_ARCHIVED' } })).toBe(1)

    // Repetirlo no hace nada ni deja otra fila.
    await expect(prisma.$transaction(tx => archivarComandas(tx, [kCerrada.id], ahora))).resolves.toEqual([])
    expect(await prisma.activityLog.count({ where: { venueId, action: 'KDS_ORDERS_ARCHIVED' } })).toBe(1)
  })
})
