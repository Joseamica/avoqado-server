/**
 * Entrar con Google en el POS (hz:6bfcd3a1:D1): controlador + validación real del cuerpo.
 */
import type { NextFunction, Request, Response } from 'express'

const registerDeviceSeenMock = jest.fn()
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  __esModule: true,
  ensureDeviceTerminal: (...a: unknown[]) => registerDeviceSeenMock(...a),
  registerDeviceSeen: (...a: unknown[]) => registerDeviceSeenMock(...a),
  registerPosSinAparato: jest.fn(),
  POS_SIN_APARATO_MUESTREO_MS: 3_600_000,
}))

const entrarMock = jest.fn()
jest.mock('@/services/mobile/googleLogin.mobile.service', () => ({
  __esModule: true,
  entrarAlPosConGoogle: (...a: unknown[]) => entrarMock(...a),
}))

// La config va mockeada; las vueltas (guardarVuelta / tomarCodigo) son las de verdad.
const configMock = jest.fn()
jest.mock('@/services/auth/google/paseDeGoogleDelPos', () => ({
  __esModule: true,
  ...jest.requireActual('@/services/auth/google/paseDeGoogleDelPos'),
  configDeGoogleParaElPos: (...a: unknown[]) => configMock(...a),
}))

import express from 'express'
import request from 'supertest'
import logger from '@/config/logger'
import { googleConfig, googleLogin, googleVuelta } from '@/controllers/mobile/auth.mobile.controller'
import { googleLoginSchema } from '@/schemas/mobile/googleLogin.mobile.schema'
import { validateRequest } from '@/middlewares/validation'
import { requestLoggerMiddleware } from '@/middlewares/requestLogger'
import { tomarCodigo, vaciarVueltasSoloPruebas } from '@/services/auth/google/paseDeGoogleDelPos'

const VENUE = 'cvenue000000000000000000a'
const STAFF = 'cstaff000000000000000000a'
const DEVICE = 'avq-device-7f3c9a21'
const headers = { 'x-device-id': DEVICE, 'x-device-platform': 'ANDROID', 'x-device-manufacturer': 'SUNMI', 'x-device-model': 'D3' }

const req = (body: unknown, h: Record<string, string> = headers) => ({ body, headers: h, params: {} }) as unknown as Request
function res() {
  const r: any = { locals: {} }
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r as Response
}

const VERIFIER = 'a'.repeat(43)
const STATE = 'S'.repeat(43)
const android = (o: Record<string, unknown> = {}) => ({ state: STATE, codeVerifier: VERIFIER, ...o })
const desktop = (o: Record<string, unknown> = {}) => ({ code: 'c', codeVerifier: VERIFIER, redirectUri: 'http://127.0.0.1:54321', ...o })

async function validar(body: unknown) {
  const next = jest.fn()
  const r = res()
  await validateRequest(googleLoginSchema)(req(body), r, next as unknown as NextFunction)
  return { next, r }
}

beforeEach(() => {
  jest.clearAllMocks()
  vaciarVueltasSoloPruebas()
  registerDeviceSeenMock.mockResolvedValue({ terminalId: 'cterm0000000000000000000a', created: true })
  entrarMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staff: { id: STAFF }, selectedVenueId: VENUE })
})

describe('POST /mobile/auth/google (controlador)', () => {
  it('responde con la misma forma que /auth/login', async () => {
    const r = res()
    await googleLogin(req(android()), r, jest.fn())
    expect(r.status).toHaveBeenCalledWith(200)
    expect(r.json).toHaveBeenCalledWith({
      success: true,
      message: 'Login exitoso',
      user: { id: STAFF },
      accessToken: 'a',
      refreshToken: 'r',
      selectedVenueId: VENUE,
    })
  })

  it('pasa X-Device-Id y registra el aparato', async () => {
    await googleLogin(req(android({ rememberMe: true })), res(), jest.fn())
    expect(entrarMock).toHaveBeenCalledWith(android(), true, DEVICE)
    expect(registerDeviceSeenMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, staffId: STAFF }))
  })

  it('variante de escritorio: pasa code, codeVerifier y redirectUri', async () => {
    await googleLogin(req(desktop()), res(), jest.fn())
    expect(entrarMock).toHaveBeenCalledWith(desktop(), undefined, DEVICE)
  })

  it('un error del servicio va a next', async () => {
    const e = new Error('x')
    entrarMock.mockRejectedValue(e)
    const next = jest.fn()
    await googleLogin(req(android()), res(), next)
    expect(next).toHaveBeenCalledWith(e)
  })
})

describe('GET /mobile/auth/google/config', () => {
  it('devuelve la config sin secreto', async () => {
    const config = { android: true, windows: false, webClientId: 'w', redirectUri: 'https://api.test/vuelta', desktopClientId: null }
    configMock.mockReturnValue(config)
    const r = res()
    await googleConfig(req({}), r, jest.fn())
    expect(r.json).toHaveBeenCalledWith({ success: true, ...config })
    expect(JSON.stringify((r.json as jest.Mock).mock.calls[0][0])).not.toMatch(/secret/i)
  })
})

describe('validación del cuerpo', () => {
  it('acepta las dos variantes buenas', async () => {
    expect((await validar(android())).next).toHaveBeenCalledWith()
    expect((await validar(android({ rememberMe: true, codeVerifier: 'b'.repeat(128) }))).next).toHaveBeenCalledWith()
    expect((await validar(desktop({ rememberMe: false }))).next).toHaveBeenCalledWith()
    expect((await validar(desktop({ redirectUri: 'http://127.0.0.1:1024' }))).next).toHaveBeenCalledWith()
    expect((await validar(desktop({ redirectUri: 'http://127.0.0.1:65535' }))).next).toHaveBeenCalledWith()
  })

  it.each([
    ['https://evil.example/cb'],
    ['http://localhost:5000'],
    ['http://127.0.0.1.evil.com:80'],
    ['http://127.0.0.1:80'],
    ['http://127.0.0.1:65536'],
    ['http://127.0.0.1:54321/x'],
  ])('redirectUri %s => 400', async uri => {
    const { next } = await validar(desktop({ redirectUri: uri }))
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
  })

  it('codeVerifier con "+" => 400', async () => {
    const { next } = await validar(desktop({ codeVerifier: 'a'.repeat(42) + '+' }))
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
  })

  it.each([
    ['cuerpo con idToken (la variante vieja ya no existe)', { idToken: 'x' }],
    ['idToken con state', android({ idToken: 'x' })],
    ['state y code a la vez', { ...android(), code: 'c', redirectUri: 'http://127.0.0.1:54321' }],
    ['state con code null', android({ code: null })],
    ['cuerpo vacío', {}],
    ['state de 42', android({ state: 'S'.repeat(42) })],
    ['state de 44', android({ state: 'S'.repeat(44) })],
    ['state con "+"', android({ state: 'S'.repeat(42) + '+' })],
    ['sin verificador', { state: STATE }],
    ['verificador de 42', android({ codeVerifier: 'a'.repeat(42) })],
    ['verificador de 129', android({ codeVerifier: 'a'.repeat(129) })],
  ])('%s => 400', async (_n, body) => {
    const { next } = await validar(body)
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
    expect(entrarMock).not.toHaveBeenCalled()
  })
})

describe('GET /mobile/auth/google/vuelta', () => {
  const RUTA = '/api/v1/mobile/auth/google/vuelta'
  const CODIGO = '4/0Ab-CODIGO-SECRETO_x.y'
  const TEXTO_400 = 'Vuelve al POS y toca otra vez «Continuar con Google».'
  const app = express()
  app.use(requestLoggerMiddleware)
  app.get(RUTA, googleVuelta)
  const vuelta = (q: Record<string, string | string[]>) => request(app).get(RUTA).query(q)

  it('vuelta con code ⇒ 302 a avoqado-pos://google?state=… con no-store, y el código queda guardado', async () => {
    const r = await vuelta({ state: STATE, code: CODIGO, scope: 'openid email' })
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`avoqado-pos://google?state=${STATE}`)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(tomarCodigo(STATE)).toBe(CODIGO)
  })

  it.each([
    ['error=access_denied', { error: 'access_denied' }, 'access_denied'],
    ['error=access_denied con code', { error: 'access_denied', code: CODIGO }, 'access_denied'],
    ['error raro', { error: 'Access-Denied<script>' }, 'sin_codigo'],
    ['error de 41', { error: 'a'.repeat(41) }, 'sin_codigo'],
    ['error vacío', { error: '' }, 'sin_codigo'],
    ['sin code', {}, 'sin_codigo'],
    ['code largo (513)', { code: 'c'.repeat(513) }, 'sin_codigo'],
    ['code corto (9)', { code: 'c'.repeat(9) }, 'sin_codigo'],
    ['code con caracteres raros', { code: '4/0Ab CODIGO&x=1' }, 'sin_codigo'],
    ['code repetido', { code: [CODIGO, CODIGO] }, 'sin_codigo'],
  ])('%s ⇒ 302 con &error=%s y nada guardado', async (_caso, q, error) => {
    const r = await vuelta({ state: STATE, ...q })
    expect(r.status).toBe(302)
    expect(r.headers.location).toBe(`avoqado-pos://google?state=${STATE}&error=${error}`)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(tomarCodigo(STATE)).toBeNull()
  })

  it.each([
    ['sin state', { code: CODIGO }],
    ['state de 42', { state: 'S'.repeat(42), code: CODIGO }],
    ['state de 44', { state: 'S'.repeat(44), code: CODIGO }],
    ['state con "+"', { state: 'S'.repeat(42) + '+', code: CODIGO }],
    ['state repetido', { state: [STATE, STATE], code: CODIGO }],
  ])('%s ⇒ 400 texto plano y nada guardado', async (_caso, q) => {
    const r = await vuelta(q)
    expect(r.status).toBe(400)
    expect(r.headers['content-type']).toMatch(/^text\/plain/)
    expect(r.text).toBe(TEXTO_400)
    expect(r.headers.location).toBeUndefined()
    expect(tomarCodigo(STATE)).toBeNull()
  })

  it('segunda vuelta con el mismo state no pisa la primera', async () => {
    await vuelta({ state: STATE, code: CODIGO })
    const r = await vuelta({ state: STATE, code: '4/0Ab-OTRO-CODIGO' })
    expect(r.status).toBe(302)
    expect(tomarCodigo(STATE)).toBe(CODIGO)
  })

  it('la vuelta no registra el code (ni el registro de peticiones)', async () => {
    await vuelta({ state: STATE, code: CODIGO })
    const logger_ = logger as unknown as Record<string, jest.Mock>
    const logged = JSON.stringify(['info', 'warn', 'error', 'debug', 'log'].map(n => logger_[n].mock.calls))
    expect(logged).toContain('/vuelta')
    expect(logged).not.toContain('CODIGO-SECRETO')
  })
})
