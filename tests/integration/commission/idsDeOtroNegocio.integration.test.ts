// tests/integration/commission/idsDeOtroNegocio.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES T1-hermanos (seguridad, aprobado por el founder el 8-oct), contra Postgres REAL y por la
 * RUTA real (app + token).
 *
 * Las escrituras de comisiones que reciben ids de otras tablas no miraban de quién eran:
 * - el producto o la categoría de un hito;
 * - la persona de una meta y las de una exclusión en lote;
 * - las categorías de un esquema (de la sede, de la organización y del reemplazo);
 * - la orden o el turno de una comisión manual.
 * Con un id de OTRO negocio, cada ruta responde ahora 400 en español y no escribe nada. Donde ya se validaba (la excepción por
 * persona y «a quién aplica»), la prueba fija que siga así y que el texto salga en español.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="<base de prueba>" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/idsDeOtroNegocio.integration.test.ts --ci --runInBand
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones } from './_mundoComisiones'

jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

let m: MundoComisiones
let ajeno: MundoComisiones
/** Ids de OTRO negocio: un producto, una categoría, una orden y un turno de la sede ajena. */
let deOtro: { productId: string; categoryId: string; orderId: string; shiftId: string }
let server: Server
beforeAll(async () => {
  asegurarBaseDePrueba()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
beforeEach(async () => {
  m = await crearMundoComisiones('ids-ajenos')
  ajeno = await crearMundoComisiones('ids-ajenos-otro')
  const categoria = await prisma.menuCategory.create({ data: { venueId: ajeno.venueId, name: 'Ajena', slug: `${ajeno.key}-cat` } })
  const producto = await prisma.product.create({
    data: {
      venueId: ajeno.venueId,
      categoryId: categoria.id,
      name: 'Producto ajeno',
      sku: `${ajeno.key}-p`,
      price: new Prisma.Decimal(10),
    },
  })
  const orden = await prisma.order.create({
    data: { venueId: ajeno.venueId, orderNumber: `${ajeno.key}-o`, subtotal: 10, taxAmount: 0, total: 10, status: 'COMPLETED' },
  })
  const turno = await prisma.shift.create({ data: { venueId: ajeno.venueId, staffId: ajeno.owner, startTime: new Date() } })
  deOtro = { productId: producto.id, categoryId: categoria.id, orderId: orden.id, shiftId: turno.id }
})
afterEach(async () => {
  for (const mundo of [m, ajeno]) {
    if (!mundo) continue
    await prisma.commissionMilestone.deleteMany({ where: { config: { venueId: mundo.venueId } } })
    await prisma.commissionOverride.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.venueModule.deleteMany({ where: { venueId: mundo.venueId } })
    await prisma.idempotencyRequest.deleteMany({ where: { organizationId: mundo.orgId } })
  }
  await prisma.commissionConfig.deleteMany({ where: { orgId: { in: [m.orgId, ajeno.orgId] }, venueId: null } })
  for (const mundo of [m, ajeno]) await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const ruta = (r: string) => `/api/v1/dashboard/commissions/venues/${m.venueId}${r}`
const enviar = (metodo: 'post' | 'put' | 'patch', r: string, cuerpo: object) =>
  request(server)[metodo](ruta(r)).set('Authorization', `Bearer ${token()}`).send(cuerpo)
const hito = (extra: object) => ({
  name: 'Meta',
  targetType: 'PRODUCT_QUANTITY',
  targetValue: 10,
  bonusType: 'FIXED_AMOUNT',
  bonusValue: 100,
  period: 'MONTHLY',
  ...extra,
})
const esquemasDeLaSede = () => prisma.commissionConfig.count({ where: { venueId: m.venueId } })

describe('T1-hermanos · un id de OTRO negocio en una escritura de comisiones ⇒ 400 en español y nada escrito', () => {
  it('🔴 hito con el producto de otro negocio', async () => {
    const r = await enviar('post', `/configs/${m.configId}/milestones`, hito({ productId: deOtro.productId }))
    expect([r.status, r.body.message]).toEqual([400, 'Uno de los productos elegidos no es de este negocio.'])
    expect(await prisma.commissionMilestone.count({ where: { configId: m.configId } })).toBe(0)
  })

  it('🔴 hito con la categoría de otro negocio', async () => {
    const r = await enviar(
      'post',
      `/configs/${m.configId}/milestones`,
      hito({ targetType: 'CATEGORY_AMOUNT', categoryId: deOtro.categoryId }),
    )
    expect([r.status, r.body.message]).toEqual([400, 'Una de las categorías elegidas no es de este negocio.'])
    expect(await prisma.commissionMilestone.count({ where: { configId: m.configId } })).toBe(0)
  })

  it('🔴 editar un hito para apuntarlo al producto de otro negocio', async () => {
    const propio = await prisma.commissionMilestone.create({
      data: {
        configId: m.configId,
        name: 'Ventas',
        targetType: 'SALES_AMOUNT',
        targetValue: 1000,
        bonusType: 'FIXED_AMOUNT',
        bonusValue: 100,
        period: 'MONTHLY',
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86_400_000),
      },
    })
    const r = await enviar('put', `/milestones/${propio.id}`, { targetType: 'PRODUCT_QUANTITY', productId: deOtro.productId })
    expect(r.status).toBe(400)
    expect(await prisma.commissionMilestone.findUniqueOrThrow({ where: { id: propio.id } })).toMatchObject({
      targetType: 'SALES_AMOUNT',
      productId: null,
    })
  })

  it('🔴 meta de ventas para una persona de otro negocio', async () => {
    const r = await enviar('post', '/goals', { staffId: ajeno.ana, goal: 10000, period: 'MONTHLY' })
    expect([r.status, r.body.message]).toEqual([400, 'Una de las personas elegidas no es del equipo de este negocio.'])
    expect(await prisma.venueModule.count({ where: { venueId: m.venueId } })).toBe(0)
  })

  it('🔴 excluir en lote con una persona de otro negocio: no excluye a NADIE', async () => {
    const r = await enviar('post', `/configs/${m.configId}/bulk-exclude`, { staffIds: [m.ana, ajeno.ana] })
    expect([r.status, r.body.message]).toEqual([400, 'Una de las personas elegidas no es del equipo de este negocio.'])
    expect(await prisma.commissionOverride.count({ where: { configId: m.configId } })).toBe(0)
  })

  it('🔴 excepción por persona de otro negocio: 400 con el texto en español (antes en inglés)', async () => {
    const r = await enviar('post', `/configs/${m.configId}/overrides`, { staffId: ajeno.ana, customRate: 0.2 })
    expect([r.status, r.body.message]).toEqual([400, 'Una de las personas elegidas no es del equipo de este negocio.'])
    expect(await prisma.commissionOverride.count({ where: { configId: m.configId } })).toBe(0)
  })

  it('🔴 esquema de la sede con la categoría de otro negocio (crear y editar)', async () => {
    const antes = await esquemasDeLaSede()
    const crear = await enviar('post', '/configs', {
      name: 'Por categoría',
      defaultRate: 0.05,
      filterByCategories: true,
      categoryIds: [deOtro.categoryId],
    })
    expect([crear.status, crear.body.message]).toEqual([400, 'Una de las categorías elegidas no es de este negocio.'])
    expect(await esquemasDeLaSede()).toBe(antes)

    const editar = await enviar('put', `/configs/${m.configId}`, { filterByCategories: true, categoryIds: [deOtro.categoryId] })
    expect(editar.status).toBe(400)
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: m.configId } })).categoryIds).toEqual([])
  })

  it('🔴 esquema de la organización con la categoría de otro negocio (crear y editar)', async () => {
    const crear = await enviar('post', '/org-configs', {
      name: 'Org',
      defaultRate: 0.05,
      filterByCategories: true,
      categoryIds: [deOtro.categoryId],
    })
    expect(crear.status).toBe(400)
    expect(await prisma.commissionConfig.count({ where: { orgId: m.orgId, venueId: null } })).toBe(0)

    const org = await prisma.commissionConfig.create({
      data: { orgId: m.orgId, venueId: null, name: 'Org', createdById: m.owner, defaultRate: 0.05, categoryIds: [] },
    })
    const editar = await enviar('put', `/org-configs/${org.id}`, { categoryIds: [deOtro.categoryId] })
    expect(editar.status).toBe(400)
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: org.id } })).categoryIds).toEqual([])
  })

  it('🔴 «Duplicar con cambios» (reemplazo) con la categoría de otro negocio: el original sigue activo y no nace otro', async () => {
    const antes = await esquemasDeLaSede()
    const r = await enviar('post', `/configs/${m.configId}/copy`, {
      replace: true,
      filterByCategories: true,
      categoryIds: [deOtro.categoryId],
    })
    expect(r.status).toBe(400)
    expect(await esquemasDeLaSede()).toBe(antes)
    expect((await prisma.commissionConfig.findUniqueOrThrow({ where: { id: m.configId } })).active).toBe(true)
  })

  it('🔴 comisión manual colgada de la orden o del turno de otro negocio', async () => {
    const conOrden = await enviar('post', '/calculations/manual', { staffId: m.ana, amount: 50, reason: 'Bono', orderId: deOtro.orderId })
    expect([conOrden.status, conOrden.body.message]).toEqual([400, 'La orden elegida no es de este negocio.'])
    const conTurno = await enviar('post', '/calculations/manual', { staffId: m.ana, amount: 50, reason: 'Bono', shiftId: deOtro.shiftId })
    expect([conTurno.status, conTurno.body.message]).toEqual([400, 'El turno elegido no es de este negocio.'])
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId } })).toBe(0)
  })

  it('🔴 comisión manual para una persona de otro negocio: 400 en español (antes en inglés)', async () => {
    const r = await enviar('post', '/calculations/manual', { staffId: ajeno.ana, amount: 50, reason: 'Bono' })
    expect([r.status, r.body.message]).toEqual([400, 'Una de las personas elegidas no es del equipo de este negocio.'])
    expect(await prisma.commissionCalculation.count({ where: { venueId: m.venueId } })).toBe(0)
  })

  // ── Regresión: con ids del propio negocio, todo sigue funcionando ──
  it('con el producto, la categoría, la persona y la orden del propio negocio, se escribe como siempre', async () => {
    const categoria = await prisma.menuCategory.create({ data: { venueId: m.venueId, name: 'Propia', slug: `${m.key}-cat` } })
    const producto = await prisma.product.create({
      data: { venueId: m.venueId, categoryId: categoria.id, name: 'Propio', sku: `${m.key}-p`, price: new Prisma.Decimal(10) },
    })
    expect((await enviar('post', `/configs/${m.configId}/milestones`, hito({ productId: producto.id }))).status).toBe(201)
    expect((await enviar('post', '/goals', { staffId: m.ana, goal: 10000, period: 'MONTHLY' })).status).toBe(201)
    expect((await enviar('post', `/configs/${m.configId}/bulk-exclude`, { staffIds: [m.bea] })).status).toBe(200)
    expect((await enviar('put', `/configs/${m.configId}`, { filterByCategories: true, categoryIds: [categoria.id] })).status).toBe(200)
    const orden = await prisma.order.create({
      data: { venueId: m.venueId, orderNumber: `${m.key}-o`, subtotal: 10, taxAmount: 0, total: 10, status: 'COMPLETED' },
    })
    expect((await enviar('post', '/calculations/manual', { staffId: m.ana, amount: 50, reason: 'Bono', orderId: orden.id })).status).toBe(
      201,
    )
  })
})
