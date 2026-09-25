/**
 * GET /tpv/auth/permissions — Codex r8 (P2-5, 22-sep).
 *
 * La terminal guarda esta lista y la usa SIN RED: el respaldo de «no se presentó tarjeta» decide con ella quién puede
 * cerrar un cobro en el aparato. La ruta la calculaba con el ROL DEL TOKEN, y el token no se entera de los cambios: un
 * OWNER bajado a CASHIER seguía descargando —con éxito, y fresca— la lista de OWNER, mientras la declaración en el servidor
 * (`no-instrument-resolution.service.ts`, `miembroDelVenue`) ya lo rechazaba con su rol vigente. Sin red, la terminal usaba
 * la lista y lo dejaba pasar. Tampoco miraba si la persona seguía activa en el negocio.
 *
 * Monta el router REAL de `tpv.routes.ts`; sólo la autenticación (contexto inyectado por cabecera), prisma y el logger van
 * simulados. 🔴 Con un mock los campos llegan gratis: por eso una prueba fija también la FORMA de la consulta — si el
 * `select` deja de pedir `role` o `active`, en producción llegan `undefined` y esto vuelve a fallar en verde.
 */

import express from 'express'
import type { Server } from 'http'
import request from 'supertest'
import { StaffRole } from '@prisma/client'

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

jest.mock('@/middlewares/validation', () => ({
  validateRequest: () => (_req: any, _res: any, next: any) => next(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    // La persona existe y está ACTIVA (H2: sin eso el resolutor niega). Función normal: sobrevive a los reset de mocks.
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: jest.fn(), findUnique: jest.fn() },
    venueRolePermission: { findUnique: jest.fn() },
    venue: { findUnique: jest.fn() },
    staffOrganization: { findUnique: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import tpvRouter from '@/routes/tpv.routes'
import { expandWildcards } from '@/lib/permissions'
import { resolveStaffVenuePermissions } from '@/lib/resolveEffectivePermissions'

const staffVenueFindUnique = (prisma as any).staffVenue.findUnique as jest.Mock
const staffVenueFindFirst = (prisma as any).staffVenue.findFirst as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const staffOrganizationFindUnique = (prisma as any).staffOrganization.findUnique as jest.Mock
const venueRolePermissionFindUnique = (prisma as any).venueRolePermission.findUnique as jest.Mock

const VENUE = 'venue-A'
const STAFF = 'staff-1'
const PERMISO = 'payments:resolve-no-instrument'

let server: Server

beforeAll(done => {
  const app = express()
  app.use(express.json())
  app.use('/tpv', tpvRouter)
  server = app.listen(0, done)
})

afterAll(done => {
  server.close(done)
})

beforeEach(() => {
  jest.clearAllMocks()
  venueRolePermissionFindUnique.mockResolvedValue(null) // sin personalización del negocio: el rol tal cual
  staffVenueFindFirst.mockResolvedValue(null)
  venueFindUnique.mockResolvedValue({ organizationId: 'org-1' })
  staffOrganizationFindUnique.mockResolvedValue(null)
})

/** El token dice OWNER: es lo que la terminal trae desde que el dueño inició sesión. */
const conTokenDe = (role: StaffRole = StaffRole.OWNER) =>
  request(server)
    .get('/tpv/auth/permissions')
    .set('x-test-auth-context', JSON.stringify({ userId: STAFF, venueId: VENUE, role }))

const miembro = (role: StaffRole, extra: Record<string, unknown> = {}) => ({
  role,
  active: true,
  permissionSetId: null,
  permissionSet: null,
  staff: { active: true },
  ...extra,
})

describe('GET /tpv/auth/permissions · la lista sale del rol VIGENTE, no del token (Codex r8 P2-5)', () => {
  it('un OWNER bajado a CASHIER descarga la lista de CASHIER aunque su token siga diciendo OWNER', async () => {
    staffVenueFindUnique.mockResolvedValue(miembro(StaffRole.CASHIER))

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(200)
    expect(r.body.data.role).toBe(StaffRole.CASHIER)
    expect(r.body.data.permissions).not.toContain(PERMISO)
    expect(r.body.data.permissions.sort()).toEqual(expandWildcards(resolveStaffVenuePermissions({ role: StaffRole.CASHIER }, null)).sort())
  })

  it('control · un OWNER vigente sí lo trae', async () => {
    staffVenueFindUnique.mockResolvedValue(miembro(StaffRole.OWNER))

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(200)
    expect(r.body.data.permissions).toContain(PERMISO)
  })

  it('dado de baja en el negocio: lista VACÍA (autoritativa), no la del token', async () => {
    staffVenueFindUnique.mockResolvedValue(miembro(StaffRole.OWNER, { active: false }))

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(200)
    expect(r.body.data.permissions).toEqual([])
  })

  it('persona dada de baja en Avoqado: lista VACÍA', async () => {
    staffVenueFindUnique.mockResolvedValue(miembro(StaffRole.OWNER, { staff: { active: false } }))

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(200)
    expect(r.body.data.permissions).toEqual([])
  })

  it('sin membresía en el negocio: 403, nunca la lista del rol del token', async () => {
    staffVenueFindUnique.mockResolvedValue(null)

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(403)
    expect(r.body.data).toBeUndefined()
  })

  it('FORMA de la consulta: pide el rol, si sigue activo y si la persona sigue activa', async () => {
    staffVenueFindUnique.mockResolvedValue(miembro(StaffRole.MANAGER))

    await conTokenDe(StaffRole.OWNER)

    const args = staffVenueFindUnique.mock.calls[0][0]
    expect(args.where).toEqual({ staffId_venueId: { staffId: STAFF, venueId: VENUE } })
    expect(args.select).toMatchObject({
      role: true,
      active: true,
      permissionSetId: true,
      permissionSet: true,
      staff: { select: { active: true } },
    })
  })
})

/**
 * Codex r9 (P2-6, 23-sep): el servidor autoriza SIN membresía en el negocio a tres identidades (`checkPermission.middleware.ts`):
 * un SUPERADMIN acreditado en cualquier `StaffVenue`, el OWNER activo de la organización y el acceso maestro de la terminal.
 * El 403 de la ronda 8 les quitaba Ajustes y el modo kiosco local. Se les devuelve la lista de su rol, SIN la declaración
 * «no se presentó tarjeta»: ésa el servidor la exige de un MIEMBRO (`miembroDelVenue`), y sin red la terminal decide con esta lista.
 */
describe('GET /tpv/auth/permissions · identidades autorizadas sin membresía (Codex r9 P2-6)', () => {
  const ajustes = 'tpv-terminal:settings'

  it('un SUPERADMIN acreditado en OTRO negocio recibe su lista, sin la declaración', async () => {
    staffVenueFindUnique.mockResolvedValue(null)
    staffVenueFindFirst.mockResolvedValue({ id: 'sv-super' })

    const r = await conTokenDe(StaffRole.SUPERADMIN)

    expect(r.status).toBe(200)
    expect(r.body.data.role).toBe(StaffRole.SUPERADMIN)
    expect(r.body.data.permissions).toContain(ajustes)
    expect(r.body.data.permissions).not.toContain(PERMISO)
    // Superadmin DE VERDAD: fila activa de persona activa (Codex H6, 24-sep).
    expect(staffVenueFindFirst.mock.calls[0][0].where).toEqual({
      staffId: STAFF,
      role: StaffRole.SUPERADMIN,
      active: true,
      staff: { active: true },
    })
  })

  it('el OWNER activo de la organización recibe la lista de OWNER, sin la declaración', async () => {
    staffVenueFindUnique.mockResolvedValue(null)
    staffOrganizationFindUnique.mockResolvedValue({ role: 'OWNER', isActive: true })

    const r = await conTokenDe(StaffRole.OWNER)

    expect(r.status).toBe(200)
    expect(r.body.data.role).toBe(StaffRole.OWNER)
    expect(r.body.data.permissions).toContain(ajustes)
    expect(r.body.data.permissions).not.toContain(PERMISO)
  })

  it('el acceso maestro de la terminal conserva Ajustes y kiosco, sin la declaración', async () => {
    staffVenueFindUnique.mockResolvedValue(null)

    const r = await request(server)
      .get('/tpv/auth/permissions')
      .set('x-test-auth-context', JSON.stringify({ userId: 'MASTER_ADMIN', venueId: VENUE, role: StaffRole.SUPERADMIN }))

    expect(r.status).toBe(200)
    expect(r.body.data.permissions).toContain(ajustes)
    expect(r.body.data.permissions).not.toContain(PERMISO)
  })

  it('control · un miembro de la organización que NO es OWNER sigue en 403', async () => {
    staffVenueFindUnique.mockResolvedValue(null)
    staffOrganizationFindUnique.mockResolvedValue({ role: 'MEMBER', isActive: true })

    expect((await conTokenDe(StaffRole.OWNER)).status).toBe(403)
  })

  it('control · un OWNER de la organización INACTIVO sigue en 403', async () => {
    staffVenueFindUnique.mockResolvedValue(null)
    staffOrganizationFindUnique.mockResolvedValue({ role: 'OWNER', isActive: false })

    expect((await conTokenDe(StaffRole.OWNER)).status).toBe(403)
  })
})
