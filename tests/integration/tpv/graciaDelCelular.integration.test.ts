/**
 * La gracia del celular desvinculado y «por revisar» (App de campo, bloque 1, Tarea 7) por la RUTA real y contra Postgres
 * REAL: el latido deja las huellas, desvincular las congela y `POST /tpv/campo/gracia` aplica (o retiene) con los MISMOS
 * servicios de la ruta normal. Lo que el unit no puede probar: que lo aplicado en gracia deja en la base lo mismo que la ruta
 * normal, que una venta a medias (ficha EN_CURSO) se TERMINA sin duplicar, y que «Aplicar» vende de verdad.
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   AVQ_TREE=<worktree> ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration \
 *     --testPathPattern "tpv/graciaDelCelular" --detectOpenHandles=false --ci
 */
import type { Server } from 'http'
import { randomUUID } from 'crypto'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { CABECERA_CREDENCIAL } from '@/services/tpv/campo/celular/credencial'
import { desvincularCelular } from '@/services/tpv/campo/celular/desvincularCelular.service'
import { huellaDelEnvio, TipoDeEnvio } from '@/services/tpv/campo/celular/envioDeCampo'
import { listarRetenidos, resolverRetenido } from '@/services/tpv/campo/celular/graciaDelCelular.service'
import { moduleService } from '@/services/modules/module.service'
import * as pagos from '@/services/tpv/payment.tpv.service'
import { crearCelularConSesion } from '../../helpers/celularDeCampo'

jest.setTimeout(120000)

const sufijo = randomUUID().slice(0, 8)
let server: Server
let orgId: string
let venueId: string
let promotorId: string
let supervisorId: string
let categoriaDeCaja: string

let consecutivo = 0
async function nuevaSim() {
  consecutivo += 1
  const serialNumber = `8953${String(Date.now()).slice(-9)}${String(consecutivo).padStart(6, '0')}`
  return prisma.serializedItem.create({
    data: {
      venueId,
      categoryId: categoriaDeCaja,
      serialNumber,
      createdBy: promotorId,
      custodyState: 'PROMOTER_HELD',
      assignedPromoterId: promotorId,
    },
  })
}
const ventaDe = (serialNumber: string) => ({ llave: randomUUID(), serialNumber, precioVisto: 0 })

/** Un celular vinculado con su sesión: su latido reporta `huellas` y luego se desvincula (la foto queda congelada). */
async function celularQueReportaYSeDesvincula(huellas: string[], antes?: (token: string, celularId: string) => Promise<void>) {
  const c = await crearCelularConSesion({ staffId: promotorId, organizationId: orgId, venueId, role: 'CASHIER' })
  if (antes) await antes(c.token, c.celular.id)
  const latido = await request(server)
    .post('/api/v1/tpv/campo/latido')
    .set(CABECERA_CREDENCIAL, c.credencial)
    .send({ porSubir: { total: huellas.length }, huellas })
  expect(latido.status).toBe(200)
  await desvincularCelular({ celularId: c.celular.id, organizationId: orgId, motivo: 'CELULAR', porStaffId: promotorId })
  return c
}
const enGracia = (credencial: string, tipo: TipoDeEnvio, cuerpoJson: string) =>
  request(server).post('/api/v1/tpv/campo/gracia').set(CABECERA_CREDENCIAL, credencial).send({ tipo, venueId, cuerpoJson })

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
      data: { name: `Gracia ${sufijo}`, email: `gracia-${sufijo}@example.test`, phone: '5500000000', simCustodyEnforcementMode: 'ENFORCE' },
    })
  ).id
  venueId = (
    await prisma.venue.create({ data: { organizationId: orgId, name: `Gracia ${sufijo}`, slug: `gracia-${sufijo}`, status: 'ACTIVE' } })
  ).id
  const persona = (email: string, firstName: string, role: 'CASHIER' | 'MANAGER') =>
    prisma.staff.create({
      data: {
        email,
        firstName,
        lastName: 'Gracia',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role, active: true } },
      },
    })
  promotorId = (await persona(`gracia-promotor-${sufijo}@example.test`, 'Promotor', 'CASHIER')).id
  supervisorId = (await persona(`gracia-supervisor-${sufijo}@example.test`, 'Supervisor', 'MANAGER')).id
  categoriaDeCaja = (await prisma.itemCategory.create({ data: { venueId, name: 'Chip de caja', suggestedPrice: 0 } })).id
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})

beforeEach(() => jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true))
afterEach(() => jest.restoreAllMocks())

afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
  const personas = [promotorId, supervisorId]
  await prisma.envioRetenidoDeCampo.deleteMany({ where: { organizationId: orgId } })
  await prisma.ventaDeCampo.deleteMany({ where: { venueId } })
  await prisma.celularDeCampo.deleteMany({ where: { organizationId: orgId } })
  await prisma.refreshGrant.deleteMany({ where: { session: { staffId: { in: personas } } } })
  await prisma.session.deleteMany({ where: { staffId: { in: personas } } })
  await prisma.activityLog.deleteMany({ where: { OR: [{ venueId }, { organizationId: orgId }] } })
  await prisma.saleVerification.deleteMany({ where: { venueId } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.serializedItem.deleteMany({ where: { venueId } })
  await prisma.orderAction.deleteMany({ where: { order: { venueId } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.itemCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staffOrganization.deleteMany({ where: { organizationId: orgId } })
  await prisma.staff.deleteMany({ where: { id: { in: personas } } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

describe('POST /tpv/campo/gracia', () => {
  it('una venta reportada sube por gracia y queda IGUAL que por la ruta normal; su evidencia (por ventaLlave) también entra', async () => {
    const sim = await nuevaSim()
    const cuerpoJson = JSON.stringify(ventaDe(sim.serialNumber))
    const { llave } = JSON.parse(cuerpoJson)
    const { credencial, celular } = await celularQueReportaYSeDesvincula([huellaDelEnvio('VENTA', venueId, cuerpoJson)])

    const res = await enGracia(credencial, 'VENTA', cuerpoJson)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ repetida: false, precio: '0.00', aplicadoEnGracia: true, paymentId: expect.any(String) })
    const { ordenes, cobros, fichas, evidencias } = await filas(sim.serialNumber, llave)
    expect(ordenes).toHaveLength(1)
    expect(ordenes[0]).toMatchObject({ id: res.body.orderId, paymentStatus: 'PAID', createdById: promotorId, terminalId: null })
    expect(cobros).toHaveLength(1)
    expect(cobros[0]).toMatchObject({ id: res.body.paymentId, method: 'CASH', status: 'COMPLETED' })
    expect(Number(cobros[0].amount)).toBe(0)
    expect((await prisma.serializedItem.findUniqueOrThrow({ where: { id: sim.id } })).status).toBe('SOLD')
    expect(evidencias).toHaveLength(1)
    expect(evidencias[0]).toMatchObject({ status: 'PENDING', staffId: promotorId, serialNumbers: [sim.serialNumber] })
    expect(fichas[0]).toMatchObject({ estado: 'COMPLETA', celularId: celular.id })
    // No se retuvo: su desenlace queda por huella (fuera de «sin resolver»), y el reintento lo recibe igual.
    expect(await prisma.envioRetenidoDeCampo.findMany({ where: { celularId: celular.id } })).toEqual([
      expect.objectContaining({
        estado: 'APLICADO',
        motivo: 'APLICADO_EN_GRACIA',
        resultado: expect.objectContaining({ paymentId: res.body.paymentId }),
      }),
    ])
    const otraVez = await enGracia(credencial, 'VENTA', cuerpoJson)
    expect(otraVez.status).toBe(200)
    expect(otraVez.body).toEqual({ resuelto: 'APLICADO', resultado: expect.objectContaining({ paymentId: res.body.paymentId }) })
    const sinResolver = await listarRetenidos(orgId, { estado: ['PENDIENTE', 'APLICANDO'], page: 1, pageSize: 50 })
    expect(sinResolver.items.some(i => i.resumen.includes(sim.serialNumber))).toBe(false)

    // La evidencia nombra la venta por su llave (el celular desvinculado nunca supo el pago).
    const foto = `https://firebasestorage.googleapis.com/v0/b/prueba/o/venues%2F${venueId}%2Fgracia.jpg`
    const ev = await enGracia(credencial, 'EVIDENCIA', JSON.stringify({ ventaLlave: llave, photoUrls: [foto] }))
    expect(ev.status).toBe(200)
    expect(ev.body).toMatchObject({ success: true, aplicadoEnGracia: true })
    expect((await prisma.saleVerification.findUniqueOrThrow({ where: { id: evidencias[0].id } })).photos).toEqual([foto])
  })

  it('una ficha EN_CURSO creada antes de desvincular + la gracia con el mismo cuerpo → UNA orden, UN cobro y la ficha COMPLETA', async () => {
    const sim = await nuevaSim()
    const cuerpo = ventaDe(sim.serialNumber)
    const cuerpoJson = JSON.stringify(cuerpo)
    const { credencial } = await celularQueReportaYSeDesvincula([huellaDelEnvio('VENTA', venueId, cuerpoJson)], async token => {
      // Por la ruta normal: la orden se crea y el cobro se cae (la ficha queda a medias).
      jest.spyOn(pagos, 'recordOrderPayment').mockRejectedValueOnce(new Error('se cortó la conexión'))
      const caida = await request(server)
        .post(`/api/v1/tpv/campo/venues/${venueId}/ventas`)
        .set('Authorization', `Bearer ${token}`)
        .send(cuerpo)
      expect(caida.status).toBe(500)
      const aMedias = await filas(sim.serialNumber, cuerpo.llave)
      expect(aMedias.fichas[0]).toMatchObject({ estado: 'EN_CURSO', paymentId: null })
      expect(aMedias.ordenes).toHaveLength(1)
    })

    const res = await enGracia(credencial, 'VENTA', cuerpoJson)

    expect(res.status).toBe(201)
    const { ordenes, cobros, fichas } = await filas(sim.serialNumber, cuerpo.llave)
    expect(ordenes).toHaveLength(1)
    expect(cobros).toHaveLength(1)
    expect(cobros[0].orderId).toBe(ordenes[0].id)
    expect(fichas).toHaveLength(1)
    expect(fichas[0]).toMatchObject({ estado: 'COMPLETA', paymentId: cobros[0].id })
  })

  it('una no reportada queda en «por revisar»; «Aplicar» la vende y la gracia con esa huella devuelve el paymentId', async () => {
    const sim = await nuevaSim()
    const cuerpoJson = JSON.stringify(ventaDe(sim.serialNumber))
    const { llave } = JSON.parse(cuerpoJson)
    const { credencial, celular } = await celularQueReportaYSeDesvincula([]) // su latido no la traía

    const retenida = await enGracia(credencial, 'VENTA', cuerpoJson)
    expect(retenida.status).toBe(202)
    expect(retenida.body).toEqual({ retenido: true, motivo: 'NO_REPORTADA' })
    expect((await filas(sim.serialNumber, llave)).ordenes).toHaveLength(0)
    expect((await enGracia(credencial, 'VENTA', cuerpoJson)).body).toEqual({ retenido: true, motivo: 'NO_REPORTADA', repetida: true })

    const { items, total } = await listarRetenidos(orgId, { estado: ['PENDIENTE', 'APLICANDO'], page: 1, pageSize: 50 })
    const fila = items.find(i => i.staffId === promotorId && i.resumen.includes(sim.serialNumber))
    expect(fila).toMatchObject({
      tipo: 'VENTA',
      motivo: 'NO_REPORTADA',
      estado: 'PENDIENTE',
      nombre: 'Promotor Gracia',
      sucursal: `Gracia ${sufijo}`,
    })
    expect(total).toBeGreaterThanOrEqual(1)

    const aplicada = await resolverRetenido({ retenidoId: fila!.id, organizationId: orgId, accion: 'APLICAR', porStaffId: supervisorId })
    expect(aplicada).toMatchObject({ estado: 'APLICADO', repetida: false, resultado: { paymentId: expect.any(String) } })
    const { ordenes, cobros, fichas } = await filas(sim.serialNumber, llave)
    expect([ordenes.length, cobros.length]).toEqual([1, 1])
    expect(fichas[0]).toMatchObject({ estado: 'COMPLETA', celularId: celular.id, staffId: promotorId })
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila!.id } })).toMatchObject({
      estado: 'APLICADO',
      resueltoPor: supervisorId,
    })

    const despues = await enGracia(credencial, 'VENTA', cuerpoJson)
    expect(despues.status).toBe(200)
    expect(despues.body).toEqual({ resuelto: 'APLICADO', resultado: expect.objectContaining({ paymentId: cobros[0].id }) })
    // «Aplicar» repetido no vende otra vez.
    expect(
      await resolverRetenido({ retenidoId: fila!.id, organizationId: orgId, accion: 'APLICAR', porStaffId: supervisorId }),
    ).toMatchObject({
      repetida: true,
    })
    expect((await filas(sim.serialNumber, llave)).cobros).toHaveLength(1)
  })

  it('una sucursal de otra organización → 403 OTRA_ORGANIZACION sin retener; vinculado y activo → 409 USA_TU_SESION', async () => {
    const { credencial, celular } = await celularQueReportaYSeDesvincula([])
    const otra = await request(server)
      .post('/api/v1/tpv/campo/gracia')
      .set(CABECERA_CREDENCIAL, credencial)
      .send({ tipo: 'VENTA', venueId: 'no-existe', cuerpoJson: '{}' })
    expect(otra.status).toBe(403)
    expect(otra.body).toMatchObject({ code: 'OTRA_ORGANIZACION' })
    expect(await prisma.envioRetenidoDeCampo.count({ where: { celularId: celular.id } })).toBe(0)

    const vivo = await crearCelularConSesion({ staffId: promotorId, organizationId: orgId, venueId, role: 'CASHIER' })
    const r = await enGracia(vivo.credencial, 'VENTA', JSON.stringify(ventaDe('X')))
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'USA_TU_SESION' })
    await desvincularCelular({ celularId: vivo.celular.id, organizationId: orgId, motivo: 'CELULAR', porStaffId: promotorId })
  })
})
