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
import { autenticarSesionDeCampo, guardarCuerpoDelCelular } from '@/middlewares/autenticarSesionDeCampo.middleware'
import logger from '@/config/logger'
import { reconciliarConLaRutaNormal } from '@/services/tpv/campo/celular/graciaDelCelular.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { celularDeCampo: { findUnique: jest.fn() } } }))
jest.mock('@/services/auth/sessionCache', () => ({ isSessionAliveCached: jest.fn() }))
jest.mock('@/utils/passwordChangeGuard', () => ({ motivoDeSesionInvalidada: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/personasDeCampo', () => ({ sucursalesDeLaPersona: jest.fn() }))
jest.mock('@/observability/executionContext', () => ({ enrichContext: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/graciaDelCelular.service', () => ({ reconciliarConLaRutaNormal: jest.fn() }))

const db = prisma as any
const viva = isSessionAliveCached as jest.Mock
const corte = motivoDeSesionInvalidada as jest.Mock
const sucursales = sucursalesDeLaPersona as jest.Mock
const reconciliar = reconciliarConLaRutaNormal as jest.Mock

const celular = { id: 'cel1', organizationId: 'org1', staffId: 'staff1', staffIdVinculado: 'staff1', sesionId: 'ses1' }
const deCampo = (extra: Partial<{ venueId: string; sid: string; role: 'CASHIER' | 'WAITER' }> = {}) =>
  firmarAccesoDeCampo({ staffId: 'staff1', organizationId: 'org1', venueId: 'vA', role: 'CASHIER', sid: 'ses1', ...extra })
const sucursal = (venueId: string, role = 'CASHIER') => ({ staffVenueId: `sv-${venueId}`, venueId, nombre: venueId, role, pin: '1234' })

const app = express()
// Como `configureCoreMiddlewares`: el parser global con el `verify` que guarda el texto crudo sólo del celular (arreglo 9).
app.use(express.json({ verify: guardarCuerpoDelCelular }))
app.get('/venues/:venueId/x', autenticarSesionDeCampo, (req: Request, res: Response) =>
  res.json({ authContext: req.authContext, celularId: res.locals.celular.id }),
)
// Las rutas del bloque 0 (R5-1): lo que contesta el controlador lo decide la prueba.
let respuesta = { status: 201, body: { ok: true } as object }
const campo = express.Router()
for (const ruta of ['ventas', 'custodia/aceptar', 'custodia/rechazar', 'checadas/entrada', 'checadas/salida', 'evidencia']) {
  campo.post(`/venues/:venueId/${ruta}`, autenticarSesionDeCampo, (_req: Request, res: Response) =>
    res.status(respuesta.status).json(respuesta.body),
  )
}
app.use('/api/v1/tpv/campo', campo)
// Fuera del celular de campo (p. ej. una ruta de la TPV): el texto crudo NO se guarda.
app.post('/api/v1/tpv/:tpvId/cualquiera', (req: Request, res: Response) => res.json({ crudo: req.rawBody ?? null, body: req.body }))
app.post('/api/v1/tpv/campo/gracia', (req: Request, res: Response) => res.json({ crudo: req.rawBody ?? null }))
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
  reconciliar.mockResolvedValue(0)
  respuesta = { status: 201, body: { ok: true } }
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

describe('R5-1 · el que aplicó gana también por la ruta normal: al terminar en 2xx se reconcilian los retenidos de ESE celular', () => {
  const tick = () => new Promise(r => setImmediate(r))
  /** El texto EXACTO que manda el celular (con su orden y espacios): el gancho busca su huella. */
  const TEXTO = '{"llave":"k-1",  "serialNumber":"8952","precioVisto":0}'
  const mandar = (ruta: string, token = deCampo()) =>
    request(app)
      .post(`/api/v1/tpv/campo/venues/vA/${ruta}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send(TEXTO)

  it.each([
    ['ventas', 'VENTA'],
    ['custodia/aceptar', 'CUSTODIA_ACEPTAR'],
    ['custodia/rechazar', 'CUSTODIA_RECHAZAR'],
    ['checadas/entrada', 'ENTRADA'],
    ['checadas/salida', 'SALIDA'],
  ])('POST %s en 2xx → reconciliar(celular, sucursal, %s, el texto EXACTO del cuerpo) DESPUÉS de contestar', async (ruta, tipo) => {
    const r = await mandar(ruta)
    expect(r.status).toBe(201)
    while (!reconciliar.mock.calls.length) await tick()
    expect(reconciliar).toHaveBeenCalledTimes(1)
    expect(reconciliar).toHaveBeenCalledWith('cel1', 'vA', tipo, TEXTO)
  })

  it('la evidencia no se reconcilia por la ruta normal: su cuerpo (paymentId) no es el de la gracia (ventaLlave)', async () => {
    expect((await mandar('evidencia')).status).toBe(201)
    for (let i = 0; i < 5; i++) await tick()
    expect(reconciliar).not.toHaveBeenCalled()
  })

  it('req.rawBody sólo se llena en /api/v1/tpv/campo/venues/…: ni en otra ruta de la TPV ni en la gracia', async () => {
    const otra = await request(app).post('/api/v1/tpv/t1/cualquiera').set('Content-Type', 'application/json').send(TEXTO)
    expect(otra.body).toEqual({ crudo: null, body: { llave: 'k-1', serialNumber: '8952', precioVisto: 0 } })
    const gracia = await request(app).post('/api/v1/tpv/campo/gracia').set('Content-Type', 'application/json').send(TEXTO)
    expect(gracia.body).toEqual({ crudo: null })
  })

  it('un rechazo de la ruta (4xx), un candado que no la deja pasar o el GET de prueba → no se reconcilia nada', async () => {
    respuesta = { status: 409, body: { code: 'VENTA_EN_PROCESO' } }
    expect((await mandar('ventas')).status).toBe(409)
    expect((await mandar('ventas', deCampo({ sid: 'ses-vieja' }))).status).toBe(401)
    expect((await pedir(deCampo())).status).toBe(200)
    for (let i = 0; i < 5; i++) await tick()
    expect(reconciliar).not.toHaveBeenCalled()
  })

  it('si la reconciliación falla, la respuesta normal no cambia: sólo queda un logger.warn', async () => {
    const aviso = jest.spyOn(logger, 'warn').mockImplementation(() => logger)
    reconciliar.mockRejectedValue(new Error('base caída'))
    respuesta = { status: 200, body: { orderId: 'o1', repetida: true } }

    const r = await mandar('ventas')

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ orderId: 'o1', repetida: true })
    while (!aviso.mock.calls.length) await tick()
    expect(aviso).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ celularId: 'cel1', venueId: 'vA', tipo: 'VENTA' }))
    aviso.mockRestore()
  })
})
