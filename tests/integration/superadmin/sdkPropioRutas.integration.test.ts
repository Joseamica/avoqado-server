/**
 * La ruta REST del apagador del SDK propio (fase 3, bloque 2a): `PUT …/superadmin/terminals/:terminalId/in-house-sdk`.
 * Lo que un mock no puede probar: el guardia de ROL en los DOS montajes (el legado `/dashboard/superadmin` sólo pide
 * `system:manage`, que se puede delegar), que quien firma la bitácora es la sesión y no el cuerpo, y que prender no cambia la
 * respuesta de `/settings`. Postgres real; series ficticias AVQD-99000002xx (otros archivos usan otros rangos).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/superadmin/sdkPropioRutas.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import type { Express } from 'express'
import { TerminalType } from '@prisma/client'

jest.mock('connect-pg-simple', () => (session: typeof import('express-session')) => session.MemoryStore)
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  __esModule: true,
  default: { getServer: () => null, getBroadcastingService: () => null },
}))
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmail: jest.fn().mockResolvedValue(true) } }))
jest.mock('@/services/alerts/opsAlert.service', () => ({ sendOpsAlert: jest.fn().mockResolvedValue(true) }))

const NUEVO = '/api/v1/superadmin/terminals'
const LEGADO = '/api/v1/dashboard/superadmin/terminals'

let prisma: typeof import('@/utils/prismaClient').default
let appModule: typeof import('@/app')
let app: Express
const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string | undefined
let superadminId: string | undefined
let duenoId: string | undefined
let blumonId: string
let proveedorPropio: string | undefined
let tokenSuperadmin: string
let tokenDueno: string
const terminalIds: string[] = []
const merchantIds: string[] = []
let consecutivo = 200
const nuevaSerie = () => `AVQD-99000${String(consecutivo++).padStart(5, '0')}` // AVQD-9900000200 … 299

beforeAll(async () => {
  prisma = require('@/utils/prismaClient').default
  appModule = require('@/app')
  app = appModule.default

  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `sdk-rutas-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `sdk-rutas-${sufijo}` } })).id
  const existente = await prisma.paymentProvider.findUnique({ where: { code: 'BLUMON' } })
  blumonId =
    existente?.id ??
    (proveedorPropio = (
      await prisma.paymentProvider.create({ data: { code: 'BLUMON', name: 'Blumon', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
    ).id)
  superadminId = (
    await prisma.staff.create({ data: { email: `sdk-rutas-sa-${sufijo}@example.test`, firstName: 'Prueba', lastName: 'Soporte' } })
  ).id
  duenoId = (await prisma.staff.create({ data: { email: `sdk-rutas-ow-${sufijo}@example.test`, firstName: 'Prueba', lastName: 'Dueña' } }))
    .id
  // La dueña tiene `system:manage` DE VERDAD: el guardia de permiso del montaje legado la deja pasar, y sólo el de rol la frena.
  await prisma.venueRolePermission.create({ data: { venueId, role: 'OWNER', permissions: ['system:manage'], modifiedBy: superadminId } })
  const firmar = async (staffId: string, role: 'SUPERADMIN' | 'OWNER') => {
    await prisma.staffVenue.create({ data: { venueId: venueId!, staffId, role } })
    const sesion = await prisma.session.create({ data: { venueId: venueId!, staffId, authMethod: 'PASSWORD' } })
    return jwt.sign({ sub: staffId, orgId, venueId, role, sid: sesion.id }, process.env.ACCESS_TOKEN_SECRET!, {
      expiresIn: '15m',
      algorithm: 'HS256',
    })
  }
  tokenSuperadmin = await firmar(superadminId, 'SUPERADMIN')
  tokenDueno = await firmar(duenoId, 'OWNER')
})

afterEach(async () => {
  await prisma.activityLog.deleteMany({ where: { entity: 'Terminal', entityId: { in: terminalIds } } })
  await prisma.terminal.deleteMany({ where: { id: { in: terminalIds } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: merchantIds } } })
  terminalIds.length = 0
  merchantIds.length = 0
})

afterAll(async () => {
  appModule?.detenerMonitorDeEventLoop()
  appModule?.getAppEventLoopHistogram().disable()
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.session.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venueRolePermission.deleteMany({ where: { venueId } })
  }
  await prisma.staff.deleteMany({ where: { id: { in: [superadminId, duenoId].filter((id): id is string => !!id) } } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  if (proveedorPropio) await prisma.paymentProvider.deleteMany({ where: { id: proveedorPropio } })
})

/** Una PAX con serie física y una afiliación de Blumon activa asignada: elegible. Sin Blumon: no elegible. */
async function pax({ conBlumon = true } = {}) {
  const assignedMerchantIds: string[] = []
  if (conBlumon) {
    const m = await prisma.merchantAccount.create({
      data: {
        providerId: blumonId,
        externalMerchantId: `sdk-rutas-${sufijo}-${merchantIds.length}`,
        credentialsEncrypted: {},
        active: true,
      },
    })
    merchantIds.push(m.id)
    assignedMerchantIds.push(m.id)
  }
  const t = await prisma.terminal.create({
    data: {
      venueId: venueId!,
      name: 'Caja 1',
      type: TerminalType.TPV_ANDROID,
      brand: 'PAX',
      serialNumber: nuevaSerie(),
      assignedMerchantIds,
    },
  })
  terminalIds.push(t.id)
  return t
}

const poner = (base: string, terminalId: string, body: Record<string, unknown>, token = tokenSuperadmin) =>
  request(app).put(`${base}/${terminalId}/in-house-sdk`).set('Authorization', `Bearer ${token}`).send(body)
const columna = async (id: string) =>
  (await prisma.terminal.findUniqueOrThrow({ where: { id }, select: { inHouseSdkEnabled: true } })).inHouseSdkEnabled

describe('PUT /terminals/:terminalId/in-house-sdk', () => {
  it('SUPERADMIN por /api/v1/superadmin/… con la serie correcta ⇒ 200 y la columna cambia', async () => {
    const t = await pax()

    const respuesta = await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber, reason: 'Piloto del motor propio' })

    expect(respuesta.status).toBe(200)
    expect(respuesta.body).toEqual({ data: { enabled: true, changed: true } })
    expect(await columna(t.id)).toBe(true)
    // Quien firma es la sesión y la procedencia la pone el servidor, nunca el cuerpo.
    const asientos = await prisma.activityLog.findMany({ where: { entity: 'Terminal', entityId: t.id }, take: 5 })
    expect(asientos).toHaveLength(1)
    expect(asientos[0]).toMatchObject({ action: 'TERMINAL_IN_HOUSE_SDK_ENABLED', staffId: superadminId, venueId })
    expect(asientos[0].data).toMatchObject({
      procedencia: 'superadmin-rest',
      reason: 'Piloto del motor propio',
      serialNumber: t.serialNumber,
    })

    // Repetir no es error ni dice que cambió.
    const otraVez = await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber })
    expect(otraVez.status).toBe(200)
    expect(otraVez.body).toEqual({ data: { enabled: true, changed: false } })
  })

  it('SUPERADMIN por /api/v1/dashboard/superadmin/… ⇒ 200', async () => {
    const t = await pax()

    const respuesta = await poner(LEGADO, t.id, { enabled: true, serialNumber: t.serialNumber })

    expect(respuesta.status).toBe(200)
    expect(respuesta.body).toEqual({ data: { enabled: true, changed: true } })
    expect(await columna(t.id)).toBe(true)

    const apagar = await poner(LEGADO, t.id, { enabled: false })
    expect(apagar.status).toBe(200)
    expect(apagar.body).toEqual({ data: { enabled: false, changed: true } })
    expect(await columna(t.id)).toBe(false)
  })

  it('un OWNER con system:manage otorgado, por el montaje legado ⇒ 403; la columna no cambia', async () => {
    const t = await pax()
    // El permiso otorgado sí la deja pasar el guardia del montaje legado: una ruta hermana sin guardia de rol le contesta.
    const ficha = await request(app).get(`${LEGADO}/${t.id}`).set('Authorization', `Bearer ${tokenDueno}`)
    expect(ficha.status).toBe(200)

    const respuesta = await poner(LEGADO, t.id, { enabled: true, serialNumber: t.serialNumber }, tokenDueno)

    // Quien dijo que no es `authorizeRole`, no `checkPermission` (que diría «Permission 'system:manage' required»).
    expect(respuesta.status).toBe(403)
    expect(respuesta.body).toEqual({ error: 'Forbidden', message: 'Acceso denegado. Se requiere uno de los siguientes roles: SUPERADMIN.' })
    expect(await columna(t.id)).toBe(false)
  })

  it('prender sin serialNumber ⇒ 400', async () => {
    const t = await pax()

    const respuesta = await poner(NUEVO, t.id, { enabled: true })

    expect(respuesta.status).toBe(400)
    expect(respuesta.body.message).toContain('Para prender, manda la serie que ves en la ficha')
    expect(await columna(t.id)).toBe(false)
  })

  it('prender con una serie distinta ⇒ 409 TERMINAL_SERIAL_MISMATCH', async () => {
    const t = await pax()

    const respuesta = await poner(NUEVO, t.id, { enabled: true, serialNumber: 'AVQD-9900000299' })

    expect(respuesta.status).toBe(409)
    expect(respuesta.body.code).toBe('TERMINAL_SERIAL_MISMATCH')
    expect(await columna(t.id)).toBe(false)
  })

  it('no elegible ⇒ 409 TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK', async () => {
    const t = await pax({ conBlumon: false })

    const respuesta = await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber })

    expect(respuesta.status).toBe(409)
    expect(respuesta.body.code).toBe('TERMINAL_NOT_ELIGIBLE_FOR_IN_HOUSE_SDK')
    expect(respuesta.body.message).toBe('No tiene una afiliación de Blumon activa que le llegue a la terminal')
    expect(await columna(t.id)).toBe(false)
  })

  it('cuerpo con una llave de más ⇒ 400', async () => {
    const t = await pax()

    const respuesta = await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber, staffId: duenoId, procedencia: 'mcp' })

    expect(respuesta.status).toBe(400)
    expect(await columna(t.id)).toBe(false)
    expect(await prisma.activityLog.count({ where: { entity: 'Terminal', entityId: t.id } })).toBe(0)
  })
})

describe('lo que ya existía', () => {
  it('GET /terminals/:terminalId ⇒ la ficha trae inHouseSdkEnabled', async () => {
    const t = await pax()
    const antes = await request(app).get(`${NUEVO}/${t.id}`).set('Authorization', `Bearer ${tokenSuperadmin}`)
    expect(antes.status).toBe(200)
    expect(antes.body.data.inHouseSdkEnabled).toBe(false)

    expect((await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber })).status).toBe(200)

    const despues = await request(app).get(`${NUEVO}/${t.id}`).set('Authorization', `Bearer ${tokenSuperadmin}`)
    expect(despues.body.data.inHouseSdkEnabled).toBe(true)
  })

  it('GET /terminals/:terminalId/settings ⇒ la MISMA respuesta que antes de prender (toEqual)', async () => {
    const t = await pax()
    const leer = () => request(app).get(`${NUEVO}/${t.id}/settings`).set('Authorization', `Bearer ${tokenSuperadmin}`)
    const antes = await leer()
    expect(antes.status).toBe(200)

    expect((await poner(NUEVO, t.id, { enabled: true, serialNumber: t.serialNumber })).status).toBe(200)

    const despues = await leer()
    expect(despues.status).toBe(200)
    expect(despues.body).toEqual(antes.body)
  })
})
