/**
 * D29 (hz:0555ee15:D29, Flautas, 21-nov-2026) — dos cajas en la misma mesa: el reenvío de una ronda no revive un producto que la
 * otra caja movió a otra cuenta y anuló ahí. Postgres REAL, con los servicios de verdad.
 *
 * El caso: la caja 1 manda una ronda a la cuenta A y se pierde la respuesta. La caja 2 separa un producto de esa ronda a la cuenta B
 * y lo ANULA allí. Al volver la red, la caja 1 reenvía la ronda (por la cola) a A. La anulación quedó registrada en B (la «lápida»:
 * `OrderAction` VOID con `metadata.externalIds`) y el reenvío sólo la buscaba en A: creaba otro renglón del producto, lo sumaba al
 * saldo de A y lo mandaba otra vez a cocina.
 *
 * Decisión (FLAUTAS_C con la delegación del founder): para llaves de ronda (`sync:<ronda>:<n>`, únicas por construcción) la lápida
 * se busca en TODO el negocio, como ya lo hace `rondaYaEnAlgunaCuenta`. Mostrador, `/fast` y las llaves UUID quedan como estaban.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { payCashOrder, splitOrderItems } from '@/services/mobile/order.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'
import {
  addItemsToOrder,
  consultaDeLapidasDelNegocio,
  consultaDeLlavesEnOtraCuenta,
  llavesAnuladasEnElNegocio,
  voidItems,
} from '@/services/tpv/order.tpv.service'
import { voidOrderItem } from '@/services/mobile/void-item.mobile.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d29-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string
let caja: string
let coca: string
let agua: string
let pan: string
const aparatoMesera = `samsung-${fixture}`
let seq = 0

const replay = (intents: any[]) =>
  processIntents({ venueId, staffId: mesera, deviceId: aparatoMesera, intents, authorizeIntent: () => true })

/** El reenvío por la cola de la ronda `r` (mismo id que su envío con red, como hacen las apps). */
const reenvio = (r: string, orderId: string, items: { productId: string; n: number }[]) => ({
  id: r,
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { orderId, items: items.map(({ productId, n }) => ({ productId, quantity: 1, externalId: `sync:${r}:${n}` })) },
  createdAtLocal: Date.now() - 60_000,
})

const versionDe = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version
const renglon = (orderId: string, externalId: string) => prisma.orderItem.findFirstOrThrow({ where: { orderId, externalId } })
const fotoDe = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true, remainingBalance: true, status: true } })
  return {
    status: o.status,
    total: Number(o.total),
    porCobrar: Number(o.remainingBalance),
    renglones: await prisma.orderItem.count({ where: { orderId } }),
  }
}

/**
 * La mesa con internet: ronda P (coca y pan), confirmada. Luego la caja 1 manda la ronda R (agua) y su respuesta se pierde (el
 * SERVIDOR sí la guardó). La caja 2 separa el pan y el agua a una cuenta nueva B. A queda con la coca.
 */
async function rondaSeparadaPorLaOtraCaja(): Promise<{ t: string; a: string; b: string; r: string; aguaId: string }> {
  const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
  const a = (await assignTable(venueId, t, mesera, 2)).order.id
  const p = randomUUID()
  await addItemsToOrder(
    venueId,
    a,
    [
      { productId: coca, quantity: 1, externalId: `sync:${p}:0` },
      { productId: pan, quantity: 1, externalId: `sync:${p}:1` },
    ] as any,
    await versionDe(a),
    true,
  )
  const r = randomUUID()
  await addItemsToOrder(venueId, a, [{ productId: agua, quantity: 1, externalId: `sync:${r}:0` }] as any, await versionDe(a), true)
  const aguaId = (await renglon(a, `sync:${r}:0`)).id
  const panId = (await renglon(a, `sync:${p}:1`)).id
  const b = (await splitOrderItems(venueId, a, [panId, aguaId], caja)).created.id
  expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
  expect(await fotoDe(b)).toMatchObject({ total: 30, renglones: 2 })
  return { t, a, b, r, aguaId }
}

/**
 * El plan de una consulta con el recorrido completo de tablas apagado. En esta base de prueba las tablas son chicas y recorrerlas
 * enteras ES más barato (el planificador lo elige así, con razón); en producción no. Lo que se comprueba aquí es que el índice SE
 * PUEDE usar con la forma exacta de la consulta (predicado literal, misma expresión, llave correlacionada, barrera `OFFSET 0`). El
 * plan real con los volúmenes de producción se mira en el canario tras desplegar.
 */
const planSinRecorrerTablas = (consulta: Prisma.Sql) =>
  prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
    const filas = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${consulta}`)
    return filas
  })

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  venueId = (
    await prisma.venue.create({ data: { organizationId: org.id, name: fixture, slug: fixture, type: 'RESTAURANT', status: 'TRIAL' } })
  ).id
  await prisma.venueSettings.create({ data: { venueId, enableShifts: false, requirePinLogin: false } })
  mesera = (await prisma.staff.create({ data: { email: `m-${fixture}@staff.test`, firstName: 'Mesera', lastName: 'Uno', active: true } }))
    .id
  caja = (await prisma.staff.create({ data: { email: `c-${fixture}@staff.test`, firstName: 'Caja', lastName: 'Dos', active: true } })).id
  await prisma.staffVenue.createMany({
    data: [
      { venueId, staffId: mesera, role: 'WAITER' },
      { venueId, staffId: caja, role: 'OWNER' },
    ],
  })
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${fixture}` } })
  coca = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Coca', sku: `C-${fixture}`, price: 25 } })).id
  agua = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Agua', sku: `A-${fixture}`, price: 20 } })).id
  pan = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Pan', sku: `P-${fixture}`, price: 10 } })).id
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D29 · la lápida de una llave de ronda vale en todo el negocio', () => {
  it('el caso: la otra caja separó el agua a B y la anuló ahí; el reenvío de la ronda a A NO la vuelve a crear ni a cobrar', async () => {
    const { a, b, r, aguaId } = await rondaSeparadaPorLaOtraCaja()
    await voidOrderItem({ venueId, orderId: b, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })
    expect(await fotoDe(b)).toMatchObject({ total: 10, renglones: 1 })

    const [ack] = await replay([reenvio(r, a, [{ productId: agua, n: 0 }])])

    expect(ack.status).toBe('ACKED')
    // La MISMA respuesta que cuando la lápida está en A: la cuenta que el aparato conoce, su versión y su total; nada más.
    expect(Object.keys(ack.result as object).sort()).toEqual(['orderId', 'total', 'version'])
    expect(ack.result).toMatchObject({ orderId: a, total: 25, version: await versionDe(a) })
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r}:0`, order: { venueId } } })).toBe(0)
    expect(await fotoDe(a)).toMatchObject({ total: 25, porCobrar: 25, renglones: 1 })
    expect(await fotoDe(b)).toMatchObject({ total: 10, renglones: 1 })
  })

  it('la ronda llega con red otra vez (la ruta de mesas, `asNewRound`): tampoco revive el agua anulada en B', async () => {
    const { a, b, r, aguaId } = await rondaSeparadaPorLaOtraCaja()
    await voidOrderItem({ venueId, orderId: b, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })

    await addItemsToOrder(venueId, a, [{ productId: agua, quantity: 1, externalId: `sync:${r}:0` }] as any, await versionDe(a), true)

    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r}:0`, order: { venueId } } })).toBe(0)
    expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
  })

  it('la caja 2 cobró A después: la ronda tardía NO abre una cuenta aparte para el agua anulada en B (ni una vacía)', async () => {
    const { t, a, b, r, aguaId } = await rondaSeparadaPorLaOtraCaja()
    await voidOrderItem({ venueId, orderId: b, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })
    await payCashOrder(venueId, a, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${a}` })
    const cuentasAntes = await prisma.order.count({ where: { venueId, tableId: t } })

    const [ack] = await replay([reenvio(r, a, [{ productId: agua, n: 0 }])])

    expect(ack.status).toBe('ACKED')
    expect((ack.result as any).cuentaAparte).toBeUndefined()
    expect(ack.result).toMatchObject({ orderId: a })
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(cuentasAntes)
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r}:0`, order: { venueId } } })).toBe(0)
  })

  it('vecina: la otra caja SÓLO separó el agua a B (sin anular): el reenvío a A no la duplica', async () => {
    const { a, b, r } = await rondaSeparadaPorLaOtraCaja()

    const [ack] = await replay([reenvio(r, a, [{ productId: agua, n: 0 }])])

    expect(ack.status).toBe('ACKED')
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r}:0`, order: { venueId } } })).toBe(1)
    expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
    expect(await fotoDe(b)).toMatchObject({ total: 30, renglones: 2 })
  })

  it('vecina: anulada en la MISMA cuenta A (como hoy), el reenvío no la revive', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    await addItemsToOrder(venueId, a, [{ productId: coca, quantity: 1 }] as any, await versionDe(a), true)
    const r = randomUUID()
    await addItemsToOrder(venueId, a, [{ productId: agua, quantity: 1, externalId: `sync:${r}:0` }] as any, await versionDe(a), true)
    const aguaId = (await renglon(a, `sync:${r}:0`)).id
    await voidOrderItem({ venueId, orderId: a, itemId: aguaId, reason: 'El cliente cambió de parecer', actorId: caja })

    const [ack] = await replay([reenvio(r, a, [{ productId: agua, n: 0 }])])

    expect(ack.status).toBe('ACKED')
    expect(Object.keys(ack.result as object).sort()).toEqual(['orderId', 'total', 'version'])
    expect(await prisma.orderItem.count({ where: { externalId: `sync:${r}:0` } })).toBe(0)
    expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
  })

  it('vecina: una llave que NO es de ronda (UUID de Mostrador) anulada en otra cuenta no frena a la cuenta nueva (como hoy)', async () => {
    const llave = randomUUID()
    const crear = async () => {
      const o = await prisma.order.create({
        data: { venueId, orderNumber: `M-${randomUUID().slice(0, 8)}`, servedById: caja, total: 0, subtotal: 0, taxAmount: 0 },
      })
      await addItemsToOrder(
        venueId,
        o.id,
        [
          { productId: coca, quantity: 1 },
          { productId: agua, quantity: 1, externalId: llave },
        ] as any,
        await versionDe(o.id),
      )
      return o.id
    }
    const x = await crear()
    // Cobro dividido de Mostrador: la misma llave en otra cuenta, anulada en la primera (la anulación de la TPV).
    await voidItems(venueId, x, {
      itemIds: [(await renglon(x, llave)).id],
      reason: 'Error',
      staffId: caja,
      expectedVersion: await versionDe(x),
    })
    expect(await prisma.orderItem.count({ where: { orderId: x, externalId: llave } })).toBe(0)

    const y = await crear()

    expect(await prisma.orderItem.count({ where: { orderId: y, externalId: llave } })).toBe(1)
    expect(await fotoDe(y)).toMatchObject({ total: 45, renglones: 2 })
  })

  it('capacidad (Codex r2 #1): una ronda de 300 renglones contra una anulación de 300 llaves se cruza exacta y rápido, sólo en su negocio', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    const ronda = randomUUID()
    const anuladas = Array.from({ length: 300 }, (_, i) => `sync:${ronda}:${i}`)
    const vivas = Array.from({ length: 300 }, (_, i) => `sync:${ronda}:${300 + i}`)
    await prisma.orderAction.create({
      data: { orderId: a, actionType: 'VOID', performedById: caja, metadata: { externalIds: [...anuladas, `sync:${randomUUID()}:0`] } },
    })
    // La misma llave anulada en OTRO negocio no cuenta aquí.
    const otraOrg = await prisma.organization.create({ data: { name: `${fixture}-b`, email: `${fixture}-b@example.test`, phone: '' } })
    const otroNegocio = await prisma.venue.create({
      data: { organizationId: otraOrg.id, name: `${fixture}-b`, slug: `${fixture}-b`, type: 'RESTAURANT', status: 'TRIAL' },
    })
    const ajena = await prisma.order.create({
      data: { venueId: otroNegocio.id, orderNumber: `B-${randomUUID().slice(0, 8)}`, total: 0, subtotal: 0, taxAmount: 0 },
    })
    await prisma.orderAction.create({
      data: { orderId: ajena.id, actionType: 'VOID', performedById: caja, metadata: { externalIds: vivas.slice(0, 5) } },
    })

    const inicio = Date.now()
    const encontradas = await llavesAnuladasEnElNegocio(prisma, venueId, [...anuladas, ...vivas])
    const ms = Date.now() - inicio

    expect([...encontradas].sort()).toEqual([...anuladas].sort())
    expect(ms).toBeLessThan(3000)
  })

  it('capacidad: con miles de anulaciones de otras llaves, la búsqueda de lápidas entra por el índice GIN parcial', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    await prisma.orderAction.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        orderId: a,
        actionType: 'VOID' as const,
        performedById: caja,
        metadata: { externalIds: [`sync:${randomUUID()}:${i % 4}`] },
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "OrderAction"')
    // La migración CONCURRENTLY dejó el índice construido y válido.
    const [indice] = await prisma.$queryRaw<{ valido: boolean; definicion: string }[]>`
      SELECT i.indisvalid AS valido, pg_get_indexdef(i.indexrelid) AS definicion
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'OrderAction_void_externalIds_idx'`
    expect(indice).toMatchObject({ valido: true })
    // La consulta EXACTA de `llavesAnuladasEnElNegocio` (Codex r1 #3): entra por el índice parcial con las llaves pedidas.
    const plan = await planSinRecorrerTablas(consultaDeLapidasDelNegocio(venueId, [`sync:${randomUUID()}:0`, `sync:${randomUUID()}:1`]))
    expect(plan.map(fila => fila['QUERY PLAN']).join('\n')).toContain('OrderAction_void_externalIds_idx')
  })

  it('capacidad: con miles de renglones con llave, la búsqueda de llaves en otra cuenta entra por el índice de la llave', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    await prisma.orderItem.createMany({
      data: Array.from({ length: 3000 }, (_, i) => ({
        orderId: a,
        productId: coca,
        productName: 'Coca',
        quantity: 1,
        unitPrice: 25,
        total: 25,
        taxAmount: 0,
        externalId: `sync:${randomUUID()}:${i % 4}`,
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "OrderItem"')
    const plan = await planSinRecorrerTablas(consultaDeLlavesEnOtraCuenta(venueId, a, [`sync:${randomUUID()}:0`, `sync:${randomUUID()}:1`]))
    expect(plan.map(fila => fila['QUERY PLAN']).join('\n')).toContain('OrderItem_externalId_idx')
  })
})
