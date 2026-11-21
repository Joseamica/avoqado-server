/**
 * D13 «C» (founder, 21-nov-2026), contra Postgres REAL: la venta de un vendedor que dieron de baja ya no se atora.
 *   · la cuenta ya estaba guardada a su nombre ⇒ su cobro entra a nombre del vendedor, sin plazo;
 *   · la venta nace de la cola sin red ⇒ cuenta y cobro a nombre de la SESIÓN que la sube;
 *   · una venta NUEVA en vivo con ese vendedor ⇒ el 400 de hoy.
 * Las dos salidas dejan la nota `VENDEDOR_DADO_DE_BAJA` en la MISMA transacción; un reintento no duplica cobro ni nota.
 * La baja se hace como el switch de Equipo (sólo `active=false`, sin `endDate`): esta regla no depende de la hora de la baja.
 * Promesa: Avoqado/docs/audit/2026-11-21-vendedor-dado-de-baja/promesa.md
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { createOrderWithItems, payCashOrder } from '@/services/mobile/order.mobile.service'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'
import {
  asegurarBaseDePrueba,
  borrarMundoComisiones,
  categoria,
  crearMundoComisiones,
  MundoComisiones,
} from '../commission/_mundoComisiones'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => {
  const manager = { broadcastToVenue: jest.fn(), getServer: jest.fn(), getBroadcastingService: jest.fn(() => null) }
  return { __esModule: true, default: manager, socketManager: manager }
})
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))
jest.mock('@/services/shared/cashDrawerPosting', () => ({
  ...jest.requireActual('@/services/shared/cashDrawerPosting'),
  postCashSaleToDrawer: jest.fn().mockResolvedValue(undefined),
}))

let m: MundoComisiones
let productId: string
// Ana cobra (la sesión del aparato); Bea es la vendedora que dan de baja («Beto» en la tarjeta).
let cajera: string
let vendedora: string

beforeAll(asegurarBaseDePrueba)
beforeEach(async () => {
  m = await crearMundoComisiones('vendedor-baja')
  cajera = m.ana
  vendedora = m.bea
  const categoryId = await categoria(m)
  productId = (await prisma.product.create({ data: { venueId: m.venueId, categoryId, name: 'Café', sku: `${m.key}-cafe`, price: 100 } })).id
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

/** Como el switch de Equipo del DASHBOARD: sólo apaga la membresía (sin `endDate`). */
const darDeBaja = (staffId: string) => prisma.staffVenue.updateMany({ where: { staffId, venueId: m.venueId }, data: { active: false } })

const venta = (extra: Record<string, unknown>) =>
  createOrderWithItems(m.venueId, {
    staffId: vendedora,
    sesionStaffId: cajera,
    source: 'AVOQADO_ANDROID',
    orderType: 'TAKEOUT',
    items: [{ productId, quantity: 1 }],
    externalId: randomUUID(),
    ...extra,
  } as any)

const cobro = (orderId: string, extra: Record<string, unknown>) =>
  payCashOrder(m.venueId, orderId, {
    amount: 10000,
    tip: 0,
    staffId: vendedora,
    sesionStaffId: cajera,
    idempotencyKey: randomUUID(),
    ...extra,
  } as any)

const notas = () => prisma.activityLog.findMany({ where: { venueId: m.venueId, action: 'VENDEDOR_DADO_DE_BAJA' }, take: 20 })
/** Las notas como [entidad, id, caso, dijo, quedó, orden, pago], ordenadas: una aserción EXACTA, no «alguna que traiga…» (Codex r1 #8). */
const notasExactas = async () =>
  (await notas())
    .map(x => {
      const d = x.data as any
      return [x.entity, x.entityId, x.staffId, d.caso, d.elAparatoDijo, d.quedoANombreDe, d.orderId, d.paymentId ?? null]
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
const pagoDe = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id }, select: { processedById: true, orderId: true } })
const cuentaDe = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, select: { servedById: true, createdById: true } })

describe('D13 · caso 1: la venta nace de la cola sin red con una vendedora ya dada de baja', () => {
  it('🔴 (a) la cuenta y su cobro quedan a nombre de la cajera, con su nota (antes: 400 y «por revisar»)', async () => {
    await darDeBaja(vendedora)
    const orden = await venta({ isOfflineReplay: true })
    expect(await cuentaDe(orden.id)).toEqual({ servedById: cajera, createdById: cajera })

    const r = await cobro(orden.id, { isOfflineReplay: true })
    expect((await pagoDe(r.paymentId)).processedById).toBe(cajera)

    expect(await notasExactas()).toEqual([
      ['Order', orden.id, cajera, 'COLA_A_LA_SESION', vendedora, cajera, orden.id, null],
      ['Payment', r.paymentId, cajera, 'COLA_A_LA_SESION', vendedora, cajera, orden.id, r.paymentId],
    ])
  })

  it('🔴 (e) la venta rápida sin productos (`/fast`) de la cola queda a nombre de la cajera, con su nota', async () => {
    await darDeBaja(vendedora)
    const r: any = await recordFastPayment(
      m.venueId,
      {
        venueId: m.venueId,
        amount: 5000,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        splitType: 'FULLPAYMENT',
        staffId: vendedora,
        source: 'AVOQADO_ANDROID',
        idempotencyKey: randomUUID(),
        isOfflineReplay: true,
      } as any,
      cajera,
    )
    const pago = await pagoDe(r.id)
    expect(pago.processedById).toBe(cajera)
    expect(await cuentaDe(pago.orderId!)).toEqual({ servedById: cajera, createdById: cajera })
    expect(await notasExactas()).toEqual([['Payment', r.id, cajera, 'COLA_A_LA_SESION', vendedora, cajera, pago.orderId, r.id]])
  })

  it('🔴 (d) el reintento de la cuenta y del cobro devuelve lo mismo: una cuenta, un cobro y una nota de cada uno', async () => {
    await darDeBaja(vendedora)
    const externalId = randomUUID()
    const a = await venta({ isOfflineReplay: true, externalId })
    const b = await venta({ isOfflineReplay: true, externalId })
    expect(b.id).toBe(a.id)

    const idempotencyKey = randomUUID()
    const p1 = await cobro(a.id, { isOfflineReplay: true, idempotencyKey })
    const p2 = await cobro(a.id, { isOfflineReplay: true, idempotencyKey })
    expect(p2.paymentId).toBe(p1.paymentId)
    expect(await prisma.payment.count({ where: { venueId: m.venueId, orderId: a.id } })).toBe(1)
    expect(await prisma.order.count({ where: { venueId: m.venueId, externalId } })).toBe(1)
    expect(await notasExactas()).toEqual([
      ['Order', a.id, cajera, 'COLA_A_LA_SESION', vendedora, cajera, a.id, null],
      ['Payment', p1.paymentId, cajera, 'COLA_A_LA_SESION', vendedora, cajera, a.id, p1.paymentId],
    ])
  })

  it('🔴 (d) dos envíos A LA VEZ del mismo cobro de la cola: un solo cobro y una sola nota', async () => {
    await darDeBaja(vendedora)
    const orden = await venta({ isOfflineReplay: true })
    const idempotencyKey = randomUUID()
    const [p1, p2] = await Promise.all([
      cobro(orden.id, { isOfflineReplay: true, idempotencyKey }),
      cobro(orden.id, { isOfflineReplay: true, idempotencyKey }),
    ])
    expect(p2.paymentId).toBe(p1.paymentId)
    expect(await prisma.payment.count({ where: { venueId: m.venueId, orderId: orden.id } })).toBe(1)
    expect((await notasExactas()).filter(n => n[0] === 'Payment')).toEqual([
      ['Payment', p1.paymentId, cajera, 'COLA_A_LA_SESION', vendedora, cajera, orden.id, p1.paymentId],
    ])
  })

  it('un id que no es de este negocio sigue con el 400 de hoy, aunque venga de la cola', async () => {
    const ajeno = (await prisma.staff.create({ data: { email: `${m.key}-ajeno@example.test`, firstName: 'Ajeno', lastName: 'QA' } })).id
    await expect(venta({ isOfflineReplay: true, staffId: ajeno })).rejects.toMatchObject({ statusCode: 400 })
    expect(await notas()).toHaveLength(0)
  })

  it('sin sesión (un llamador que no la pasa) sigue con el 400 de hoy', async () => {
    await darDeBaja(vendedora)
    await expect(venta({ isOfflineReplay: true, sesionStaffId: undefined })).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('D13 · caso 2: la cuenta ya estaba guardada a nombre de la vendedora', () => {
  it('🔴 (b) su cobro EN VIVO después de la baja queda a nombre de la vendedora, con su nota (WINDOWS, venta a medias)', async () => {
    const orden = await venta({})
    expect(await cuentaDe(orden.id)).toEqual({ servedById: vendedora, createdById: vendedora })
    await darDeBaja(vendedora)

    const r = await cobro(orden.id, {})
    expect((await pagoDe(r.paymentId)).processedById).toBe(vendedora)
    expect(await notasExactas()).toEqual([
      ['Payment', r.paymentId, cajera, 'ORDEN_DEL_VENDEDOR', vendedora, vendedora, orden.id, r.paymentId],
    ])
  })

  it('🔴 también si la ELIMINARON del equipo (sin membresía): la cuenta guardada basta (Codex r1 #4)', async () => {
    const orden = await venta({})
    await prisma.staffVenue.deleteMany({ where: { staffId: vendedora, venueId: m.venueId } })
    const r = await cobro(orden.id, {})
    expect((await pagoDe(r.paymentId)).processedById).toBe(vendedora)
    expect((await notasExactas()).map(n => n[3])).toEqual(['ORDEN_DEL_VENDEDOR'])
  })

  it('«Cuentas abiertas» manda a la cajera (no a la vendedora): el cobro es de la cajera y sin nota, como hoy (Codex r1 #1)', async () => {
    const orden = await venta({})
    await darDeBaja(vendedora)
    const r = await cobro(orden.id, { staffId: cajera })
    expect((await pagoDe(r.paymentId)).processedById).toBe(cajera)
    expect(await cuentaDe(orden.id)).toEqual({ servedById: vendedora, createdById: vendedora })
    expect(await notas()).toHaveLength(0)
  })

  it('🔴 la cuenta abierta con red y cobrada desde la cola también queda de la vendedora (la cuenta manda)', async () => {
    const orden = await venta({})
    await darDeBaja(vendedora)
    const r = await cobro(orden.id, { isOfflineReplay: true })
    expect((await pagoDe(r.paymentId)).processedById).toBe(vendedora)
    expect(await notasExactas()).toEqual([
      ['Payment', r.paymentId, cajera, 'ORDEN_DEL_VENDEDOR', vendedora, vendedora, orden.id, r.paymentId],
    ])
  })
})

describe('D13 · lo que NO cambia', () => {
  it('(c) una venta NUEVA en vivo con la vendedora ya dada de baja: el 400 de hoy', async () => {
    await darDeBaja(vendedora)
    await expect(venta({})).rejects.toMatchObject({ statusCode: 400 })
    expect(await notas()).toHaveLength(0)
  })

  it('(c) el cobro en vivo de una cuenta que NO es suya, con la vendedora dada de baja: el 400 de hoy', async () => {
    const orden = await venta({ staffId: cajera })
    await darDeBaja(vendedora)
    await expect(cobro(orden.id, {})).rejects.toMatchObject({ statusCode: 400 })
    expect(await prisma.payment.count({ where: { venueId: m.venueId, orderId: orden.id } })).toBe(0)
    expect(await notas()).toHaveLength(0)
  })

  it('con la vendedora activa todo es como hoy: a su nombre y sin nota', async () => {
    const orden = await venta({ isOfflineReplay: true })
    const r = await cobro(orden.id, { isOfflineReplay: true })
    expect(await cuentaDe(orden.id)).toEqual({ servedById: vendedora, createdById: vendedora })
    expect((await pagoDe(r.paymentId)).processedById).toBe(vendedora)
    expect(await notas()).toHaveLength(0)
  })
})
