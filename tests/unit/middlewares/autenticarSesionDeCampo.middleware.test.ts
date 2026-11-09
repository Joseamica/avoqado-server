/**
 * El candado de las rutas del celular de campo (App de campo, bloque 1, Tarea 5): sólo entra un token de campo cuya sesión
 * sigue viva Y es la `sesionId` del celular vinculado de la persona, en la sucursal del token, con el rol de HOY.
 * Prisma, la caché de sesiones, el corte y las sucursales van mockeados; la firma del token es la real.
 */
import express, { Request, Response } from 'express'
import request from 'supertest'
import prisma from '@/utils/prismaClient'
import { enrichContext } from '@/observability/executionContext'
import { generateAccessToken as tokenDePax } from '@/security'
import { generateAccessToken as tokenMovil } from '@/jwt.service'
import { isSessionAliveCached } from '@/services/auth/sessionCache'
import { sucursalesDeLaPersona } from '@/services/tpv/campo/celular/personasDeCampo'
import { firmarAccesoDeCampo } from '@/services/tpv/campo/celular/tokenDeCampo'
import { motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import { autenticarSesionDeCampo } from '@/middlewares/autenticarSesionDeCampo.middleware'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { celularDeCampo: { findUnique: jest.fn() } } }))
jest.mock('@/services/auth/sessionCache', () => ({ isSessionAliveCached: jest.fn() }))
jest.mock('@/utils/passwordChangeGuard', () => ({ motivoDeSesionInvalidada: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({ sucursalesDeLaPersona: jest.fn() }))
jest.mock('@/observability/executionContext', () => ({ enrichContext: jest.fn() }))

const db = prisma as any
const viva = isSessionAliveCached as jest.Mock
const corte = motivoDeSesionInvalidada as jest.Mock
const sucursales = sucursalesDeLaPersona as jest.Mock

const celular = { id: 'cel1', organizationId: 'org1', staffId: 'staff1', staffIdVinculado: 'staff1', sesionId: 'ses1' }
const deCampo = (extra: Partial<{ venueId: string; sid: string; role: 'CASHIER' | 'WAITER' }> = {}) =>
  firmarAccesoDeCampo({ staffId: 'staff1', organizationId: 'org1', venueId: 'vA', role: 'CASHIER', sid: 'ses1', ...extra })
const sucursal = (venueId: string, role = 'CASHIER') => ({ staffVenueId: `sv-${venueId}`, venueId, nombre: venueId, role, pin: '1234' })

const app = express()
app.get('/venues/:venueId/x', autenticarSesionDeCampo, (req: Request, res: Response) =>
  res.json({ authContext: req.authContext, celularId: res.locals.celular.id }),
)
app.use((err: any, _req: Request, res: Response, _next: unknown) => res.status(500).json({ error: err.message }))

const pedir = (token?: string, venueId = 'vA', extra: Record<string, string> = {}) => {
  const r = request(app).get(`/venues/${venueId}/x`).set(extra)
  return token ? r.set('Authorization', `Bearer ${token}`) : r
}

beforeEach(() => {
  jest.clearAllMocks()
  db.celularDeCampo.findUnique.mockResolvedValue({ ...celular })
  viva.mockResolvedValue(true)
  corte.mockResolvedValue(null)
  sucursales.mockResolvedValue([sucursal('vA', 'WAITER'), sucursal('vB')])
})

describe('autenticarSesionDeCampo', () => {
  it('sesión del celular → pasa; authContext con el rol de HOY en esa sucursal (no el del token), su sid y el celular', async () => {
    const r = await pedir(deCampo())

    expect(r.status).toBe(200)
    expect(r.body.celularId).toBe('cel1')
    expect(r.body.authContext).toMatchObject({
      userId: 'staff1',
      orgId: 'org1',
      venueId: 'vA',
      role: 'WAITER',
      sid: 'ses1',
      realUserId: 'staff1',
      realRole: 'WAITER',
      isImpersonating: false,
    })
    expect(viva).toHaveBeenCalledWith('ses1')
    expect(corte).toHaveBeenCalledWith('staff1', expect.any(Number))
    expect(db.celularDeCampo.findUnique).toHaveBeenCalledWith({ where: { staffIdVinculado: 'staff1' } })
    expect(sucursales).toHaveBeenCalledWith('staff1', 'org1')
    expect(enrichContext).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'vA', userId: 'staff1', role: 'WAITER' }))
  })

  it.each([
    ['sin cabecera', undefined],
    ['basura', 'no-es-un-jwt'],
    [
      'de la PAX (auth.tpv.service)',
      tokenDePax({
        userId: 'staff1',
        staffId: 'staff1',
        orgId: 'org1',
        venueId: 'vA',
        role: 'CASHIER' as any,
        terminalSerialNumber: 'AVQD-1',
      }),
    ],
  ])('token %s → 401 SESION_INVALIDA sin tocar la base', async (_n, token) => {
    const r = await pedir(token)

    expect(r.status).toBe(401)
    expect(r.body).toEqual({ code: 'SESION_INVALIDA', message: expect.any(String) })
    expect(viva).not.toHaveBeenCalled()
    expect(db.celularDeCampo.findUnique).not.toHaveBeenCalled()
  })

  it('un token de login móvil con X-Device-Id: celular:<id del celular> (y el sid de su sesión) → 401 SESION_INVALIDA', async () => {
    const movil = tokenMovil('staff1', 'org1', 'vA', 'CASHIER' as any, false, { sid: 'ses1' })

    const r = await pedir(movil, 'vA', { 'X-Device-Id': 'celular:cel1' })

    expect(r.status).toBe(401)
    expect(r.body.code).toBe('SESION_INVALIDA')
    expect(db.celularDeCampo.findUnique).not.toHaveBeenCalled()
  })

  it('la sesión revocada → 401 SESION_CERRADA', async () => {
    viva.mockResolvedValue(false)
    const r = await pedir(deCampo())
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('SESION_CERRADA')
    expect(db.celularDeCampo.findUnique).not.toHaveBeenCalled()
  })

  it('el corte de sesiones de la persona (contraseña o «cerrar todas») → 401 SESION_CERRADA', async () => {
    corte.mockResolvedValue('SESSIONS_REVOKED')
    const r = await pedir(deCampo())
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('SESION_CERRADA')
  })

  it('sin celular vinculado de la persona → 401 CELULAR_DESVINCULADO', async () => {
    db.celularDeCampo.findUnique.mockResolvedValue(null)
    const r = await pedir(deCampo())
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('CELULAR_DESVINCULADO')
  })

  it('un token de campo de una sesión viva que ya NO es la sesionId del celular → 401 SESION_INVALIDA', async () => {
    const r = await pedir(deCampo({ sid: 'ses-vieja' }))
    expect(r.status).toBe(401)
    expect(r.body.code).toBe('SESION_INVALIDA')
    expect(sucursales).not.toHaveBeenCalled()
  })

  it('la sesión en A contra /venues/B (la persona es de A y de B) → 403 OTRA_SUCURSAL con venueIdDeLaSesion al nivel de code', async () => {
    const r = await pedir(deCampo(), 'vB')
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ code: 'OTRA_SUCURSAL', message: expect.any(String), venueIdDeLaSesion: 'vA' })
  })

  it('persona inactiva o sin StaffVenue activo en la organización → 403 PERSONA_DADA_DE_BAJA', async () => {
    sucursales.mockResolvedValue([])
    const r = await pedir(deCampo())
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('PERSONA_DADA_DE_BAJA')
  })

  it('sin StaffVenue activo en ESA sucursal (sí en otra) → 403 SIN_ACCESO_A_LA_SUCURSAL', async () => {
    sucursales.mockResolvedValue([sucursal('vB')])
    const r = await pedir(deCampo())
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('SIN_ACCESO_A_LA_SUCURSAL')
  })

  it('la base caída al revisar la sesión no deja pasar: sale al manejador de errores', async () => {
    viva.mockRejectedValue(new Error('base caída'))
    const r = await pedir(deCampo())
    expect(r.status).toBe(500)
  })
})
