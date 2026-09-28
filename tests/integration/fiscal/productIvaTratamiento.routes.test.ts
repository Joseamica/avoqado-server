/**
 * Integration (REAL DB + REAL app por supertest) — Tarea 5 del plan de IVA por producto.
 *
 * Garantía que ningún test unitario puede fijar: un cliente que manda `taxRate: 0` sobre un
 * producto IVA_16, con el negocio SIN el flag `VenueIvaPorProducto` prendido, recibe un 409 con
 * `code: 'IVA_POR_PRODUCTO_APAGADO'` — nunca un 500 (el trigger de Product también rechazaría el
 * intento si el normalizador no lo atajara antes, y ESE camino sí sería un 500 anónimo).
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://postgres:<contraseña>@localhost:5432/av_db_25_iva_test' \
 *     npx jest --selectProjects integration --runTestsByPath tests/integration/fiscal/productIvaTratamiento.routes.test.ts --ci
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { traducirErrorDeIva } from '@/services/fiscal/normalizarIvaDeProducto'

describe('PUT /mobile/venues/:venueId/products/:productId — IVA por producto (Tarea 5)', () => {
  let server: Server
  let venueId: string
  let orgId: string
  let staffId: string
  let categoryId: string
  let productId: string
  let token: string

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))

    const suffix = Date.now()
    const org = await prisma.organization.create({
      data: { name: `Org IVA ${suffix}`, email: `iva${suffix}@t.mx`, phone: '5555555555' },
    })
    orgId = org.id
    venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `V IVA ${suffix}`, slug: `v-iva-${suffix}` } })).id
    categoryId = (await prisma.menuCategory.create({ data: { venueId, name: `Cat IVA ${suffix}`, slug: `cat-iva-${suffix}` } })).id
    staffId = (await prisma.staff.create({ data: { email: `iva-staff-${suffix}@t.mx`, firstName: 'IVA', lastName: 'Tarea5' } })).id
    await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
    token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  })

  beforeEach(async () => {
    // Producto IVA_16 fresco por prueba (el default del schema), y SIN VenueIvaPorProducto: el
    // flag apagado es el estado real de todo negocio que no lo ha pedido.
    productId = (
      await prisma.product.create({
        data: { venueId, categoryId, name: `Producto IVA ${Date.now()}`, sku: `SKU-IVA-${Date.now()}`, price: 100 },
      })
    ).id
    await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
  })

  afterAll(async () => {
    try {
      await prisma.venueIvaPorProducto.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { staffId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
      await prisma.organization.deleteMany({ where: { id: orgId } })
      await prisma.staff.deleteMany({ where: { id: staffId } })
    } catch {
      /* fixtures */
    }
    await new Promise<void>(listo => server.close(() => listo()))
  })

  it('taxRate:0 sobre IVA_16 con la bandera apagada ⇒ 409 IVA_POR_PRODUCTO_APAGADO (nunca 500)', async () => {
    const res = await request(server)
      .put(`/api/v1/mobile/venues/${venueId}/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ taxRate: 0 })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('IVA_POR_PRODUCTO_APAGADO')

    // El producto no quedó a medio escribir: sigue IVA_16 / 0.16.
    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(producto.ivaTratamiento).toBe('IVA_16')
    expect(Number(producto.taxRate)).toBe(0.16)
  })

  it('ivaTratamiento: EXENTO con la bandera apagada ⇒ 409 IVA_POR_PRODUCTO_APAGADO', async () => {
    const res = await request(server)
      .put(`/api/v1/mobile/venues/${venueId}/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ivaTratamiento: 'EXENTO' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('IVA_POR_PRODUCTO_APAGADO')
  })

  it('ivaTratamiento: IVA_8 (no ofrecido en v1) ⇒ 400 IVA_TRATAMIENTO_CONTRADICTORIO', async () => {
    await prisma.venueIvaPorProducto.create({ data: { venueId, habilitadoPorStaffId: staffId } })

    const res = await request(server)
      .put(`/api/v1/mobile/venues/${venueId}/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ivaTratamiento: 'IVA_8' })

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('IVA_TRATAMIENTO_CONTRADICTORIO')
  })

  it('con la bandera encendida, ivaTratamiento: IVA_0 sí se aplica y persiste en la fila', async () => {
    await prisma.venueIvaPorProducto.create({ data: { venueId, habilitadoPorStaffId: staffId } })

    const res = await request(server)
      .put(`/api/v1/mobile/venues/${venueId}/products/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ivaTratamiento: 'IVA_0' })

    expect(res.status).toBe(200)

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(producto.ivaTratamiento).toBe('IVA_0')
    expect(Number(producto.taxRate)).toBe(0)
    expect(producto.objetoImp).toBe('02')
  })

  it('Minor 1 (Ruling R9): el TRIGGER mismo rechaza sin pasar por el normalizador, y traducirErrorDeIva lo vuelve el mismo 409', async () => {
    // Bypass TOTAL de normalizarIvaDeProducto: escritura de MODELO directa (como haría un script
    // de migración, un import masivo, o cualquier código futuro que olvide pasar por el
    // normalizador). El flag sigue apagado (beforeEach lo borra) — el trigger de Postgres
    // (`Product_ivaTratamiento_1_explicito`) tiene que rechazar por su cuenta, con el MISMO texto
    // ('IVA_POR_PRODUCTO_APAGADO') que el normalizador ya conoce.
    // Verificado en vivo (2026-09-25): el error real es un `PrismaClientUnknownRequestError` con
    // `code`/`meta` en `undefined` — el P0001 sólo viaja como TEXTO dentro de `.message`
    // ('...PostgresError { code: "P0001", message: "IVA_POR_PRODUCTO_APAGADO", ... }'). El match
    // por substring de `traducirErrorDeIva` ya lo cubre sin cambios.
    let errorReal: unknown
    try {
      await prisma.product.update({ where: { id: productId }, data: { ivaTratamiento: 'EXENTO' } })
      throw new Error('se esperaba que el trigger rechazara la escritura')
    } catch (e) {
      errorReal = e
    }

    expect(() => traducirErrorDeIva(errorReal)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'IVA_POR_PRODUCTO_APAGADO',
        message: expect.stringContaining('IVA por producto no está activado'),
      }),
    )

    // La escritura NUNCA ocurrió: el producto sigue IVA_16 / 0.16.
    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    expect(producto.ivaTratamiento).toBe('IVA_16')
    expect(Number(producto.taxRate)).toBe(0.16)
  })
})
