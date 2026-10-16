// tests/integration/customer-display/capabilityReport.integration.test.ts
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'

// Para el recorrido HTTP (abajo): la sesión y la membresía se simulan; el poll, el reporte, `ensureDeviceTerminal` y el
// registro son los REALES.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    if (!raw) return void res.status(401).json({ message: 'No autorizado' })
    ;(req as any).authContext = JSON.parse(String(raw))
    next()
  },
}))
jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (_req: Request, _res: Response, next: NextFunction) => next(),
}))

import prisma from '@/utils/prismaClient'
import mobileRoutes from '@/routes/mobile.routes'
import { esperarBloqueado, retenerTerminal } from './barrera'
import { logAction } from '@/services/dashboard/activity-log.service'
import { recordCapabilityReport } from '@/services/mobile/deviceCapabilityReport.service'
import { capabilityReportRequested } from '@/services/customer-display/posPollFingerprints'
import { getCustomerDisplayForDashboard } from '@/services/customer-display/customerDisplayDesign.service'
import { borrarDisenoAlCambiarDeNegocio } from '@/services/customer-display/customerDisplayVenueChange'

/**
 * El reporte de capacidades contra Postgres: la escritura condicionada a la instalación, la lista de cambios y —el
 * pendiente 2 de F0-A— el recorrido completo de una MUDANZA: el gancho borra versión e instalación, el poll lo pide, el
 * reporte entra al instante en el negocio nuevo y el poll deja de pedirlo.
 */
// El setup de integración simula `logAction` (integration-setup.ts:74-76): la bitácora se afirma en el doble.
const bitacora = logAction as jest.Mock
const cambiosRegistrados = () => bitacora.mock.calls.filter(([p]) => p?.action === 'CUSTOMER_DISPLAY_INSTALLATION_CHANGED')

const suffix = `cap-${Date.now()}`
const DEVICE = `dev-${suffix}`
let orgId: string
let venueA: string
let venueB: string
let staffId: string
let terminalId: string

const cuerpo = (installationId?: string, version: 1 | 2 = 1) => ({
  customerDisplay: { present: true, invertible: true },
  displayModeProtocolVersion: 1 as const,
  ...(installationId ? { customerDisplayDesignVersion: version, installationId } : {}),
})
const reportar = (venueId: string, installationId?: string, now = new Date()) =>
  recordCapabilityReport({ venueId, terminalId, deviceUid: DEVICE, staffId, body: cuerpo(installationId), now })
const leer = () =>
  prisma.terminal.findUniqueOrThrow({
    where: { id: terminalId },
    select: {
      venueId: true,
      customerDisplayDesignVersion: true,
      customerDisplayInstallationId: true,
      customerDisplayInstallationSince: true,
      customerDisplayInstallationSwitches: true,
      customerDisplayAck: true,
    },
  })

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = (n: string) =>
    prisma.venue.create({
      data: { organizationId: orgId, name: `${n} ${suffix}`, slug: `${n}-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  venueA = (await venue('a')).id
  venueB = (await venue('b')).id
  staffId = (
    await prisma.staff.create({
      data: { email: `staff-${suffix}@example.test`, firstName: 'Caja', lastName: 'Prueba' },
      select: { id: true },
    })
  ).id
  terminalId = (
    await prisma.terminal.create({ data: { venueId: venueA, name: 'Caja', type: 'POS_ANDROID', deviceUid: DEVICE }, select: { id: true } })
  ).id
})

afterAll(async () => {
  if (!venueA || !venueB) return // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

it('primera vez: adopta la instalación con la hora del servidor, sin bitácora; el poll deja de pedir el reporte', async () => {
  bitacora.mockClear()
  expect(capabilityReportRequested(await leer())).toBe(true)
  const t0 = new Date('2026-10-15T18:00:00.000Z')
  expect(await reportar(venueA, 'inst-1', t0)).toBe('OK')
  const fila = await leer()
  expect(fila).toMatchObject({
    customerDisplayDesignVersion: 1,
    customerDisplayInstallationId: 'inst-1',
    customerDisplayInstallationSince: t0,
  })
  expect(fila.customerDisplayInstallationSwitches ?? []).toEqual([])
  expect(capabilityReportRequested(fila)).toBe(false)
  expect(cambiosRegistrados()).toHaveLength(0) // decisión 4 y 5: adoptar no es cambiar
})

it('otra instalación: se guarda, limpia el ack, deja su hora — y tres en 24 h encienden el aviso del dashboard', async () => {
  bitacora.mockClear()
  await prisma.terminal.update({ where: { id: terminalId }, data: { customerDisplayAck: { fingerprint: 'f', seq: 1 } } })
  const base = Date.now()
  await reportar(venueA, 'inst-2', new Date(base - 3_000))
  expect(await leer()).toMatchObject({ customerDisplayInstallationId: 'inst-2', customerDisplayAck: null })
  await reportar(venueA, 'inst-3', new Date(base - 2_000))
  await reportar(venueA, 'inst-4', new Date(base - 1_000))
  expect(((await leer()).customerDisplayInstallationSwitches as string[]).length).toBe(3)
  expect((await getCustomerDisplayForDashboard(venueA, terminalId)).device.installationWarning).toBe(true)
  // Decisión 5: tres CAMBIOS ⇒ tres asientos, con quién, dónde y qué.
  expect(cambiosRegistrados()).toHaveLength(3)
  expect(cambiosRegistrados()[0][0]).toMatchObject({ staffId, venueId: venueA, entity: 'Terminal', entityId: terminalId })
})

it('la lista conserva sólo las últimas 5', async () => {
  for (let i = 0; i < 6; i++) await reportar(venueA, `rota-${i}`)
  expect(((await leer()).customerDisplayInstallationSwitches as string[]).length).toBe(5)
})

it('un reporte SIN los campos nuevos (app vieja o downgrade): versión null y ack limpio, la instalación se conserva', async () => {
  await prisma.terminal.update({ where: { id: terminalId }, data: { customerDisplayAck: { fingerprint: 'f', seq: 9 } } })
  const antes = await leer()
  await reportar(venueA)
  expect(await leer()).toMatchObject({
    customerDisplayDesignVersion: null,
    customerDisplayAck: null,
    customerDisplayInstallationId: antes.customerDisplayInstallationId,
  })
})

/**
 * Como `esperarBloqueado` (barrera.ts), pero hasta que N sesiones esperan el candado de `pid`, DIRECTA O EN CADENA: cuando
 * dos sesiones esperan la misma fila, la segunda hace fila detrás del candado de tupla de la primera y `pg_blocking_pids`
 * nombra a la primera, no a la barrera (medido: con sólo el bloqueo directo nunca se contaban 2).
 */
async function esperarBloqueadas(pid: number, n: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [{ c }] = await prisma.$queryRaw<{ c: number }[]>`
      WITH RECURSIVE bloqueadas(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN bloqueadas b ON b.pid = ANY(pg_blocking_pids(a.pid))
      )
      SELECT count(*)::int AS c FROM bloqueadas`
    if (c >= n) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`No se bloquearon ${n} sesiones en 10 s`)
}

// 🔴 Codex r1 #12: `Promise.all` no garantiza que las dos LEAN antes de que una escriba. La barrera sí: retiene la fila,
// las dos leen (sin candado) y se quedan esperando para escribir; al soltarla, una gana y la otra reintenta.
it('🔴 dos instalaciones que leen la fila SIN instalación antes de escribir: gana una, la otra cuenta como cambio', async () => {
  await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      customerDisplayInstallationId: null,
      customerDisplayInstallationSwitches: Prisma.DbNull,
      customerDisplayInstallationSince: null,
    },
  })
  const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
  const p = reportar(venueA, 'P')
  const q = reportar(venueA, 'Q')
  await esperarBloqueadas(pid, 2)
  soltar()
  await transaccion
  await Promise.all([p, q])
  const fila = await leer()
  expect(['P', 'Q']).toContain(fila.customerDisplayInstallationId)
  expect(fila.customerDisplayInstallationSwitches).toHaveLength(1) // la segunda: un cambio, no otra adopción
})

// 🔴 Codex r1 #4, su secuencia: el retrasado lee A y []; en medio, A → B → A deja dos cambios; el retrasado encuentra A.
it('🔴 un reporte retrasado que leyó A no pierde los cambios A → B → A que pasaron en medio', async () => {
  await prisma.terminal.update({
    where: { id: terminalId },
    data: { customerDisplayInstallationId: 'A', customerDisplayInstallationSwitches: [], customerDisplayInstallationSince: new Date() },
  })
  const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
  const retrasado = reportar(venueA, 'B') // lee A y [], y su escritura espera el candado
  expect(await esperarBloqueado(pid, retrasado)).toBe('bloqueada')
  const t1 = new Date(Date.now() - 2_000).toISOString()
  const t2 = new Date(Date.now() - 1_000).toISOString()
  // Lo que dejan dos reportes reales A → B y B → A, escrito dentro de la transacción que retiene la fila.
  soltar(async tx => {
    await tx.terminal.update({
      where: { id: terminalId },
      data: { customerDisplayInstallationId: 'B', customerDisplayInstallationSwitches: [t1] },
    })
    await tx.terminal.update({
      where: { id: terminalId },
      data: { customerDisplayInstallationId: 'A', customerDisplayInstallationSwitches: [t1, t2] },
    })
  })
  await transaccion
  expect(await retrasado).toBe('OK')
  const fila = await leer()
  expect(fila.customerDisplayInstallationId).toBe('B')
  expect(fila.customerDisplayInstallationSwitches).toHaveLength(3) // con sólo la instalación en el CAS quedaba UNO
})

it('🔴 PENDIENTE 2 DE F0-A: la MUDANZA, en el servicio', async () => {
  await reportar(venueA, 'inst-mudanza')
  expect(capabilityReportRequested(await leer())).toBe(false)

  // Lo mismo que hace cada escritor real de `Terminal.venueId` (F0-A v2, §4.3): el gancho y la escritura, en UNA transacción.
  await prisma.$transaction(async tx => {
    await borrarDisenoAlCambiarDeNegocio(tx, { terminalId, toVenueId: venueB, reason: 'terminal_moved', staffId })
    await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueB } })
  })
  const recienMudada = await leer()
  expect(recienMudada).toMatchObject({ venueId: venueB, customerDisplayDesignVersion: null, customerDisplayInstallationId: null })
  expect(capabilityReportRequested(recienMudada)).toBe(true) // el poll en B se lo pide en 15-20 s

  expect(await reportar(venueA, 'inst-mudanza')).toBe('SIN_BINDING') // al negocio viejo ya no le toca
  expect(await reportar(venueB, 'inst-mudanza')).toBe('OK') // al nuevo, al instante: nada de esperar 24 h
  const enB = await leer()
  expect(enB).toMatchObject({ customerDisplayDesignVersion: 1, customerDisplayInstallationId: 'inst-mudanza' })
  expect(enB.customerDisplayInstallationSwitches ?? []).toEqual([]) // adopción, no un cambio (decisión 4)
  expect(capabilityReportRequested(enB)).toBe(false)
})

// 🔴 Codex r1 #12: la prueba de arriba llama al servicio; ésta recorre las RUTAS (poll, controlador del reporte y
// `ensureDeviceTerminal`) y fija el contrato REAL, que el servicio solo no muestra.
describe('🔴 PENDIENTE 2 DE F0-A por HTTP: poll → reporte → mudanza → poll → reporte', () => {
  const DEV = `devhttp-${suffix}`
  let t2: string
  const app = () => {
    const a = express()
    a.use(express.json())
    a.use('/api/v1/mobile', mobileRoutes)
    a.use((e: any, _q: Request, s: Response, _n: NextFunction) => s.status(e.statusCode ?? 500).json({ code: e.code }))
    return a
  }
  // Sin `x-device-platform` en el poll: el registro PASIVO no corre; el reporte sí la lleva (la exige) y registra explícito.
  const sesion = (venueId: string) => ({ 'x-test-auth-context': JSON.stringify({ userId: staffId, venueId }), 'x-device-id': DEV })
  const poll = (venueId: string) => request(app()).get(`/api/v1/mobile/venues/${venueId}/display-mode-request`).set(sesion(venueId))
  const reporte = (venueId: string) =>
    request(app())
      .put(`/api/v1/mobile/venues/${venueId}/device-capabilities`)
      .set({ ...sesion(venueId), 'x-device-platform': 'ANDROID' })
      .send(cuerpo('inst-http'))

  beforeAll(async () => {
    t2 = (
      await prisma.terminal.create({
        data: { venueId: venueA, name: 'Caja HTTP', type: 'POS_ANDROID', deviceUid: DEV, status: 'ACTIVE' },
        select: { id: true },
      })
    ).id
  })

  it('el aparato pide el reporte, reporta, se muda, lo vuelve a pedir en el negocio nuevo y su reporte entra ahí al instante', async () => {
    expect((await poll(venueA)).body.data.capabilityReport).toEqual({ requested: true })
    const primero = await reporte(venueA)
    expect(primero.status).toBe(200)
    expect(primero.body.data.terminalId).toBe(t2)
    expect((await poll(venueA)).body.data.capabilityReport).toEqual({ requested: false })

    await prisma.$transaction(async tx => {
      await borrarDisenoAlCambiarDeNegocio(tx, { terminalId: t2, toVenueId: venueB, reason: 'terminal_moved', staffId })
      await tx.terminal.update({ where: { id: t2 }, data: { venueId: venueB } })
    })

    expect((await poll(venueB)).body.data).toMatchObject({ terminalId: t2, capabilityReport: { requested: true } })
    const enElViejo = await poll(venueA)
    expect(enElViejo.status).toBe(404)
    expect(enElViejo.body.code).toBe('DEVICE_NOT_FOUND')

    // El contrato REAL: si la tablet sigue apuntando al negocio viejo, el registro explícito la da de alta AHÍ como aparato
    // NUEVO (otra fila); la fila mudada no se toca. No es lo que decía el helper («SIN_BINDING»): es lo que pasa por HTTP.
    const aDestiempo = await reporte(venueA)
    expect(aDestiempo.status).toBe(200)
    expect(aDestiempo.body.data.terminalId).not.toBe(t2)
    expect(
      await prisma.terminal.findUniqueOrThrow({
        where: { id: t2 },
        select: { venueId: true, customerDisplayDesignVersion: true, customerDisplayInstallationId: true },
      }),
    ).toEqual({ venueId: venueB, customerDisplayDesignVersion: null, customerDisplayInstallationId: null })

    const enElNuevo = await reporte(venueB)
    expect(enElNuevo.body.data.terminalId).toBe(t2)
    expect((await poll(venueB)).body.data.capabilityReport).toEqual({ requested: false })
    const fila = await prisma.terminal.findUniqueOrThrow({ where: { id: t2 }, select: { customerDisplayInstallationSwitches: true } })
    expect(fila.customerDisplayInstallationSwitches ?? []).toEqual([]) // adopción, no un cambio (decisión 4)
  })
})
