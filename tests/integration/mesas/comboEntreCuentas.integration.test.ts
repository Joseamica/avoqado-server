/**
 * D34 (hz:0555ee15:D34, Flautas, 21-nov-2026) — dos cajas en la misma mesa: el reenvío de una ronda no vuelve a crear un COMBO que la
 * otra caja separó a otra cuenta. Postgres REAL, con los servicios de verdad.
 *
 * El caso: la caja 1 manda una ronda con un combo a la cuenta A y se pierde la respuesta. La caja 2 separa ese combo a la cuenta B
 * (separar mueve la instancia `OrderPromotion` con sus renglones). Al volver la red, la caja 1 reenvía la ronda a A. Los combos se
 * reconocían sólo dentro de la cuenta (`OrderPromotion` es único por `orderId, instanceId`): el combo se creaba otra vez en A, se
 * cobraba dos veces y volvía a cocina.
 *
 * Arreglo (misma regla que D29 para los productos sueltos): en una ronda, la instancia de un combo que ya vive en OTRA cuenta del
 * negocio no se vuelve a aplicar.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { processIntents } from '@/services/mobile/sync.mobile.service'
import { mergeOrders, payCashOrder, splitOrderItems } from '@/services/mobile/order.mobile.service'
import { assignTable } from '@/services/tpv/table.tpv.service'
import { addItemsToOrder, consultaDeInstanciasEnOtraCuenta } from '@/services/tpv/order.tpv.service'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.setTimeout(60_000)

const fixture = `d34-${randomUUID().slice(0, 8)}`
let venueId: string
let mesera: string
let caja: string
let coca: string
let promotionId: string
let selections: Array<{ groupId: string; optionId: string }>
const aparatoMesera = `samsung-${fixture}`
let seq = 0

const replay = (intents: any[]) =>
  processIntents({ venueId, staffId: mesera, deviceId: aparatoMesera, intents, authorizeIntent: () => true })

/** El renglón de combo de la ronda `r` con su instancia, tal como lo mandan las apps. */
const lineaDeCombo = (r: string, instancia: string) => ({
  promotionRef: { promotionId, promotionInstanceId: instancia, selections },
  externalId: `sync:${r}:0`,
})

/** El reenvío por la cola de la ronda `r` (mismo id que su envío con red, como hacen las apps). */
const reenvio = (r: string, orderId: string, instancia: string) => ({
  id: r,
  seq: ++seq,
  type: 'ADD_ITEMS' as const,
  payload: { orderId, items: [lineaDeCombo(r, instancia)] },
  createdAtLocal: Date.now() - 60_000,
})

const versionDe = async (orderId: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })).version
const fotoDe = async (orderId: string) => {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true, remainingBalance: true, status: true } })
  return {
    status: o.status,
    total: Number(o.total),
    porCobrar: Number(o.remainingBalance),
    renglones: await prisma.orderItem.count({ where: { orderId } }),
  }
}
/** Cuántas veces existe el combo en TODO el negocio (instancias y piezas). */
const combosEnElNegocio = async (instancia: string) => ({
  instancias: await prisma.orderPromotion.count({ where: { instanceId: instancia, order: { venueId } } }),
  piezas: await prisma.orderItem.count({ where: { orderPromotion: { instanceId: instancia }, order: { venueId } } }),
})

/**
 * La mesa con internet: ronda P (coca, $25), confirmada. Luego la caja 1 manda la ronda R con un combo ($90, dos piezas) y su
 * respuesta se pierde (el SERVIDOR sí la guardó). La caja 2 separa el combo a una cuenta nueva B. A queda con la coca.
 */
async function comboSeparadoPorLaOtraCaja(): Promise<{ t: string; a: string; b: string; r: string; instancia: string }> {
  const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
  const a = (await assignTable(venueId, t, mesera, 2)).order.id
  const p = randomUUID()
  await addItemsToOrder(venueId, a, [{ productId: coca, quantity: 1, externalId: `sync:${p}:0` }] as any, await versionDe(a), true)
  const r = randomUUID()
  const instancia = randomUUID()
  await addItemsToOrder(venueId, a, [lineaDeCombo(r, instancia)] as any, await versionDe(a), true)
  expect(await fotoDe(a)).toMatchObject({ total: 115, renglones: 3 })
  const piezas = await prisma.orderItem.findMany({ where: { orderId: a, orderPromotionId: { not: null } }, select: { id: true } })
  const b = (
    await splitOrderItems(
      venueId,
      a,
      piezas.map(p => p.id),
      caja,
    )
  ).created.id
  expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
  expect(await fotoDe(b)).toMatchObject({ total: 90, renglones: 2 })
  expect(await prisma.orderPromotion.findFirstOrThrow({ where: { instanceId: instancia } })).toMatchObject({ orderId: b })
  return { t, a, b, r, instancia }
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: fixture, email: `${fixture}@example.test`, phone: '' } })
  // TRIAL = negocio de prueba: sin candados de plan (mesas y combos).
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
  const cat = await prisma.menuCategory.create({ data: { venueId, name: 'Cocina', slug: `cocina-${fixture}` } })
  coca = (await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Coca', sku: `C-${fixture}`, price: 25 } })).id
  const plato = await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Plato', sku: `P-${fixture}`, price: 100 } })
  const bebida = await prisma.product.create({ data: { venueId, categoryId: cat.id, name: 'Bebida', sku: `B-${fixture}`, price: 50 } })
  const combo = await prisma.promotion.create({
    data: {
      venueId,
      name: 'Combo comida',
      type: 'BUNDLE',
      pricingMode: 'FIXED_TOTAL',
      priceCents: 9000,
      status: 'PUBLISHED',
      daysOfWeek: [],
      groups: {
        create: [
          { name: 'Plato', displayOrder: 0, options: { create: [{ productId: plato.id }] } },
          { name: 'Bebida', displayOrder: 1, options: { create: [{ productId: bebida.id }] } },
        ],
      },
    },
    include: { groups: { include: { options: true }, orderBy: { displayOrder: 'asc' } } },
  })
  promotionId = combo.id
  selections = combo.groups.map(g => ({ groupId: g.id, optionId: g.options[0].id }))
})
afterAll(async () => {
  await prisma.$disconnect()
}) // Se conservan las filas únicas de esta corrida como evidencia.

describe('D34 · un combo que otra caja separó no se vuelve a crear con el reenvío de la ronda', () => {
  it('el caso: la otra caja separó el combo a B; el reenvío de la ronda a A por la cola NO lo vuelve a crear ni a cobrar', async () => {
    const { a, b, r, instancia } = await comboSeparadoPorLaOtraCaja()

    const [ack] = await replay([reenvio(r, a, instancia)])

    expect(ack.status).toBe('ACKED')
    // La misma forma de respuesta de hoy: la cuenta que el aparato conoce, su versión y su total; nada más.
    expect(Object.keys(ack.result as object).sort()).toEqual(['orderId', 'total', 'version'])
    expect(ack.result).toMatchObject({ orderId: a, total: 25, version: await versionDe(a) })
    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(a)).toMatchObject({ total: 25, porCobrar: 25, renglones: 1 })
    expect(await fotoDe(b)).toMatchObject({ total: 90, renglones: 2 })
  })

  it('la ronda llega con red otra vez (la ruta de mesas, `asNewRound`): tampoco vuelve a crear el combo en A', async () => {
    const { a, b, r, instancia } = await comboSeparadoPorLaOtraCaja()

    await addItemsToOrder(venueId, a, [lineaDeCombo(r, instancia)] as any, await versionDe(a), true)

    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(a)).toMatchObject({ total: 25, renglones: 1 })
    expect(await fotoDe(b)).toMatchObject({ total: 90, renglones: 2 })
  })

  it('separado a B y B juntada de vuelta en A (las piezas regresan, la instancia se queda en B cancelada): el reenvío no lo duplica', async () => {
    const { a, b, r, instancia } = await comboSeparadoPorLaOtraCaja()
    await mergeOrders(venueId, a, b, caja)
    expect(await fotoDe(a)).toMatchObject({ total: 115, renglones: 3 })

    const [ack] = await replay([reenvio(r, a, instancia)])

    expect(ack.status).toBe('ACKED')
    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(a)).toMatchObject({ total: 115, porCobrar: 115, renglones: 3 })
  })

  it('Codex r1 #1: A quedó CERRADA sin cobrar (cierre viejo del panel); el reenvío se rechaza como antes y NO reabre A', async () => {
    const { a, b, r, instancia } = await comboSeparadoPorLaOtraCaja()
    await prisma.order.update({ where: { id: a }, data: { status: 'COMPLETED', completedAt: new Date() } })
    const versionAntes = await versionDe(a)

    const [ack] = await replay([reenvio(r, a, instancia)])

    expect(ack).toMatchObject({ status: 'REJECTED', message: 'Esa cuenta ya está cerrada.' })
    expect(await fotoDe(a)).toMatchObject({ status: 'COMPLETED', total: 25, renglones: 1 })
    expect(await versionDe(a)).toBe(versionAntes)
    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(b)).toMatchObject({ total: 90, renglones: 2 })
  })

  it('regresión (D7): la caja 2 cobró A después; la ronda tardía reconoce el combo en B y no abre otra cuenta', async () => {
    const { t, a, r, instancia } = await comboSeparadoPorLaOtraCaja()
    await payCashOrder(venueId, a, { amount: 2500, tip: 0, staffId: caja, idempotencyKey: `caja-${a}` })
    const cuentasAntes = await prisma.order.count({ where: { venueId, tableId: t } })

    const [ack] = await replay([reenvio(r, a, instancia)])

    expect(ack.status).toBe('ACKED')
    expect(await prisma.order.count({ where: { venueId, tableId: t } })).toBe(cuentasAntes)
    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
  })

  it('vecina: el combo sigue en A (nadie lo separó); el reenvío no lo duplica (como hoy)', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    const r = randomUUID()
    const instancia = randomUUID()
    await addItemsToOrder(venueId, a, [lineaDeCombo(r, instancia)] as any, await versionDe(a), true)

    const [ack] = await replay([reenvio(r, a, instancia)])

    expect(ack.status).toBe('ACKED')
    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(a)).toMatchObject({ total: 90, renglones: 2 })
  })

  it('vecina: la misma instancia en OTRO negocio no frena el combo aquí (se crea en A)', async () => {
    const instancia = randomUUID()
    const otraOrg = await prisma.organization.create({ data: { name: `${fixture}-b`, email: `${fixture}-b@example.test`, phone: '' } })
    const otroNegocio = await prisma.venue.create({
      data: { organizationId: otraOrg.id, name: `${fixture}-b`, slug: `${fixture}-b`, type: 'RESTAURANT', status: 'TRIAL' },
    })
    const ajena = await prisma.order.create({
      data: { venueId: otroNegocio.id, orderNumber: `B-${randomUUID().slice(0, 8)}`, total: 0, subtotal: 0, taxAmount: 0 },
    })
    await prisma.orderPromotion.create({
      data: { orderId: ajena.id, promotionId, instanceId: instancia, snapshotJson: {}, grossCents: 0, discountCents: 0, netCents: 0 },
    })
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id

    await addItemsToOrder(venueId, a, [lineaDeCombo(randomUUID(), instancia)] as any, await versionDe(a), true)

    expect(await combosEnElNegocio(instancia)).toEqual({ instancias: 1, piezas: 2 })
    expect(await fotoDe(a)).toMatchObject({ total: 90, renglones: 2 })
  })

  it('capacidad: con miles de combos vendidos, la búsqueda de la instancia en otra cuenta entra por el índice de la instancia', async () => {
    const t = (await prisma.table.create({ data: { venueId, number: randomUUID().slice(0, 6), capacity: 4, qrCode: randomUUID() } })).id
    const a = (await assignTable(venueId, t, mesera, 2)).order.id
    await prisma.orderPromotion.createMany({
      data: Array.from({ length: 3000 }, () => ({
        orderId: a,
        promotionId,
        instanceId: randomUUID(),
        snapshotJson: {},
        grossCents: 0,
        discountCents: 0,
        netCents: 0,
      })),
    })
    await prisma.$executeRawUnsafe('ANALYZE "OrderPromotion"')
    // El plan con el recorrido completo de tablas apagado: en esta base chica recorrerla ES más barato; lo que se comprueba es que la
    // forma exacta de la consulta PUEDE entrar por el índice (como la prueba de capacidad de D29).
    const plan = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
        Prisma.sql`EXPLAIN ${consultaDeInstanciasEnOtraCuenta(venueId, a, [randomUUID(), randomUUID()])}`,
      )
    })
    expect(plan.map(fila => fila['QUERY PLAN']).join('\n')).toContain('OrderPromotion_instanceId_idx')
  })
})
