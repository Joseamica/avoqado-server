/**
 * IVA por producto (spec planes 6-7, §5.5) — de punta a punta: Express real, token REAL firmado, autenticación real y el
 * middleware de aparatos montado como en `mobile.routes.ts` (`router.use`). Prueba lo que las pruebas con `authContext`
 * fabricado no pueden: que la marca `origen` sobrevive la verificación del JWT y que el negocio de la ruta se ve al terminar.
 */
jest.mock('@/utils/tokenRevocation', () => ({ isJtiRevoked: jest.fn().mockResolvedValue(false) }))
jest.mock('@/services/auth/sessionCache', () => ({ isSessionAliveCached: jest.fn().mockResolvedValue(true) }))
jest.mock('@/utils/passwordChangeGuard', () => ({
  motivoDeSesionInvalidada: jest.fn().mockResolvedValue(null),
  mensajeDeCorte: jest.fn(() => 'corte'),
}))
jest.mock('@/services/liveDemo.service', () => ({ updateLiveDemoActivity: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  registerDeviceSeen: jest.fn().mockResolvedValue(null),
  registerPosSinAparato: jest.fn().mockResolvedValue(true),
  POS_SIN_APARATO_MUESTREO_MS: jest.requireActual('@/services/mobile/deviceRegistry.service').POS_SIN_APARATO_MUESTREO_MS,
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkPermission.middleware'),
  resolveUserRoleForVenue: jest.fn(),
}))

import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'
import { generateAccessToken } from '@/jwt.service'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { resolveUserRoleForVenue } from '@/middlewares/checkPermission.middleware'
import { __resetDeviceSeenCache, capturarVenueDeLaRuta, registerDeviceMiddleware } from '@/middlewares/registerDevice.middleware'
import { requireVenueMembership } from '@/middlewares/validateVenueAccess.middleware'
import { registerPosSinAparato } from '@/services/mobile/deviceRegistry.service'

const mockPosSinAparato = registerPosSinAparato as jest.Mock
const mockRol = resolveUserRoleForVenue as jest.Mock

/** Montado como en `mobile.routes.ts`, con la pertenencia real y un manejador de errores de app. */
function app() {
  const router = express.Router()
  router.use(registerDeviceMiddleware)
  router.param('venueId', capturarVenueDeLaRuta)
  router.get('/venues/:venueId/ping', authenticateTokenMiddleware, requireVenueMembership, (_req, res) => {
    res.json({ ok: true })
  })
  router.get('/venues/:venueId/falla', authenticateTokenMiddleware, requireVenueMembership, (_req, _res, next) => {
    next(new Error('validación'))
  })
  const a = express()
  a.use('/api/v1/mobile', router)
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message })
  })
  return a
}

const tokenPos = (venueId = 'venue_A') =>
  generateAccessToken('staff_1', 'org_1', venueId, StaffRole.CASHIER, undefined, { sid: 's1', pos: true })
const tokenDashboard = () => generateAccessToken('staff_1', 'org_1', 'venue_A', StaffRole.ADMIN, false, { sid: 's1' })
const terminar = () => new Promise(resolve => setImmediate(resolve))

describe('observador de la sesión del POS sin aparato — de punta a punta', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetDeviceSeenCache()
    mockRol.mockResolvedValue({ role: StaffRole.CASHIER, source: 'staffVenue' })
  })

  it('mobile.routes.ts captura el negocio de la ruta igual que esta app', () => {
    const rutas = fs.readFileSync(path.join(__dirname, '../../../src/routes/mobile.routes.ts'), 'utf8')
    expect(rutas).toMatch(/router\.use\(registerDeviceMiddleware\)\s*\n\s*router\.param\('venueId', capturarVenueDeLaRuta\)/)
  })

  it('token real del POS sin identidad de aparato ⇒ anota el negocio de la ruta', async () => {
    await request(app()).get('/api/v1/mobile/venues/venue_A/ping').set('Authorization', `Bearer ${tokenPos()}`).expect(200)
    await terminar()
    expect(mockPosSinAparato).toHaveBeenCalledWith('venue_A', expect.any(Date))
  })

  it('sesión de A en la ruta de B, con pertenencia a B ⇒ anota B', async () => {
    await request(app())
      .get('/api/v1/mobile/venues/venue_B/ping')
      .set('Authorization', `Bearer ${tokenPos('venue_A')}`)
      .expect(200)
    await terminar()
    expect(mockPosSinAparato).toHaveBeenCalledWith('venue_B', expect.any(Date))
  })

  it('🔴 N1: sesión de A en la ruta de B SIN pertenecer a B ⇒ 403 y no anota nada', async () => {
    mockRol.mockImplementation(async ({ targetVenueId }: { targetVenueId: string }) =>
      targetVenueId === 'venue_B' ? { role: null, source: 'none' } : { role: StaffRole.CASHIER, source: 'staffVenue' },
    )
    await request(app())
      .get('/api/v1/mobile/venues/venue_B/ping')
      .set('Authorization', `Bearer ${tokenPos('venue_A')}`)
      .expect(403)
    await terminar()
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('🔴 #3: la ruta de B falla con next(error) ⇒ anota B, no el negocio del token', async () => {
    await request(app())
      .get('/api/v1/mobile/venues/venue_B/falla')
      .set('Authorization', `Bearer ${tokenPos('venue_A')}`)
      .expect(400)
    await terminar()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(1)
    expect(mockPosSinAparato).toHaveBeenCalledWith('venue_B', expect.any(Date))
  })

  it('token real del dashboard (como Orders.tsx → /mobile/.../tables) ⇒ no anota', async () => {
    await request(app()).get('/api/v1/mobile/venues/venue_A/ping').set('Authorization', `Bearer ${tokenDashboard()}`).expect(200)
    await terminar()
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('token del POS alterado (firma rota) ⇒ 401 y no anota', async () => {
    const [cabecera, , firma] = tokenDashboard().split('.')
    const cuerpo = Buffer.from(
      JSON.stringify({ sub: 'staff_1', orgId: 'org_1', venueId: 'venue_A', role: 'ADMIN', origen: 'POS' }),
    ).toString('base64url')
    await request(app()).get('/api/v1/mobile/venues/venue_A/ping').set('Authorization', `Bearer ${cabecera}.${cuerpo}.${firma}`).expect(401)
    await terminar()
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('app nueva con identidad ⇒ no anota', async () => {
    await request(app())
      .get('/api/v1/mobile/venues/venue_A/ping')
      .set('Authorization', `Bearer ${tokenPos()}`)
      .set('X-Device-Id', 'device-abc')
      .set('X-Device-Platform', 'ANDROID')
      .expect(200)
    await terminar()
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })
})
