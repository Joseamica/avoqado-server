/**
 * La venta del celular (App de campo, bloque 0, Tarea 4) por la RUTA real (app + token) y contra Postgres REAL.
 *
 * Lo que el unit no puede probar: los dos únicos de la ficha en la base, la transacción de `sellSerializedItem` que se
 * revierte con el gancho, el cobro idempotente por la llave y que la venta deja lo MISMO que una de la PAX. Al final, la
 * ruta de la PAX (`/tpv/serialized-inventory/sell` + su cobro) sigue respondiendo como siempre.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "tpv/ventaDeCampo" --detectOpenHandles=false --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { serializedInventoryService } from '@/services/serialized-inventory/serializedInventory.service'
import * as pagos from '@/services/tpv/payment.tpv.service'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
let server: Server
let orgId: string
let venueId: string
let otraSucursalId: string
let promotorId: string
let otroPromotorId: string
let categoriaDeCaja: string // «de caja»: precio sugerido $0
let categoria100: string

const token = () =>
  jwt.sign({ sub: promotorId, orgId, venueId, role: 'CASHIER' }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })

const vender = (body: Record<string, unknown>, sucursal = venueId) =>
  request(server).post(`/api/v1/tpv/campo/venues/${sucursal}/ventas`).set('Authorization', `Bearer ${token()}`).send(body)

let consecutivo = 0
/** Una SIM ya aceptada por el promotor (custodia en ENFORCE), como la tendría en su celular. */
async function nuevaSim(categoryId: string, extra: Record<string, unknown> = {}) {
  consecutivo += 1
  const serialNumber = `8952${String(Date.now()).slice(-9)}${String(consecutivo).padStart(6, '0')}`
  return prisma.serializedItem.create({
    data: {
      venueId,
      categoryId,
      serialNumber,
      createdBy: promotorId,
      custodyState: 'PROMOTER_HELD',
      assignedPromoterId: promotorId,
      ...extra,
    },
  })
}

const ventaDe = (serialNumber: string, extra: Record<string, unknown> = {}) => ({
  llave: randomUUID(),
  serialNumber,
  precioVisto: 0,
  ...extra,
})

/** Lo que quedó en Postgres para una SIM y su llave. */
async function filas(serialNumber: string, llave: string) {
  const [ordenes, cobros, fichas] = await Promise.all([
    prisma.order.findMany({ where: { venueId, items: { some: { productSku: serialNumber } } }, include: { items: true } }),
    prisma.payment.findMany({ where: { venueId, idempotencyKey: llave } }),
    prisma.ventaDeCampo.findMany({ where: { llave } }),
  ])
  const evidencias = await prisma.saleVerification.findMany({ where: { paymentId: { in: cobros.map(c => c.id) } } })
  return { ordenes, cobros, fichas, evidencias }
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Campo ${sufijo}`, email: `campo-${sufijo}@example.test`, phone: '5500000000', simCustodyEnforcementMode: 'ENFORCE' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Campo ${sufijo}`, slug: `campo-${sufijo}` } })).id
  otraSucursalId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Campo B ${sufijo}`, slug: `campo-b-${sufijo}` } })).id
  promotorId = (
    await prisma.staff.create({
      data: {
        email: `campo-promotor-${sufijo}@example.test`,
        firstName: 'Promotor',
        lastName: 'Campo',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        // Dado de baja en la otra sucursal: su token sigue vivo, pero ahí ya no vende.
        venues: {
          create: [
            { venueId, role: 'CASHIER', active: true },
            { venueId: otraSucursalId, role: 'CASHIER', active: false },
          ],
        },
      },
    })
  ).id
  otroPromotorId = (
    await prisma.staff.create({
      data: {
        email: `campo-otro-${sufijo}@example.test`,
        firstName: 'Otro',
        lastName: 'Promotor',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'CASHIER', active: true } },
      },
    })
  ).id
  categoriaDeCaja = (await prisma.itemCategory.create({ data: { venueId, name: 'Chip de caja', suggestedPrice: 0 } })).id
  categoria100 = (await prisma.itemCategory.create({ data: { venueId, name: 'Chip Negra', suggestedPrice: 100 } })).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

beforeEach(() => jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true))
afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  const sucursales = [venueId, otraSucursalId]
  await prisma.ventaDeCampo.deleteMany({ where: { venueId: { in: sucursales } } })
  await prisma.activityLog.deleteMany({ where: { venueId: { in: sucursales } } })
  await prisma.saleVerification.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.serializedItem.deleteMany({ where: { venueId } })
  await prisma.orderAction.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.itemCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: sucursales } } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: { in: [promotorId, otroPromotorId] } } })
  await prisma.venue.deleteMany({ where: { id: { in: sucursales } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('POST /tpv/campo/venues/:venueId/ventas', () => {
  it('una venta «de caja» deja UNA orden, UN cobro CASH de $0 con la llave, la SIM vendida en su renglón y la evidencia con la hora del celular; la misma llave otra vez devuelve lo mismo', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const hora = new Date(Date.now() - 3 * 60 * 60 * 1000)
    // Como lo teclearía una persona: con espacios (se normaliza a como lo guarda el inventario).
    const tecleado = `${sim.serialNumber.slice(0, 8)} ${sim.serialNumber.slice(8)}`
    const cuerpo = ventaDe(tecleado, { ocurrioAt: hora.toISOString(), origenHora: 'RELOJ_ANCLADO' })

    const res = await vender(cuerpo)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      orderId: expect.any(String),
      paymentId: expect.any(String),
      saleVerificationId: expect.any(String),
      repetida: false,
      precio: '0.00',
      hora: hora.toISOString(),
    })
    const { ordenes, cobros, fichas, evidencias } = await filas(sim.serialNumber, cuerpo.llave)
    expect(ordenes).toHaveLength(1)
    expect(ordenes[0]).toMatchObject({ id: res.body.orderId, paymentStatus: 'PAID', createdById: promotorId, terminalId: null })
    expect(ordenes[0].items).toHaveLength(1)
    expect(cobros).toHaveLength(1)
    expect(cobros[0]).toMatchObject({ id: res.body.paymentId, orderId: res.body.orderId, method: 'CASH', status: 'COMPLETED' })
    expect(Number(cobros[0].amount)).toBe(0)
    const vendida = await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })
    expect(vendida).toMatchObject({ status: 'SOLD', orderItemId: ordenes[0].items[0].id })
    expect(evidencias).toHaveLength(1)
    expect(evidencias[0]).toMatchObject({
      id: res.body.saleVerificationId,
      status: 'PENDING',
      staffId: promotorId,
      serialNumbers: [sim.serialNumber],
    })
    expect(evidencias[0].createdAt.toISOString()).toBe(hora.toISOString())
    expect(fichas).toHaveLength(1)
    // Completa: la SIM ya está vendida y la ficha suelta su reclamo (si regresa, se puede volver a vender).
    expect(fichas[0]).toMatchObject({ estado: 'COMPLETA', serializedItemId: null, origenHora: 'RELOJ_ANCLADO', ocupacion: null })

    const otra = await vender(cuerpo)
    expect(otra.status).toBe(200)
    expect(otra.body).toEqual({ ...res.body, repetida: true })
    const despues = await filas(sim.serialNumber, cuerpo.llave)
    expect([despues.ordenes.length, despues.cobros.length, despues.fichas.length, despues.evidencias.length]).toEqual([1, 1, 1, 1])
  })

  it('dos llamadas a la vez con la misma llave dejan una sola venta', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const cuerpo = ventaDe(sim.serialNumber)

    const [a, b] = await Promise.all([vender(cuerpo), vender(cuerpo)])

    // Una gana (201). La otra: 409 VENTA_EN_PROCESO, o 200 repetida si llegó cuando la primera ya había terminado.
    const [ganadora, otra] = a.status === 201 ? [a, b] : [b, a]
    expect(ganadora.status).toBe(201)
    expect([otra.status, otra.body.code ?? otra.body.repetida]).toEqual(otra.status === 409 ? [409, 'VENTA_EN_PROCESO'] : [200, true])
    const reintento = await vender(cuerpo)
    expect(reintento.status).toBe(200)
    expect(reintento.body.repetida).toBe(true)
    const { ordenes, cobros, fichas, evidencias } = await filas(sim.serialNumber, cuerpo.llave)
    expect([ordenes.length, cobros.length, fichas.length, evidencias.length]).toEqual([1, 1, 1, 1])
    expect(reintento.body.orderId).toBe(ordenes[0].id)
  })

  it('dos llaves distintas con la misma SIM a la vez: una vende y la otra se rechaza sin dejar nada', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const [cuerpoA, cuerpoB] = [ventaDe(sim.serialNumber), ventaDe(sim.serialNumber)]

    const [a, b] = await Promise.all([vender(cuerpoA), vender(cuerpoB)])

    const [ganadora, otra] = a.status === 201 ? [a, b] : [b, a]
    expect(ganadora.status).toBe(201)
    // Lo normal: la otra choca con el reclamo de la SIM. Si la primera ya terminó: el escaneo de hoy la ve vendida. Y si la
    // escaneó disponible justo antes de que la primera terminara, el 400 «ya fue vendido» sale de `sellSerializedItem` tal cual.
    expect([
      [409, 'SIM_EN_OTRA_VENTA'],
      [409, 'SIM_YA_VENDIDA'],
      [400, undefined],
    ]).toContainEqual([otra.status, otra.body.code])
    const [deA, deB] = await Promise.all([filas(sim.serialNumber, cuerpoA.llave), filas(sim.serialNumber, cuerpoB.llave)])
    expect(deA.ordenes).toHaveLength(1) // por la SIM: la misma lista en las dos
    expect(deA.cobros.length + deB.cobros.length).toBe(1)
    expect(deA.fichas.length + deB.fichas.length).toBe(1)
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).status).toBe('SOLD')
  })

  it('el cobro se cae una vez tras crear la venta: el reintento cobra ESA orden', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const cuerpo = ventaDe(sim.serialNumber)
    jest.spyOn(pagos, 'recordOrderPayment').mockRejectedValueOnce(new Error('se cortó la conexión'))

    const caida = await vender(cuerpo)
    expect(caida.status).toBe(500)
    const aMedias = await filas(sim.serialNumber, cuerpo.llave)
    expect(aMedias.ordenes).toHaveLength(1)
    expect(aMedias.cobros).toHaveLength(0)
    expect(aMedias.fichas[0]).toMatchObject({ estado: 'EN_CURSO', orderId: aMedias.ordenes[0].id, paymentId: null, ocupacion: null })

    const reintento = await vender(cuerpo)
    expect(reintento.status).toBe(201)
    expect(reintento.body.orderId).toBe(aMedias.ordenes[0].id)
    const { ordenes, cobros } = await filas(sim.serialNumber, cuerpo.llave)
    expect(ordenes).toHaveLength(1)
    expect(cobros).toHaveLength(1)
    expect(cobros[0].orderId).toBe(ordenes[0].id)
  })

  it('la SIM no se marcó (el cobro se tragó el error): el reintento la marca en su renglón', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const cuerpo = ventaDe(sim.serialNumber)
    // 1ª: la que hace el cobro tras su commit (se la traga). 2ª: la del paso 7.
    jest
      .spyOn(serializedInventoryService, 'markAsSold')
      .mockRejectedValueOnce(new Error('lector ocupado'))
      .mockRejectedValueOnce(new Error('lector ocupado'))

    const caida = await vender(cuerpo)
    expect(caida.status).toBe(500)
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).status).toBe('AVAILABLE')
    const aMedias = await filas(sim.serialNumber, cuerpo.llave)
    expect(aMedias.cobros).toHaveLength(1)
    expect(aMedias.fichas[0]).toMatchObject({ paymentId: aMedias.cobros[0].id, ocupacion: null })

    const reintento = await vender(cuerpo)
    expect(reintento.status).toBe(201)
    const { ordenes, cobros } = await filas(sim.serialNumber, cuerpo.llave)
    expect(cobros).toHaveLength(1)
    expect(await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).toMatchObject({
      status: 'SOLD',
      orderItemId: ordenes[0].items[0].id,
    })
  })

  it('una SIM en custodia de otra persona → 409 SIM_NOT_ACCEPTED y ninguna fila', async () => {
    const sim = await nuevaSim(categoriaDeCaja, { assignedPromoterId: otroPromotorId })
    const cuerpo = ventaDe(sim.serialNumber)

    const res = await vender(cuerpo)

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SIM_NOT_ACCEPTED')
    const { ordenes, cobros, fichas } = await filas(sim.serialNumber, cuerpo.llave)
    expect([ordenes.length, cobros.length, fichas.length]).toEqual([0, 0, 0])
  })

  it('un precio distinto al de hoy → 422 PRECIO_CAMBIO con precioActual y ninguna fila', async () => {
    const sim = await nuevaSim(categoria100)
    const cuerpo = ventaDe(sim.serialNumber, { precioVisto: 90 })

    const res = await vender(cuerpo)

    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'PRECIO_CAMBIO', precioActual: '100.00' })
    const { ordenes, cobros, fichas } = await filas(sim.serialNumber, cuerpo.llave)
    expect([ordenes.length, cobros.length, fichas.length]).toEqual([0, 0, 0])
  })

  it('las ventas se deshabilitan entre la venta y el cobro: la orden se cancela, no queda ficha y sale el rechazo', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const cuerpo = ventaDe(sim.serialNumber)
    const real = pagos.recordOrderPayment
    jest.spyOn(pagos, 'recordOrderPayment').mockImplementationOnce(async (...args) => {
      await prisma.venue.update({ where: { id: venueId }, data: { salesEnabled: false } })
      return real(...args)
    })

    try {
      const res = await vender(cuerpo)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('VENUE_SALES_DISABLED')
    } finally {
      await prisma.venue.update({ where: { id: venueId }, data: { salesEnabled: true } })
    }
    const { ordenes, cobros, fichas } = await filas(sim.serialNumber, cuerpo.llave)
    expect(ordenes).toHaveLength(1)
    expect(ordenes[0].status).toBe('CANCELLED')
    expect(cobros).toHaveLength(0)
    expect(fichas).toHaveLength(0)
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).status).toBe('AVAILABLE')
  })

  it('una persona sin StaffVenue activo en la sucursal de la dirección → 403 del middleware, aunque su token sea de otra', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const cuerpo = ventaDe(sim.serialNumber)

    const res = await vender(cuerpo, otraSucursalId)

    expect(res.status).toBe(403)
    expect(await prisma.ventaDeCampo.count({ where: { llave: cuerpo.llave } })).toBe(0)
  })
})

describe('la venta de la PAX no cambia', () => {
  it('POST /tpv/serialized-inventory/sell y su cobro responden igual que antes con el cuerpo de una TPV', async () => {
    const sim = await nuevaSim(categoriaDeCaja)
    const fichasAntes = await prisma.ventaDeCampo.count({ where: { venueId } })

    const venta = await request(server)
      .post('/api/v1/tpv/serialized-inventory/sell')
      .set('Authorization', `Bearer ${token()}`)
      .send({ serialNumber: sim.serialNumber, price: 0, isPortabilidad: false })

    expect(venta.status).toBe(201)
    expect(venta.body).toMatchObject({ venueId, status: 'PENDING', paymentStatus: 'PENDING', createdById: promotorId, tableName: null })
    expect(venta.body.orderNumber).toMatch(/^SN\d{5}$/)
    expect(venta.body.items).toHaveLength(1)
    expect(venta.body.items[0].productSku).toBe(sim.serialNumber)

    const cobro = await request(server)
      .post(`/api/v1/tpv/venues/${venueId}/orders/${venta.body.id}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({
        venueId,
        amount: 0,
        tip: 0,
        status: 'COMPLETED',
        method: 'CASH',
        source: 'TPV',
        splitType: 'FULLPAYMENT',
        staffId: promotorId,
        idempotencyKey: randomUUID(),
        serialNumbers: [sim.serialNumber],
        isPortabilidad: false,
      })

    expect(cobro.status).toBe(201)
    expect(cobro.body).toMatchObject({
      success: true,
      message: 'Payment recorded successfully',
      data: { orderId: venta.body.id, method: 'CASH' },
    })
    expect(await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).toMatchObject({
      status: 'SOLD',
      orderItemId: venta.body.items[0].id,
    })
    expect(await prisma.saleVerification.count({ where: { paymentId: cobro.body.data.id, status: 'PENDING' } })).toBe(1)
    expect(await prisma.ventaDeCampo.count({ where: { venueId } })).toBe(fichasAntes)
  })
})
