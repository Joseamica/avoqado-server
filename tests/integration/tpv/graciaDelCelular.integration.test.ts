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
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { CABECERA_CREDENCIAL } from '@/services/tpv/campo/celular/credencial'
import { desvincularCelular } from '@/services/tpv/campo/celular/desvincularCelular.service'
import { aplicarEnvio, huellaDelEnvio, TipoDeEnvio } from '@/services/tpv/campo/celular/envioDeCampo'
import { listarRetenidos, resolverRetenido, VENTANA_EN_VUELO_MS } from '@/services/tpv/campo/celular/graciaDelCelular.service'
import { generateAccessToken } from '@/jwt.service'
import { aceptarCustodiaDeCampo } from '@/services/tpv/campo/custodiaDeCampo.service'
import { moduleService } from '@/services/modules/module.service'
import * as pagos from '@/services/tpv/payment.tpv.service'
import * as ventasDeCampo from '@/services/tpv/campo/ventaDeCampo.service'
import { logAction } from '@/services/dashboard/activity-log.service'
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
/** El `updatedAt` de una APLICANDO cuyo proceso murió (I2): más vieja que la ventana en vuelo, nadie la tiene. */
const vencida = () => new Date(Date.now() - VENTANA_EN_VUELO_MS - 60_000)

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

beforeEach(() => {
  jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(true)
  // La gracia decide la baja con las sucursales de CAMPO (T7): aquí la sucursal tiene el módulo.
  jest.spyOn(moduleService, 'venuesWithModule').mockImplementation(async ids => new Set(ids))
})
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
    // Con sus campos de captura (S9): son la llave de idempotencia de la foto.
    const captura = { captureSeq: 1, captureDeviceId: celular.id, idempotencyKey: randomUUID(), capturedAt: new Date().toISOString() }
    // Sin destino estable (T3) → 400: agregada al final, repetirla la pondría otra vez.
    const alFinal = await enGracia(credencial, 'EVIDENCIA', JSON.stringify({ ventaLlave: llave, photoUrls: [foto], ...captura }))
    expect(alFinal.status).toBe(400)
    expect(alFinal.body).toMatchObject({ code: 'CUERPO_INVALIDO' })
    const evidenciaJson = JSON.stringify({ ventaLlave: llave, photoUrls: [foto], photoLabel: 'Vinculacion', ...captura })
    const ev = await enGracia(credencial, 'EVIDENCIA', evidenciaJson)
    expect(ev.status).toBe(200)
    expect(ev.body).toMatchObject({ success: true, aplicadoEnGracia: true })
    expect((await prisma.saleVerification.findUniqueOrThrow({ where: { id: evidencias[0].id } })).photos).toEqual([foto])

    // El proceso cayó tras subir la foto y antes de guardar el desenlace (la fila sigue APLICANDO): el reintento ve la captura
    // en la verificación (T1) y queda APLICADO, sin otra foto.
    const filaEv = await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: celular.id, tipo: 'EVIDENCIA' } })
    await prisma.envioRetenidoDeCampo.update({
      where: { id: filaEv.id },
      data: { estado: 'APLICANDO', resultado: Prisma.DbNull, resueltoAt: null, updatedAt: vencida() },
    })
    const otra = await enGracia(credencial, 'EVIDENCIA', evidenciaJson)
    expect(otra.status).toBe(200)
    expect(otra.body).toMatchObject({ resuelto: 'APLICADO', resultado: { verificationId: evidencias[0].id, recuperado: true } })
    expect((await prisma.saleVerification.findUniqueOrThrow({ where: { id: evidencias[0].id } })).photos).toEqual([foto])
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: filaEv.id } })).toMatchObject({ estado: 'APLICADO' })
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

  it('S2 · «Aplicar» aceptó la custodia y cayó antes de marcar; la SIM se vendió: «Aplicar» otra vez → APLICADO por la bitácora, no PENDIENTE', async () => {
    consecutivo += 1
    const sim = await prisma.serializedItem.create({
      data: {
        venueId,
        categoryId: categoriaDeCaja,
        serialNumber: `8954${String(Date.now()).slice(-9)}${String(consecutivo).padStart(6, '0')}`,
        createdBy: promotorId,
        custodyState: 'PROMOTER_PENDING',
        assignedPromoterId: promotorId,
        custodyVersion: 1,
      },
    })
    const cuerpo = { sims: [{ serialNumber: sim.serialNumber, custodyVersion: 1 }] }
    const { credencial, celular } = await celularQueReportaYSeDesvincula([])
    const retenido = await enGracia(credencial, 'CUSTODIA_ACEPTAR', JSON.stringify(cuerpo)) // sin huella: por revisar
    expect(retenido.body).toEqual({ retenido: true, motivo: 'NO_REPORTADA' })
    const fila = await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: celular.id, tipo: 'CUSTODIA_ACEPTAR' } })

    // El primer «Aplicar» tomó la fila y aceptó la SIM; el proceso cayó antes de marcarla APLICADO.
    await prisma.envioRetenidoDeCampo.update({ where: { id: fila.id }, data: { estado: 'APLICANDO', updatedAt: vencida() } })
    const aceptada = await aceptarCustodiaDeCampo({ venueId, staffId: promotorId, role: 'CASHIER' }, cuerpo)
    expect(aceptada.body.summary).toMatchObject({ succeeded: 1, failed: 0 })
    // Mientras tanto la SIM se vendió (desde la PAX u otro celular).
    await prisma.serializedItem.update({ where: { id: sim.id }, data: { custodyState: 'SOLD' } })

    const r = await resolverRetenido({ retenidoId: fila.id, organizationId: orgId, accion: 'APLICAR', porStaffId: supervisorId })
    expect(r.estado).toBe('APLICADO')
    expect(r.resultado).toMatchObject({
      recuperadoDeLaBitacora: true,
      eventos: [expect.objectContaining({ serialNumber: sim.serialNumber })],
    })
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({ estado: 'APLICADO' })
    await prisma.serializedItemCustodyEvent.deleteMany({ where: { serializedItemId: sim.id } })
  })

  it('R2-1 · la ruta normal aceptó la custodia y se perdió la respuesta; la SIM se vendió y se desvinculó: la gracia → APLICADO, no PENDIENTE', async () => {
    consecutivo += 1
    const sim = await prisma.serializedItem.create({
      data: {
        venueId,
        categoryId: categoriaDeCaja,
        serialNumber: `8955${String(Date.now()).slice(-9)}${String(consecutivo).padStart(6, '0')}`,
        createdBy: supervisorId,
        custodyState: 'PROMOTER_PENDING',
        assignedPromoterId: promotorId,
        custodyVersion: 2,
      },
    })
    // La asignación que le dio la versión 2 (la bitácora de custodia no guarda la versión: es el límite inferior).
    await prisma.serializedItemCustodyEvent.create({
      data: {
        serializedItemId: sim.id,
        serialNumber: sim.serialNumber,
        eventType: 'ASSIGNED_TO_PROMOTER',
        fromState: 'SUPERVISOR_HELD',
        toState: 'PROMOTER_PENDING',
        fromStaffId: supervisorId,
        toStaffId: promotorId,
        actorStaffId: supervisorId,
        createdAt: new Date(Date.now() - 60_000),
      },
    })
    const cuerpo = { sims: [{ serialNumber: sim.serialNumber, custodyVersion: 2 }] }
    const cuerpoJson = JSON.stringify(cuerpo)
    const { credencial, celular } = await celularQueReportaYSeDesvincula(
      [huellaDelEnvio('CUSTODIA_ACEPTAR', venueId, cuerpoJson)],
      async token => {
        // Por la ruta normal: la aceptó el servidor, pero el celular no supo la respuesta (sigue en su cola).
        const normal = await request(server)
          .post(`/api/v1/tpv/campo/venues/${venueId}/custodia/aceptar`)
          .set('Authorization', `Bearer ${token}`)
          .send(cuerpo)
        expect(normal.status).toBe(200)
        expect(normal.body.summary).toMatchObject({ succeeded: 1 })
      },
    )
    // Después la SIM se vendió desde la PAX.
    await prisma.serializedItem.update({ where: { id: sim.id }, data: { custodyState: 'SOLD' } })

    const r = await enGracia(credencial, 'CUSTODIA_ACEPTAR', cuerpoJson)

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      resuelto: 'APLICADO',
      resultado: { recuperadoDeLaBitacora: true, eventos: [expect.objectContaining({ serialNumber: sim.serialNumber })] },
    })
    const fila = await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: celular.id, tipo: 'CUSTODIA_ACEPTAR' } })
    expect(fila).toMatchObject({ estado: 'APLICADO', motivo: 'APLICADO_EN_GRACIA' })
    await expect(
      resolverRetenido({ retenidoId: fila.id, organizationId: orgId, accion: 'DESCARTAR', porStaffId: supervisorId }),
    ).rejects.toMatchObject({ code: 'YA_APLICADO' })
    await prisma.serializedItemCustodyEvent.deleteMany({ where: { serializedItemId: sim.id } })
  })

  it('R2-2 · una entrada a medias (APLICANDO, sin checada) + la persona dada de baja + el reintento → ninguna checada; PENDIENTE PERSONA_DADA_DE_BAJA', async () => {
    const otra = await prisma.staff.create({
      data: {
        email: `gracia-baja-${sufijo}@example.test`,
        firstName: 'Baja',
        lastName: 'Gracia',
        organizations: { create: { organizationId: orgId, role: 'MEMBER', isPrimary: true, isActive: true } },
        venues: { create: { venueId, role: 'CASHIER', active: true } },
      },
    })
    try {
      const llave = randomUUID()
      const cuerpoJson = JSON.stringify({ llave })
      const huella = huellaDelEnvio('ENTRADA', venueId, cuerpoJson)
      const c = await crearCelularConSesion({ staffId: otra.id, organizationId: orgId, venueId, role: 'CASHIER' })
      const latido = await request(server)
        .post('/api/v1/tpv/campo/latido')
        .set(CABECERA_CREDENCIAL, c.credencial)
        .send({ porSubir: { total: 1 }, huellas: [huella] })
      expect(latido.status).toBe(200)
      await desvincularCelular({ celularId: c.celular.id, organizationId: orgId, motivo: 'CELULAR', porStaffId: otra.id })
      // La gracia la admitió y dejó su fila APLICANDO, y el proceso cayó ANTES de crear la checada.
      await prisma.envioRetenidoDeCampo.create({
        data: {
          organizationId: orgId,
          celularId: c.celular.id,
          staffId: otra.id,
          venueId,
          tipo: 'ENTRADA',
          huella,
          cuerpoJson,
          motivo: 'APLICADO_EN_GRACIA',
          estado: 'APLICANDO',
          updatedAt: vencida(), // el proceso cayó hace rato: ya no está en vuelo (I2)
        },
      })
      await prisma.staffVenue.updateMany({ where: { staffId: otra.id }, data: { active: false } }) // la dieron de baja

      const r = await enGracia(c.credencial, 'ENTRADA', cuerpoJson)

      expect(r.status).toBe(202)
      expect(r.body).toEqual({ retenido: true, motivo: 'PERSONA_DADA_DE_BAJA' })
      expect(await prisma.timeEntry.count({ where: { staffId: otra.id } })).toBe(0)
      expect(await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: c.celular.id } })).toMatchObject({
        estado: 'PENDIENTE',
        motivo: 'PERSONA_DADA_DE_BAJA',
      })
    } finally {
      await prisma.envioRetenidoDeCampo.deleteMany({ where: { staffId: otra.id } })
      await prisma.celularDeCampo.deleteMany({ where: { staffId: otra.id } })
      await prisma.refreshGrant.deleteMany({ where: { session: { staffId: otra.id } } })
      await prisma.session.deleteMany({ where: { staffId: otra.id } })
      await prisma.timeEntry.deleteMany({ where: { staffId: otra.id } })
      await prisma.staffVenue.deleteMany({ where: { staffId: otra.id } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: otra.id } })
      await prisma.staff.delete({ where: { id: otra.id } })
    }
  })
})

describe('arreglo final 4 · el desenlace de un retenido (I1–I4) por la ruta real', () => {
  let tokenDelPanel: string
  beforeAll(async () => {
    const sid = (
      await prisma.session.create({ data: { staffId: supervisorId, venueId, deviceId: `panel-${sufijo}`, authMethod: 'PASSWORD' } })
    ).id
    tokenDelPanel = generateAccessToken(supervisorId, orgId, venueId, 'MANAGER', false, { sid })
  })
  const desdeElPanel = (retenidoId: string, accion: 'APLICAR' | 'DESCARTAR') =>
    request(server)
      .post(`/api/v1/dashboard/organizations/${orgId}/celulares-de-campo/retenidos/${retenidoId}/resolver`)
      .set('Authorization', `Bearer ${tokenDelPanel}`)
      .send({ accion })
  /** Una venta COMPLETA por la ruta normal del bloque 0 (la respuesta se perdió: el celular la sigue teniendo por subir). */
  const vendidaPorLaRutaNormal = (cuerpo: ReturnType<typeof ventaDe>) => async (token: string) => {
    const normal = await request(server)
      .post(`/api/v1/tpv/campo/venues/${venueId}/ventas`)
      .set('Authorization', `Bearer ${token}`)
      .send(cuerpo)
    expect(normal.status).toBe(201)
  }
  const retenidoDe = (celularId: string, cuerpoJson: string, datos: Partial<Prisma.EnvioRetenidoDeCampoUncheckedCreateInput>) =>
    prisma.envioRetenidoDeCampo.create({
      data: {
        organizationId: orgId,
        celularId,
        staffId: promotorId,
        venueId,
        tipo: 'VENTA',
        huella: huellaDelEnvio('VENTA', venueId, cuerpoJson),
        cuerpoJson,
        motivo: 'NO_REPORTADA',
        ...datos,
      },
    })

  it('I1 al nacer (R3-1) · una venta COMPLETA por la ruta normal que llega retenida (no reportada) nace APLICADO, no PENDIENTE; un solo cobro', async () => {
    const sim = await nuevaSim()
    const cuerpo = ventaDe(sim.serialNumber)
    const cuerpoJson = JSON.stringify(cuerpo)
    // Su latido no la traía: la gracia la retendría (NO_REPORTADA)… pero ya está hecha.
    const { credencial, celular } = await celularQueReportaYSeDesvincula([], vendidaPorLaRutaNormal(cuerpo))
    const { cobros: antes } = await filas(sim.serialNumber, cuerpo.llave)
    expect(antes).toHaveLength(1)

    const res = await enGracia(credencial, 'VENTA', cuerpoJson)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ resuelto: 'APLICADO', resultado: expect.objectContaining({ paymentId: antes[0].id, recuperado: true }) })
    expect(await prisma.envioRetenidoDeCampo.findMany({ where: { celularId: celular.id } })).toEqual([
      expect.objectContaining({
        estado: 'APLICADO',
        motivo: 'NO_REPORTADA',
        resultado: expect.objectContaining({ paymentId: antes[0].id }),
      }),
    ])
    const { ordenes, cobros } = await filas(sim.serialNumber, cuerpo.llave)
    expect([ordenes.length, cobros.length]).toEqual([1, 1])
    // Nunca aparece en «por revisar».
    const sinResolver = await listarRetenidos(orgId, { estado: ['PENDIENTE', 'APLICANDO'], page: 1, pageSize: 50 })
    expect(sinResolver.items.some(i => i.resumen.includes(sim.serialNumber))).toBe(false)
  })

  it('I1 en «Descartar» · una PENDIENTE cuyo efecto ya existe queda APLICADO y responde { estado: APLICADO, yaEstabaHecho: true }, nunca DESCARTADO', async () => {
    const sim = await nuevaSim()
    const cuerpo = ventaDe(sim.serialNumber)
    const cuerpoJson = JSON.stringify(cuerpo)
    const { celular } = await celularQueReportaYSeDesvincula([], vendidaPorLaRutaNormal(cuerpo))
    const { cobros } = await filas(sim.serialNumber, cuerpo.llave)
    // I6: nació hace más que la ventana (ya se puede descartar).
    const fila = await retenidoDe(celular.id, cuerpoJson, { estado: 'PENDIENTE', createdAt: vencida() })

    const r = await desdeElPanel(fila.id, 'DESCARTAR')

    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({
      estado: 'APLICADO',
      yaEstabaHecho: true,
      repetida: false,
      resultado: expect.objectContaining({ paymentId: cobros[0].id }),
    })
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
      estado: 'APLICADO',
      resueltoPor: supervisorId,
    })
    expect((await filas(sim.serialNumber, cuerpo.llave)).cobros).toHaveLength(1)
  })

  it('I2 · una APLICANDO en vuelo → «Aplicar» y «Descartar» 409 APLICACION_EN_CURSO sin tocarla; vencida (updatedAt explícito en create) «Aplicar» sí la toma', async () => {
    const { celular } = await celularQueReportaYSeDesvincula([])

    // En vuelo: tomada hace un momento por otra ejecución.
    const simA = await nuevaSim()
    const cuerpoA = ventaDe(simA.serialNumber)
    const tomadaAt = new Date(Date.now() - 1000)
    const enVuelo = await retenidoDe(celular.id, JSON.stringify(cuerpoA), { estado: 'APLICANDO', updatedAt: tomadaAt })
    expect(enVuelo.updatedAt.getTime()).toBe(tomadaAt.getTime()) // Prisma respeta el updatedAt explícito en create
    for (const accion of ['APLICAR', 'DESCARTAR'] as const) {
      const r = await desdeElPanel(enVuelo.id, accion)
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({
        code: 'APLICACION_EN_CURSO',
        message: 'Se está aplicando en este momento. Vuelve a intentar en unos minutos.',
      })
    }
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: enVuelo.id } })).toMatchObject({
      estado: 'APLICANDO',
      updatedAt: tomadaAt,
    })
    expect((await filas(simA.serialNumber, cuerpoA.llave)).ordenes).toHaveLength(0)

    // Vencida: el proceso que la tomó murió. «Descartar» no la descarta (sigue sin dueño); «Aplicar» la toma y vende una vez.
    const simB = await nuevaSim()
    const cuerpoB = ventaDe(simB.serialNumber)
    const hace = vencida()
    const huerfana = await retenidoDe(celular.id, JSON.stringify(cuerpoB), { estado: 'APLICANDO', updatedAt: hace })
    expect(huerfana.updatedAt.getTime()).toBe(hace.getTime())
    const descartar = await desdeElPanel(huerfana.id, 'DESCARTAR')
    expect(descartar.status).toBe(409)
    expect(descartar.body).toMatchObject({ code: 'APLICACION_A_MEDIAS' })
    const aplicar = await desdeElPanel(huerfana.id, 'APLICAR')
    expect(aplicar.status).toBe(200)
    expect(aplicar.body.data).toMatchObject({ estado: 'APLICADO', repetida: false, resultado: { paymentId: expect.any(String) } })
    const { ordenes, cobros } = await filas(simB.serialNumber, cuerpoB.llave)
    expect([ordenes.length, cobros.length]).toEqual([1, 1])
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: huerfana.id } })).toMatchObject({
      estado: 'APLICADO',
      resueltoPor: supervisorId,
    })
  })

  it('R3-3 · la evidencia por la gracia con replaceIndex y sin photoLabel → 400 CUERPO_INVALIDO y no se retiene nada', async () => {
    const { credencial, celular } = await celularQueReportaYSeDesvincula([])
    const foto = `https://firebasestorage.googleapis.com/v0/b/prueba/o/venues%2F${venueId}%2Fsin-etiqueta.jpg`
    const captura = { captureSeq: 1, captureDeviceId: celular.id, idempotencyKey: randomUUID(), capturedAt: new Date().toISOString() }

    const r = await enGracia(
      credencial,
      'EVIDENCIA',
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: [foto], replaceIndex: 0, ...captura }),
    )

    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'CUERPO_INVALIDO' })
    expect(await prisma.envioRetenidoDeCampo.count({ where: { celularId: celular.id } })).toBe(0)
  })

  it('I6 (R4-1) · recién nacido: «Descartar» → 409 DESCARTE_MUY_PRONTO sin tocarlo; la venta que venía en camino termina; pasada la ventana «Descartar» la deja APLICADO, un cobro', async () => {
    const sim = await nuevaSim()
    const cuerpo = ventaDe(sim.serialNumber)
    const cuerpoJson = JSON.stringify(cuerpo)
    const { credencial, celular } = await celularQueReportaYSeDesvincula([])
    // Su reenvío por la gracia llega ANTES de que la petición normal cree la ficha: nace PENDIENTE (no reportada).
    const g = await enGracia(credencial, 'VENTA', cuerpoJson)
    expect(g.status).toBe(202)
    const fila = await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: celular.id } })
    expect(fila.estado).toBe('PENDIENTE')

    const pronto = await desdeElPanel(fila.id, 'DESCARTAR')
    expect(pronto.status).toBe(409)
    expect(pronto.body).toMatchObject({
      code: 'DESCARTE_MUY_PRONTO',
      message: 'Este envío acaba de llegar. Espera unos minutos antes de descartarlo: puede que todavía se esté registrando.',
    })
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
      estado: 'PENDIENTE',
      updatedAt: fila.updatedAt,
    })

    // La petición normal, admitida antes de desvincular, termina: el MISMO servicio que su ruta, a nombre de ese celular.
    const normal = await aplicarEnvio({ venueId, orgId, staffId: promotorId, celularId: celular.id }, 'VENTA', cuerpo)
    expect(normal).toMatchObject({ tipo: 'APLICADO', status: 201 })
    const { cobros } = await filas(sim.serialNumber, cuerpo.llave)
    expect(cobros).toHaveLength(1)

    // Pasa la ventana.
    await prisma.envioRetenidoDeCampo.update({ where: { id: fila.id }, data: { createdAt: vencida() } })
    const tarde = await desdeElPanel(fila.id, 'DESCARTAR')
    expect(tarde.status).toBe(200)
    expect(tarde.body.data).toMatchObject({
      estado: 'APLICADO',
      yaEstabaHecho: true,
      resultado: expect.objectContaining({ paymentId: cobros[0].id }),
    })
    expect(await prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila.id } })).toMatchObject({
      estado: 'APLICADO',
      resueltoPor: supervisorId,
    })
    expect((await filas(sim.serialNumber, cuerpo.llave)).cobros).toHaveLength(1)

    // Sin efecto y pasada la ventana, «Descartar» sí descarta.
    const otra = await nuevaSim()
    const sinEfecto = await retenidoDe(celular.id, JSON.stringify(ventaDe(otra.serialNumber)), { createdAt: vencida() })
    const descartada = await desdeElPanel(sinEfecto.id, 'DESCARTAR')
    expect(descartada.status).toBe(200)
    expect(descartada.body.data).toEqual({ estado: 'DESCARTADO', repetida: false })
  })

  it('R4-3 · evidencia por la gracia con photoLabel Portabilidad y replaceIndex 0 (otra ranura) → 400 CUERPO_INVALIDO y no se retiene nada', async () => {
    const { credencial, celular } = await celularQueReportaYSeDesvincula([])
    const foto = `https://firebasestorage.googleapis.com/v0/b/prueba/o/venues%2F${venueId}%2Fcontradice.jpg`
    const captura = { captureSeq: 5, captureDeviceId: celular.id, idempotencyKey: randomUUID(), capturedAt: new Date().toISOString() }

    const r = await enGracia(
      credencial,
      'EVIDENCIA',
      JSON.stringify({ ventaLlave: randomUUID(), photoUrls: [foto], photoLabel: 'Portabilidad', replaceIndex: 0, ...captura }),
    )

    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'CUERPO_INVALIDO' })
    expect(await prisma.envioRetenidoDeCampo.count({ where: { celularId: celular.id } })).toBe(0)
  })

  it('I7 (R5-1) · la venta normal admitida antes de desvincular termina DESPUÉS del descarte: el retenido queda APLICADO, con la bitácora de reversión; un cobro', async () => {
    const sim = await nuevaSim()
    const cuerpo = ventaDe(sim.serialNumber)
    const cuerpoJson = JSON.stringify(cuerpo)
    // La petición normal pasa el candado y se queda esperando (p. ej. el escaneo del inventario) ANTES de crear su ficha.
    const original = ventasDeCampo.registrarVentaDeCampo
    let llego!: () => void
    const yaEntro = new Promise<void>(r => (llego = r))
    let seguir!: () => void
    const puedeSeguir = new Promise<void>(r => (seguir = r))
    jest.spyOn(ventasDeCampo, 'registrarVentaDeCampo').mockImplementationOnce(async (...args) => {
      llego()
      await puedeSeguir
      return original(...args)
    })
    let normal!: Promise<request.Response>
    const { credencial, celular } = await celularQueReportaYSeDesvincula([], async token => {
      normal = request(server)
        .post(`/api/v1/tpv/campo/venues/${venueId}/ventas`)
        .set('Authorization', `Bearer ${token}`)
        .send(cuerpo)
        .then(r => r)
      await yaEntro
    })
    // Su reenvío por la gracia nace PENDIENTE (no reportado, todavía sin ficha); pasa la ventana y el supervisor lo descarta.
    expect((await enGracia(credencial, 'VENTA', cuerpoJson)).status).toBe(202)
    const fila = await prisma.envioRetenidoDeCampo.findFirstOrThrow({ where: { celularId: celular.id } })
    await prisma.envioRetenidoDeCampo.update({ where: { id: fila.id }, data: { createdAt: vencida() } })
    const descarte = await desdeElPanel(fila.id, 'DESCARTAR')
    expect(descarte.status).toBe(200)
    expect(descarte.body.data).toEqual({ estado: 'DESCARTADO', repetida: false })

    // La venta normal termina: su cobro existe, y al contestar 2xx el retenido de ese celular se reconcilia.
    seguir()
    const r = await normal
    expect(r.status).toBe(201)
    const { cobros } = await filas(sim.serialNumber, cuerpo.llave)
    expect(cobros).toHaveLength(1)
    const espera = async <T>(leer: () => Promise<T>, listo: (x: T) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const x = await leer()
        if (listo(x)) return x
        await new Promise(res => setTimeout(res, 50))
      }
      return leer()
    }
    const final = await espera(
      () => prisma.envioRetenidoDeCampo.findUniqueOrThrow({ where: { id: fila.id } }),
      x => x.estado === 'APLICADO',
    )
    expect(final).toMatchObject({ estado: 'APLICADO', resultado: expect.objectContaining({ paymentId: cobros[0].id }) })
    // La bitácora va por `logAction`, que la integración deja mockeado (integration-setup).
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO',
        entityId: fila.id,
        data: expect.objectContaining({ descartadoPor: supervisorId }),
      }),
    )
    expect((await filas(sim.serialNumber, cuerpo.llave)).cobros).toHaveLength(1)
  })
})
