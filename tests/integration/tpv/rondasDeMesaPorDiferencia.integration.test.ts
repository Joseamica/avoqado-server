/**
 * 🔴 MONEY — dos rondas de mesa mandadas como DIFERENCIA no pueden cobrarse como una.
 *
 * `addItemsToOrder` tiene dos semánticas a propósito (ver su JSDoc en order.tpv.service.ts):
 *   · `asNewRound=false` (PATCH /tpv/.../items, la terminal PAX): el cliente manda el CARRITO
 *     COMPLETO, así que una línea igual REEMPLAZA su cantidad.
 *   · `asNewRound=true` (POST /mobile/.../items, POS Android/iOS): cada request es UNA ronda y
 *     crea sus propias filas.
 *
 * La caja de Windows (avoqado-desktop, TableBillPanel.sendRound) mandaba SÓLO lo nuevo de cada
 * ronda por la ruta PATCH /tpv — la del carrito completo. Ronda 1 = 2 cervezas, ronda 2 = 1
 * cerveza igual ⇒ la cuenta quedaba en 1 cerveza: la cocina sirvió 3 y se cobraron 1.
 *
 * Estas pruebas fijan el contrato por RUTA, por HTTP y contra Postgres real:
 *   1. El reemplazo de la ruta /tpv (conducta de la PAX, intacta) — que es exactamente lo que
 *      convierte una ronda por diferencia en un cobro de menos.
 *   2. La ruta de rondas /mobile suma las dos rondas (3 cervezas, $150).
 */
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

jest.setTimeout(60_000)

// La ruta /mobile exige TABLE_SERVICE; aquí se prueba la semántica del dinero, no el gating del plan.
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

describe('Rondas de mesa mandadas por diferencia (caja de Windows)', () => {
  const sello = Date.now()
  let orgId: string, venueId: string, staffId: string, categoryId: string, productId: string
  let token: string
  let n = 0

  beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `Org rondas ${sello}`, email: `rondas${sello}@t.mx`, phone: '5555555555' } }))
      .id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V rondas ${sello}`, slug: `v-rondas-${sello}` } })).id
    staffId = (await prisma.staff.create({ data: { email: `rondas-${sello}@t.mx`, firstName: 'Mesero', lastName: 'Rondas' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${sello}` } })).id
    productId = (await prisma.product.create({ data: { venueId, categoryId, sku: `CERV-${sello}`, name: 'Cerveza', price: 50 } })).id
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  afterAll(async () => {
    try {
      const ids = (await prisma.order.findMany({ where: { venueId }, select: { id: true } })).map(o => o.id)
      await prisma.orderItemModifier.deleteMany({ where: { orderItem: { orderId: { in: ids } } } })
      await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.order.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
  })

  async function cuentaAbierta() {
    return prisma.order.create({
      data: { venueId, orderNumber: `R-${sello}-${++n}`, subtotal: 0, taxAmount: 0, total: 0, version: 1 },
    })
  }

  /** Una ronda por DIFERENCIA: sólo lo nuevo, con la versión vigente de la cuenta. */
  async function ronda(ruta: 'tpv' | 'mobile', orderId: string, quantity: number) {
    const { version } = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { version: true } })
    const url = `/api/v1/${ruta}/venues/${venueId}/orders/${orderId}/items`
    const req = ruta === 'tpv' ? request(app).patch(url) : request(app).post(url)
    const res = await req.set('Authorization', `Bearer ${token}`).send({ items: [{ productId, quantity }], version })
    expect(res.status).toBe(200)
  }

  async function cervezasEnLaCuenta(orderId: string) {
    const renglones = await prisma.orderItem.findMany({ where: { orderId, productId } })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    return { cantidad: renglones.reduce((s, r) => s + r.quantity, 0), renglones: renglones.length, subtotal: Number(order.subtotal) }
  }

  it('PATCH /tpv (carrito completo, la PAX): la segunda ronda REEMPLAZA la cantidad — por eso no sirve para rondas por diferencia', async () => {
    const { id } = await cuentaAbierta()
    await ronda('tpv', id, 2)
    await ronda('tpv', id, 1)
    // Conducta deliberada de la PAX: «que quede 1». Con rondas por diferencia es un cobro de menos.
    expect(await cervezasEnLaCuenta(id)).toEqual({ cantidad: 1, renglones: 1, subtotal: 50 })
  })

  it('POST /mobile (rondas): 2 cervezas + 1 cerveza igual = 3 cervezas cobradas', async () => {
    const { id } = await cuentaAbierta()
    await ronda('mobile', id, 2)
    await ronda('mobile', id, 1)
    expect(await cervezasEnLaCuenta(id)).toEqual({ cantidad: 3, renglones: 2, subtotal: 150 })
  })
})
