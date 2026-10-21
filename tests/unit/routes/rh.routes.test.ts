// Rutas de RH fase 1a (spec §5.3, §6, §7) con el router REAL y supertest. Arnés local, como
// staffPay.diferenciasGate.routes.test.ts: una app Express por caso, con el authContext y la lista de permisos del caso.
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'

// El permiso se decide por la lista del caso (`appConUsuario({ permissions })`), no por la base.
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) =>
    (req.permisosDePrueba ?? []).includes(perm) ? next() : res.status(403).json({ error: 'Forbidden', message: `Falta ${perm}` }),
}))

import rhRoutes from '@/routes/dashboard/rh.routes'
import * as puestos from '@/services/dashboard/rh/puestos.service'
import * as asign from '@/services/dashboard/rh/asignaciones.service'
import * as resumen from '@/services/dashboard/rh/resumenDePago.service'
import logger from '@/config/logger'
import * as accessService from '@/services/access/access.service'
import { moduleService } from '@/services/modules/module.service'

const SEDE = 'cjld2cjxh0000qzrmn831i7rn'
const PERSONA = 'cjld2cjxh0000qzrmn831i7rm'
const ORG = 'cjld2cjxh0000qzrmn831i7ro'
const base = `/api/v1/dashboard/venues/${SEDE}/rh`

function appConUsuario({ permissions, authContext }: { permissions: string[]; authContext?: Record<string, unknown> }) {
  const app = express()
  app.use(express.json())
  app.use((req: any, _res: Response, next: NextFunction) => {
    req.authContext = authContext ?? { userId: 'cjld2cjxh0000qzrmn831i7ru', orgId: ORG, venueId: SEDE, role: 'OWNER' }
    req.permisosDePrueba = permissions
    next()
  })
  app.use('/api/v1/dashboard/venues/:venueId/rh', rhRoutes)
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => res.status(err.statusCode ?? 500).json({ error: err.message }))
  return app
}

let marcaBlanca: jest.SpyInstance
beforeEach(() => {
  marcaBlanca = jest.spyOn(moduleService, 'isModuleEnabled').mockResolvedValue(false)
})

describe('rutas RH (spec §6-7)', () => {
  describe('feature', () => {
    it('GET /rh/positions con teams:read ⇒ 200 y el límite se recorta a 100 en el servidor', async () => {
      jest.spyOn(puestos, 'listarPuestos').mockResolvedValue({ data: [], total: 0, hasMore: false })
      const res = await request(appConUsuario({ permissions: ['teams:read'] })).get(`${base}/positions?limit=100000`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ data: [], total: 0, hasMore: false })
      expect(puestos.listarPuestos).toHaveBeenCalledWith(SEDE, expect.objectContaining({ limit: 100 }))
    })

    it('SUPERADMIN impersonando el rol VIEWER ⇒ pay-overview con comisiones: null (el override llega a getUserAccess)', async () => {
      const getUserAccess = jest.spyOn(accessService, 'getUserAccess').mockImplementation(async (_u, _v, _c, imp) => {
        // Sin el override, el SUPERADMIN recuperaría su bypass y vería las tasas personales.
        if (imp?.forcedRole) return { role: imp.forcedRole, corePermissions: ['teams:read'] } as any
        return { role: 'SUPERADMIN', corePermissions: ['*:*'] } as any
      })
      prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG, timezone: 'America/Mexico_City' })
      prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1' })
      const app = appConUsuario({
        permissions: ['teams:read'],
        authContext: {
          userId: 'cjld2cjxh0000qzrmn831i7rs',
          orgId: ORG,
          venueId: SEDE,
          role: 'VIEWER',
          isImpersonating: true,
          impersonation: { mode: 'role', impersonatedUserId: null, impersonatedRole: 'VIEWER' },
        },
      })
      const res = await request(app).get(`${base}/staff/${PERSONA}/pay-overview`)
      expect(res.status).toBe(200)
      expect(getUserAccess).toHaveBeenCalledWith('cjld2cjxh0000qzrmn831i7rs', SEDE, undefined, {
        isImpersonating: true,
        mode: 'role',
        forcedRole: 'VIEWER',
      })
      expect(res.body).toEqual({ comisiones: null, nivelDeClase: 'SIN_PERMISO', propinas: { regla: 'ATIENDE_LUEGO_COBRA' } })
      expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
    })
  })

  describe('regresión', () => {
    it('POST /rh/positions sin teams:update ⇒ 403', async () => {
      const crear = jest.spyOn(puestos, 'crearPuesto')
      const res = await request(appConUsuario({ permissions: ['teams:read'] }))
        .post(`${base}/positions`)
        .send({ name: 'Coach', suggestedRole: 'WAITER' })
      expect(res.status).toBe(403)
      expect(crear).not.toHaveBeenCalled()
    })

    it('relación inválida ⇒ 400 en español', async () => {
      const res = await request(appConUsuario({ permissions: ['teams:update'] }))
        .post(`${base}/staff/${PERSONA}/assignments`)
        .send({ positionId: 'cjld2cjxh0000qzrmn831i7rp', relation: 'POR_FUERA' })
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).toContain('Relación inválida')
    })

    it('suggestedRole SUPERADMIN ⇒ 400 «Rol inválido» (al crear y al editar), sin llamar al servicio', async () => {
      const crear = jest.spyOn(puestos, 'crearPuesto')
      const editar = jest.spyOn(puestos, 'editarPuesto')
      const app = appConUsuario({ permissions: ['teams:update'] })
      const post = await request(app).post(`${base}/positions`).send({ name: 'Dios', suggestedRole: 'SUPERADMIN' })
      expect(post.status).toBe(400)
      expect(post.body.error).toContain('Rol inválido')
      const patch = await request(app).patch(`${base}/positions/cjld2cjxh0000qzrmn831i7rp`).send({ suggestedRole: 'SUPERADMIN' })
      expect(patch.status).toBe(400)
      expect(patch.body.error).toContain('Rol inválido')
      expect(crear).not.toHaveBeenCalled()
      expect(editar).not.toHaveBeenCalled()
    })

    it('getUserAccess falla ⇒ pay-overview sin permiso en los dos bloques y warn en el log (como staffPay/acceso.ts)', async () => {
      jest.spyOn(accessService, 'getUserAccess').mockRejectedValueOnce(new Error('caída de la base'))
      prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG, timezone: 'America/Mexico_City' })
      prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1' })
      const res = await request(appConUsuario({ permissions: ['teams:read'] })).get(`${base}/staff/${PERSONA}/pay-overview`)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ comisiones: null, nivelDeClase: 'SIN_PERMISO', propinas: { regla: 'ATIENDE_LUEGO_COBRA' } })
      expect(logger.warn).toHaveBeenCalled()
      expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
      expect(prismaMock.staffPayLevelAssignment.findFirst).not.toHaveBeenCalled()
    })

    it('sede de marca blanca ⇒ GET /rh/positions 403 en español, aun con teams:read (spec §5.3)', async () => {
      marcaBlanca.mockResolvedValue(true)
      const listar = jest.spyOn(puestos, 'listarPuestos')
      const res = await request(appConUsuario({ permissions: ['teams:read'] })).get(`${base}/positions`)
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Puestos y relación de RH no está disponible en esta sucursal.')
      expect(marcaBlanca).toHaveBeenCalledWith(SEDE, 'WHITE_LABEL_DASHBOARD')
      expect(listar).not.toHaveBeenCalled()
    })
  })

  // Cada ruta con su permiso EXACTO: sin él ⇒ 403 que nombra ese permiso; sólo con él ⇒ pasa.
  describe('permiso por ruta (las 10)', () => {
    const P = 'cjld2cjxh0000qzrmn831i7rp'
    const A = 'cjld2cjxh0000qzrmn831i7ra'
    const rutas: Array<[string, 'get' | 'post' | 'patch', string, string, Record<string, unknown> | null]> = [
      ['listar puestos', 'get', '/positions', 'teams:read', null],
      ['sugeridos', 'get', '/positions/suggestions', 'teams:read', null],
      ['crear puesto', 'post', '/positions', 'teams:update', { name: 'Coach', suggestedRole: 'WAITER' }],
      ['editar puesto', 'patch', `/positions/${P}`, 'teams:update', { name: 'Coach' }],
      ['archivar puesto', 'post', `/positions/${P}/archive`, 'teams:update', {}],
      ['historial', 'get', `/staff/${PERSONA}/assignments`, 'teams:read', null],
      ['asignar', 'post', `/staff/${PERSONA}/assignments`, 'teams:update', { positionId: P }],
      ['cambiar', 'post', `/assignments/${A}/change`, 'teams:update', { relation: null }],
      ['terminar', 'post', `/assignments/${A}/end`, 'teams:update', {}],
      ['cómo se le paga', 'get', `/staff/${PERSONA}/pay-overview`, 'teams:read', null],
    ]
    const espias: jest.SpyInstance[] = []
    beforeAll(() => {
      const vacio = { data: [], total: 0, hasMore: false }
      espias.push(
        jest.spyOn(puestos, 'listarPuestos').mockResolvedValue(vacio),
        jest.spyOn(puestos, 'puestosSugeridos').mockResolvedValue([]),
        jest.spyOn(puestos, 'crearPuesto').mockResolvedValue({} as any),
        jest.spyOn(puestos, 'editarPuesto').mockResolvedValue({} as any),
        jest.spyOn(puestos, 'archivarPuesto').mockResolvedValue({} as any),
        jest.spyOn(asign, 'historialDePersona').mockResolvedValue(vacio),
        jest.spyOn(asign, 'asignarPuesto').mockResolvedValue({} as any),
        jest.spyOn(asign, 'cambiarAsignacion').mockResolvedValue({} as any),
        jest.spyOn(asign, 'terminarAsignacion').mockResolvedValue({} as any),
        jest.spyOn(resumen, 'resumenDePago').mockResolvedValue({} as any),
        jest.spyOn(accessService, 'getUserAccess').mockResolvedValue({ role: 'VIEWER', corePermissions: [] } as any),
      )
    })
    afterAll(() => espias.forEach(e => e.mockRestore()))

    it.each(rutas)('%s (%s %s) pide %s', async (_n, metodo, ruta, permiso, cuerpo) => {
      const llamar = (permissions: string[]) => {
        const r = request(appConUsuario({ permissions }))[metodo](`${base}${ruta}`)
        return cuerpo ? r.send(cuerpo) : r
      }
      const otro = permiso === 'teams:read' ? 'teams:update' : 'teams:read'
      const sin = await llamar([otro])
      expect(sin.status).toBe(403)
      expect(sin.body.message).toBe(`Falta ${permiso}`)
      const con = await llamar([permiso])
      expect([200, 201]).toContain(con.status)
    })
  })
})
