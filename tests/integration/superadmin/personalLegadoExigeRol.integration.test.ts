/**
 * El montaje LEGADO `/api/v1/dashboard/superadmin/…` (todo, desde el encargo fc9c53; antes sólo `/staff`) exige el ROL SUPERADMIN, no sólo el permiso `system:manage`
 * (que se puede delegar). Sin el guardia de rol, una dueña con ese permiso otorgado podía asignarse `SUPERADMIN` por
 * `PATCH …/staff/:staffId/venues/:venueId` y con eso pasar cualquier guardia de rol (p. ej. el del apagador del SDK propio).
 * Postgres real; series ficticias AVQD-99000005xx (otros archivos usan otros rangos).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/superadmin/personalLegadoExigeRol.integration.test.ts --ci
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

const LEGADO = '/api/v1/dashboard/superadmin'

let prisma: typeof import('@/utils/prismaClient').default
let appModule: typeof import('@/app')
let app: Express
const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string | undefined
let superadminId: string | undefined
let duenoId: string | undefined
let meseraId: string | undefined
let terminalId: string | undefined
let tokenSuperadmin: string
let tokenDueno: string

beforeAll(async () => {
  prisma = require('@/utils/prismaClient').default
  appModule = require('@/app')
  app = appModule.default

  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `personal-legado-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `personal-legado-${sufijo}` } }))
    .id
  const persona = async (etiqueta: string, firstName: string) =>
    (await prisma.staff.create({ data: { email: `personal-legado-${etiqueta}-${sufijo}@example.test`, firstName, lastName: 'Prueba' } })).id
  superadminId = await persona('sa', 'Soporte')
  duenoId = await persona('ow', 'Dueña')
  meseraId = await persona('wa', 'Mesera')
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
  await prisma.staffVenue.create({ data: { venueId, staffId: meseraId, role: 'WAITER' } })
  terminalId = (
    await prisma.terminal.create({
      data: { venueId, name: 'Caja 1', type: TerminalType.TPV_ANDROID, brand: 'PAX', serialNumber: 'AVQD-9900000500' },
    })
  ).id
})

afterAll(async () => {
  appModule?.detenerMonitorDeEventLoop()
  appModule?.getAppEventLoopHistogram().disable()
  if (venueId) {
    await prisma.activityLog.deleteMany({ where: { venueId } })
    await prisma.terminal.deleteMany({ where: { venueId } })
    await prisma.session.deleteMany({ where: { venueId } })
    await prisma.staffVenue.deleteMany({ where: { venueId } })
    await prisma.venueRolePermission.deleteMany({ where: { venueId } })
  }
  await prisma.staff.deleteMany({ where: { id: { in: [superadminId, duenoId, meseraId].filter((id): id is string => !!id) } } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
})

const rol = async (staffId: string) =>
  (await prisma.staffVenue.findUniqueOrThrow({ where: { staffId_venueId: { staffId, venueId: venueId! } }, select: { role: true } })).role
const asignarRol = (staffId: string, role: string, token: string) =>
  request(app).patch(`${LEGADO}/staff/${staffId}/venues/${venueId}`).set('Authorization', `Bearer ${token}`).send({ role })

describe('montaje legado /dashboard/superadmin/staff', () => {
  it('un OWNER con system:manage otorgado no puede asignarse SUPERADMIN ⇒ 403 del guardia de ROL; su rol no cambia', async () => {
    const respuesta = await asignarRol(duenoId!, 'SUPERADMIN', tokenDueno)

    // Quien dijo que no es `authorizeRole`, no `checkPermission` (que diría «Permission 'system:manage' required»).
    expect(respuesta.status).toBe(403)
    expect(respuesta.body).toEqual({ error: 'Forbidden', message: 'Acceso denegado. Se requiere uno de los siguientes roles: SUPERADMIN.' })
    expect(await rol(duenoId!)).toBe('OWNER')
  })

  it('el OWNER tampoco puede leer el personal por ese montaje ⇒ 403', async () => {
    const respuesta = await request(app).get(`${LEGADO}/staff/${meseraId}`).set('Authorization', `Bearer ${tokenDueno}`)
    expect(respuesta.status).toBe(403)
  })

  it('un SUPERADMIN sigue pudiendo usar la misma ruta', async () => {
    const respuesta = await asignarRol(meseraId!, 'MANAGER', tokenSuperadmin)

    expect(respuesta.status).toBe(200)
    expect(await rol(meseraId!)).toBe('MANAGER')
  })
})

// Encargo fc9c53: el guardia de ROL cubre TODO el montaje legado, no sólo `/staff`. Antes, la dueña con `system:manage`
// prestado leía terminales, negocios y ajustes de plataforma, y cambiaba el estado de cualquier negocio.
describe('montaje legado /dashboard/superadmin completo', () => {
  const ROL = { error: 'Forbidden', message: 'Acceso denegado. Se requiere uno de los siguientes roles: SUPERADMIN.' }
  const como = (token: string) => ({ Authorization: `Bearer ${token}` })

  it.each([
    ['GET', () => `${LEGADO}/terminals/${terminalId}`],
    ['GET', () => `${LEGADO}/venues/list`],
    ['GET', () => `${LEGADO}/venues/${venueId}`],
    ['GET', () => `${LEGADO}/platform-settings`],
    ['GET', () => `${LEGADO}/revenue/metrics`],
  ])('un OWNER con system:manage otorgado recibe 403 del guardia de ROL en %s %s', async (_metodo, ruta) => {
    const respuesta = await request(app).get(ruta()).set(como(tokenDueno))
    expect(respuesta.status).toBe(403)
    expect(respuesta.body).toEqual(ROL)
  })

  it('un OWNER con system:manage otorgado no puede cambiar el estado de un negocio ⇒ 403 y el estado no cambia', async () => {
    const antes = (await prisma.venue.findUniqueOrThrow({ where: { id: venueId! }, select: { status: true } })).status
    const respuesta = await request(app)
      .patch(`${LEGADO}/venues/${venueId}/status`)
      .set(como(tokenDueno))
      .send({ status: 'SUSPENDED', reason: 'prueba del guardia de rol' })
    expect(respuesta.status).toBe(403)
    expect(respuesta.body).toEqual(ROL)
    expect((await prisma.venue.findUniqueOrThrow({ where: { id: venueId! }, select: { status: true } })).status).toBe(antes)
  })

  it('un OWNER SIN system:manage sigue frenado por el guardia de PERMISO (no cambia lo de antes)', async () => {
    await prisma.venueRolePermission.deleteMany({ where: { venueId, role: 'OWNER' } })
    try {
      const respuesta = await request(app).get(`${LEGADO}/terminals/${terminalId}`).set(como(tokenDueno))
      expect(respuesta.status).toBe(403)
      expect(respuesta.body).not.toEqual(ROL)
    } finally {
      await prisma.venueRolePermission.create({
        data: { venueId: venueId!, role: 'OWNER', permissions: ['system:manage'], modifiedBy: superadminId! },
      })
    }
  })

  it('un OWNER con el comodín *:* guardado (caso medido en producción) recibe 403 aquí y sigue entrando a lo de su negocio', async () => {
    await prisma.venueRolePermission.updateMany({ where: { venueId, role: 'OWNER' }, data: { permissions: ['*:*'] } })
    try {
      const legado = await request(app).get(`${LEGADO}/terminals/${terminalId}`).set(como(tokenDueno))
      expect(legado.status).toBe(403)
      expect(legado.body).toEqual(ROL)
      const suNegocio = await request(app).get(`/api/v1/dashboard/venues/${venueId}`).set(como(tokenDueno))
      expect(suNegocio.status).toBe(200)
    } finally {
      await prisma.venueRolePermission.updateMany({ where: { venueId, role: 'OWNER' }, data: { permissions: ['system:manage'] } })
    }
  })

  it('un SUPERADMIN sigue leyendo la ficha de la terminal y la lista de negocios', async () => {
    const ficha = await request(app).get(`${LEGADO}/terminals/${terminalId}`).set(como(tokenSuperadmin))
    expect(ficha.status).toBe(200)
    const lista = await request(app).get(`${LEGADO}/venues/list`).set(como(tokenSuperadmin))
    expect(lista.status).toBe(200)
  })
})
