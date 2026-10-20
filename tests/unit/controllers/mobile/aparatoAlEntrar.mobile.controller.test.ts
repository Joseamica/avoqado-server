/**
 * QA 16-oct-2026 (D3 nueva, venue «Avoqado Full»): al primer login la tablet pidió `display-mode-request` y
 * `area-ticket-settings` ~0.5 s ANTES de que el registro pasivo diera de alta el aparato (corre en `finish` de la
 * PRIMERA petición autenticada) → 404 DEVICE_NOT_FOUND y 409 DEVICE_NOT_REGISTERED. Ocho lugares del servidor exigen
 * que el aparato exista; la raíz es que el alta llega DESPUÉS de entrar.
 *
 * El arreglo: al ENTRAR (login, passkey y cambio de local por refresh) el aparato se da de alta ANTES de contestar,
 * con un tope para que una base lenta nunca frene la entrada.
 */
import type { NextFunction, Request, Response } from 'express'

const registerDeviceSeenMock = jest.fn()
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  __esModule: true,
  ensureDeviceTerminal: (...args: unknown[]) => registerDeviceSeenMock(...args),
  registerDeviceSeen: (...args: unknown[]) => registerDeviceSeenMock(...args),
  registerPosSinAparato: jest.fn(),
  POS_SIN_APARATO_MUESTREO_MS: 3_600_000,
}))

const loginWithEmailMock = jest.fn()
const refreshAccessTokenMock = jest.fn()
const verifyPasskeyAssertionMock = jest.fn()
jest.mock('@/services/mobile/auth.mobile.service', () => ({
  __esModule: true,
  loginWithEmail: (...a: unknown[]) => loginWithEmailMock(...a),
  refreshAccessToken: (...a: unknown[]) => refreshAccessTokenMock(...a),
  verifyPasskeyAssertion: (...a: unknown[]) => verifyPasskeyAssertionMock(...a),
}))

import { login, passkeyVerify, refresh } from '@/controllers/mobile/auth.mobile.controller'
import { __tamanoDelCacheDeAparatos, asegurarAparatoAlEntrar } from '@/middlewares/registerDevice.middleware'

const VENUE = 'cvenue000000000000000000a'
const STAFF = 'cstaff000000000000000000a'
const DEVICE = 'avq-device-7f3c9a21'

const conAparato = {
  'x-device-id': DEVICE,
  'x-device-platform': 'ANDROID',
  'x-device-manufacturer': 'SUNMI',
  'x-device-model': 'D3',
}

function req(body: Record<string, unknown>, headers: Record<string, string> = conAparato): Request {
  return { body, headers, params: {} } as unknown as Request
}

function res(orden: string[]) {
  const r: Partial<Response> & { locals: Record<string, unknown> } = { locals: {} }
  r.status = jest.fn().mockReturnValue(r)
  r.cookie = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockImplementation(() => {
    orden.push('respuesta')
    return r
  })
  return r as Response
}

const next: NextFunction = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  registerDeviceSeenMock.mockImplementation(async () => {
    return { terminalId: 'cterm0000000000000000000a', created: true }
  })
  loginWithEmailMock.mockResolvedValue({
    accessToken: 'a',
    refreshToken: 'r',
    staff: { id: STAFF },
    selectedVenueId: VENUE,
  })
  verifyPasskeyAssertionMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staff: { id: STAFF }, selectedVenueId: VENUE })
  refreshAccessTokenMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staffId: STAFF, venueId: VENUE })
})

describe('Al entrar, el aparato se da de alta ANTES de contestar', () => {
  it('P1 login: da de alta el aparato en la sucursal de la sesión antes de responder', async () => {
    const orden: string[] = []
    registerDeviceSeenMock.mockImplementation(async () => {
      orden.push('alta')
      return { terminalId: 'x', created: true }
    })

    await login(req({ email: 'a@b.com', password: 'x' }), res(orden), next)

    expect(registerDeviceSeenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE,
        staffId: STAFF,
        identity: expect.objectContaining({ deviceUid: DEVICE, platform: 'ANDROID' }),
      }),
    )
    expect(orden).toEqual(['alta', 'respuesta'])
  })

  it('P1 passkey: igual que el login', async () => {
    const orden: string[] = []
    registerDeviceSeenMock.mockImplementation(async () => {
      orden.push('alta')
      return { terminalId: 'x', created: true }
    })

    await passkeyVerify(req({ credential: { id: 'c', response: {} }, challengeKey: 'k' }), res(orden), next)

    expect(registerDeviceSeenMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, staffId: STAFF }))
    expect(orden).toEqual(['alta', 'respuesta'])
  })

  it('P1 cambio de sucursal por refresh: da de alta el aparato en la sucursal NUEVA', async () => {
    const orden: string[] = []
    registerDeviceSeenMock.mockImplementation(async () => {
      orden.push('alta')
      return { terminalId: 'x', created: true }
    })

    await refresh(req({ refreshToken: 'r', venueId: VENUE }), res(orden), next)

    expect(registerDeviceSeenMock).toHaveBeenCalledWith(expect.objectContaining({ venueId: VENUE, staffId: STAFF }))
    expect(orden).toEqual(['alta', 'respuesta'])
  })

  it('el refresh de cada 10 min (sin cambio de sucursal) NO toca el registro: lo hace el pasivo como siempre', async () => {
    await refresh(req({ refreshToken: 'r' }), res([]), next)
    expect(registerDeviceSeenMock).not.toHaveBeenCalled()
  })

  it('una app vieja sin identidad de aparato entra igual, sin alta', async () => {
    const r = res([])
    await login(req({ email: 'a@b.com', password: 'x' }, {}), r, next)
    expect(registerDeviceSeenMock).not.toHaveBeenCalled()
    expect(r.status).toHaveBeenCalledWith(200)
  })

  it('una base lenta NUNCA frena la entrada más que el tope', async () => {
    jest.useFakeTimers()
    try {
      registerDeviceSeenMock.mockImplementation(() => new Promise(() => {})) // nunca contesta
      const r = res([])
      const enCurso = login(req({ email: 'a@b.com', password: 'x' }), r, next)
      await jest.advanceTimersByTimeAsync(2_500)
      await enCurso
      expect(r.status).toHaveBeenCalledWith(200)
    } finally {
      jest.useRealTimers()
    }
  })

  it('si el alta falla, el login contesta igual (nunca bloquea)', async () => {
    registerDeviceSeenMock.mockResolvedValue(null)
    const r = res([])
    await login(req({ email: 'a@b.com', password: 'x' }), r, next)
    expect(r.status).toHaveBeenCalledWith(200)
    expect(next).not.toHaveBeenCalled()
  })

  it('P3 miles de aparatos distintos no inflan la memoria del proceso más allá de su tope (Codex)', async () => {
    for (let n = 0; n < 10_050; n++) {
      await asegurarAparatoAlEntrar(req({}, { 'x-device-id': `aparato-${n}`, 'x-device-platform': 'ANDROID' }), VENUE, STAFF)
    }
    expect(__tamanoDelCacheDeAparatos()).toBeLessThanOrEqual(10_000)
  })
})
