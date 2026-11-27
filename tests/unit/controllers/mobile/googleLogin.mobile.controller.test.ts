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

const configMock = jest.fn()
jest.mock('@/services/auth/google/paseDeGoogleDelPos', () => ({
  __esModule: true,
  configDeGoogleParaElPos: (...a: unknown[]) => configMock(...a),
}))

import { googleConfig, googleLogin } from '@/controllers/mobile/auth.mobile.controller'
import { googleLoginSchema } from '@/schemas/mobile/googleLogin.mobile.schema'
import { validateRequest } from '@/middlewares/validation'

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
const desktop = (o: Record<string, unknown> = {}) => ({ code: 'c', codeVerifier: VERIFIER, redirectUri: 'http://127.0.0.1:54321', ...o })

async function validar(body: unknown) {
  const next = jest.fn()
  const r = res()
  await validateRequest(googleLoginSchema)(req(body), r, next as unknown as NextFunction)
  return { next, r }
}

beforeEach(() => {
  jest.clearAllMocks()
  registerDeviceSeenMock.mockResolvedValue({ terminalId: 'cterm0000000000000000000a', created: true })
  entrarMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staff: { id: STAFF }, selectedVenueId: VENUE })
})

describe('POST /mobile/auth/google (controlador)', () => {
  it('responde con la misma forma que /auth/login', async () => {
    const r = res()
    await googleLogin(req({ idToken: 'tok' }), r, jest.fn())
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
    await googleLogin(req({ idToken: 'tok', rememberMe: true }), res(), jest.fn())
    expect(entrarMock).toHaveBeenCalledWith({ idToken: 'tok' }, true, DEVICE)
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
    await googleLogin(req({ idToken: 'tok' }), res(), next)
    expect(next).toHaveBeenCalledWith(e)
  })
})

describe('GET /mobile/auth/google/config', () => {
  it('devuelve la config sin secreto', async () => {
    configMock.mockReturnValue({ androidAudience: 'aud', nonce: 'n', desktopClientId: 'd', android: true, windows: false })
    const r = res()
    await googleConfig(req({}), r, jest.fn())
    expect(r.json).toHaveBeenCalledWith({
      success: true,
      androidAudience: 'aud',
      nonce: 'n',
      desktopClientId: 'd',
      android: true,
      windows: false,
    })
    expect(JSON.stringify((r.json as jest.Mock).mock.calls[0][0])).not.toMatch(/secret/i)
  })
})

describe('validación del cuerpo', () => {
  it('acepta las dos variantes buenas', async () => {
    expect((await validar({ idToken: 'tok' })).next).toHaveBeenCalledWith()
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
    ['idToken y code a la vez', { idToken: 'x', ...desktop() }],
    ['idToken con code null', { idToken: 'x', code: null }],
    ['cuerpo vacío', {}],
    ['idToken vacío', { idToken: '' }],
  ])('%s => 400', async (_n, body) => {
    const { next } = await validar(body)
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
    expect(entrarMock).not.toHaveBeenCalled()
  })
})
