/**
 * El pase de Google del POS (hz:6bfcd3a1:D1): ANDROID por la vuelta del SERVIDOR (cliente web + PKCE) y WINDOWS con su
 * canje de escritorio de siempre.
 */
const verifyIdToken = jest.fn()
const getToken = jest.fn()
const ctor = jest.fn()
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation((...a: any[]) => {
    ctor(...a)
    return { verifyIdToken: (...x: any[]) => verifyIdToken(...x), getToken: (...x: any[]) => getToken(...x) }
  }),
}))

import logger from '@/config/logger'
import {
  configDeGoogleParaElPos,
  guardarVuelta,
  leerPaseDeAndroid,
  leerPaseDeEscritorio,
  tomarCodigo,
  vaciarVueltasSoloPruebas,
} from '../../../../src/services/auth/google/paseDeGoogleDelPos'

const WEB = 'pos-web-id.apps.test'
const REDIRECT = 'https://api.test/api/v1/mobile/auth/google/vuelta'
const STATE = 'S'.repeat(43)
const VERIFIER = 'VERIF-X'.repeat(8)
const CODIGO = '4/0Ab-CODIGO-SECRETO'
const estado = (i: number) => String(i).padStart(43, 'e')
const payload = () => ({
  getPayload: () => ({ sub: 'g-1', email: 'a@b.test', email_verified: true, hd: 'b.test', picture: 'https://p.test/x.png' }),
})
const MIN = 60_000

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-26T12:00:00Z'))
  vaciarVueltasSoloPruebas()
  verifyIdToken.mockReset()
  getToken.mockReset()
  ctor.mockReset()
  process.env.GOOGLE_POS_WEB_CLIENT_ID = WEB
  process.env.GOOGLE_POS_WEB_CLIENT_SECRET = 'web-secret'
  process.env.GOOGLE_POS_REDIRECT_URI = REDIRECT
  process.env.GOOGLE_POS_DESKTOP_CLIENT_ID = 'desk-id'
  process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET = 'desk-secret'
})
afterEach(() => jest.useRealTimers())

const invalido = {
  code: 'GOOGLE_TOKEN_INVALID',
  statusCode: 401,
  message: 'No pudimos confirmar tu cuenta de Google. Vuelve a intentarlo.',
}
const noConfigurado = { code: 'GOOGLE_ANDROID_NOT_CONFIGURED', statusCode: 503 }
const VARIABLES_WEB = ['GOOGLE_POS_WEB_CLIENT_ID', 'GOOGLE_POS_WEB_CLIENT_SECRET', 'GOOGLE_POS_REDIRECT_URI']

describe('vueltas guardadas (guardarVuelta / tomarCodigo)', () => {
  it('tomarCodigo dos veces ⇒ la segunda null', () => {
    guardarVuelta(STATE, CODIGO)
    expect(tomarCodigo(STATE)).toBe(CODIGO)
    expect(tomarCodigo(STATE)).toBeNull()
  })
  it('state que nunca llegó ⇒ null', () => {
    expect(tomarCodigo(STATE)).toBeNull()
  })
  it('vuelta repetida tras tomar no la revive', () => {
    guardarVuelta(STATE, CODIGO)
    tomarCodigo(STATE)
    guardarVuelta(STATE, '4/0Ab-OTRO-CODIGO')
    expect(tomarCodigo(STATE)).toBeNull()
  })
  it('a los 5 min ⇒ null; antes, todavía sirve', () => {
    guardarVuelta(STATE, CODIGO)
    guardarVuelta(estado(1), CODIGO)
    jest.setSystemTime(Date.now() + 5 * MIN - 1)
    expect(tomarCodigo(estado(1))).toBe(CODIGO)
    jest.setSystemTime(Date.now() + 1)
    expect(tomarCodigo(STATE)).toBeNull()
  })
  it('barre los vencidos al escribir', () => {
    guardarVuelta(STATE, CODIGO)
    jest.setSystemTime(Date.now() + 6 * MIN)
    guardarVuelta(STATE, '4/0Ab-NUEVO')
    expect(tomarCodigo(STATE)).toBe('4/0Ab-NUEVO')
  })
  it('con 10,000 guardados, uno más saca al más viejo', () => {
    for (let i = 0; i < 10_000; i++) guardarVuelta(estado(i), CODIGO)
    guardarVuelta(STATE, CODIGO)
    expect(tomarCodigo(estado(0))).toBeNull()
    expect(tomarCodigo(estado(1))).toBe(CODIGO)
    expect(tomarCodigo(STATE)).toBe(CODIGO)
  })
})

describe('leerPaseDeAndroid', () => {
  it('state desconocido ⇒ 401 GOOGLE_TOKEN_INVALID y getToken no se llamó', async () => {
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    expect(getToken).not.toHaveBeenCalled()
    expect(ctor).not.toHaveBeenCalled()
  })
  it('POST bueno ⇒ getToken con el id, secreto y redirectUri del web y verifyIdToken con audience = web', async () => {
    guardarVuelta(STATE, CODIGO)
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockResolvedValue(payload())
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).resolves.toEqual({
      sub: 'g-1',
      email: 'a@b.test',
      emailVerified: true,
      hd: 'b.test',
      picture: 'https://p.test/x.png',
    })
    expect(ctor).toHaveBeenCalledWith(WEB, 'web-secret')
    expect(getToken).toHaveBeenCalledWith({ code: CODIGO, codeVerifier: VERIFIER, redirect_uri: REDIRECT })
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: WEB })
  })
  it('el mismo state dos veces ⇒ la segunda 401 sin hablar con Google', async () => {
    guardarVuelta(STATE, CODIGO)
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockResolvedValue(payload())
    await leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })
    getToken.mockClear()
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    expect(getToken).not.toHaveBeenCalled()
  })
  it('vuelta repetida tras tomar ⇒ el POST siguiente sigue en 401', async () => {
    guardarVuelta(STATE, CODIGO)
    getToken.mockRejectedValue(new Error('invalid_grant'))
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    guardarVuelta(STATE, CODIGO)
    getToken.mockClear()
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    expect(getToken).not.toHaveBeenCalled()
  })
  it('state vencido (5 min) ⇒ 401 sin hablar con Google', async () => {
    guardarVuelta(STATE, CODIGO)
    jest.setSystemTime(Date.now() + 5 * MIN)
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    expect(getToken).not.toHaveBeenCalled()
  })
  it.each([
    ['getToken falla (verificador equivocado)', () => getToken.mockRejectedValue(new Error('invalid_grant'))],
    ['sin id_token', () => getToken.mockResolvedValue({ tokens: {} })],
    [
      'verifyIdToken falla',
      () => {
        getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
        verifyIdToken.mockRejectedValue(new Error('Wrong recipient'))
      },
    ],
  ])('%s ⇒ 401 GOOGLE_TOKEN_INVALID', async (_caso, preparar) => {
    guardarVuelta(STATE, CODIGO)
    preparar()
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
  })
  it.each(VARIABLES_WEB)('sin %s ⇒ 503 y la vuelta no se gasta', async variable => {
    guardarVuelta(STATE, CODIGO)
    const antes = process.env[variable]
    delete process.env[variable]
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(noConfigurado)
    expect(getToken).not.toHaveBeenCalled()
    process.env[variable] = antes
    expect(tomarCodigo(STATE)).toBe(CODIGO)
  })
})

describe('leerPaseDeEscritorio', () => {
  const p = { code: 'c', codeVerifier: 'v'.repeat(50), redirectUri: 'http://127.0.0.1:5123/cb' }
  it('canjea con codeVerifier y redirect_uri exactos y revisa con el id de escritorio', async () => {
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockResolvedValue(payload())
    const u = await leerPaseDeEscritorio(p)
    expect(ctor).toHaveBeenCalledWith('desk-id', 'desk-secret')
    expect(getToken).toHaveBeenCalledWith({ code: 'c', codeVerifier: p.codeVerifier, redirect_uri: p.redirectUri })
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'idt', audience: 'desk-id' })
    expect(u.sub).toBe('g-1')
  })
  it('sin id_token => GOOGLE_TOKEN_INVALID', async () => {
    getToken.mockResolvedValue({ tokens: {} })
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject(invalido)
  })
  it('getToken falla => GOOGLE_TOKEN_INVALID', async () => {
    getToken.mockRejectedValue(new Error('invalid_grant'))
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject(invalido)
  })
  it('sin secreto => 503', async () => {
    delete process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
    await expect(leerPaseDeEscritorio(p)).rejects.toMatchObject({ code: 'GOOGLE_DESKTOP_NOT_CONFIGURED', statusCode: 503 })
  })
  it('no toca las vueltas de ANDROID', async () => {
    guardarVuelta(STATE, CODIGO)
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockResolvedValue(payload())
    await leerPaseDeEscritorio(p)
    expect(tomarCodigo(STATE)).toBe(CODIGO)
  })
})

describe('registro de rechazos', () => {
  const todoLoRegistrado = () => JSON.stringify((logger.warn as jest.Mock).mock.calls)

  it('el rechazo no registra el code, el state, el verificador ni el secreto', async () => {
    const err: any = new Error('invalid_grant')
    err.config = { client_secret: 'web-secret', code: CODIGO }
    guardarVuelta(STATE, CODIGO)
    getToken.mockRejectedValue(err)
    ;(logger.warn as jest.Mock).mockClear()
    await expect(leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER })).rejects.toMatchObject(invalido)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const logged = todoLoRegistrado()
    expect(logged).toContain('canje-fallido')
    expect(logged).toContain('invalid_grant')
    for (const secreto of [CODIGO, STATE, VERIFIER, 'web-secret']) expect(logged).not.toContain(secreto)
  })
  it('state desconocido queda en el log sin el state', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    await leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER }).catch(() => {})
    const logged = todoLoRegistrado()
    expect(logged).toContain('vuelta-desconocida')
    expect(logged).not.toContain(STATE)
  })
  it.each([
    ['Wrong number of segments in token: SECRETO', 'SECRETO', 'Wrong number of segments in token'],
    ['Token used too late, 1 > 2: {"email":"x@y.com"}', 'x@y.com', 'Token used too late, 1 > 2'],
  ])('mensaje de la librería %s se recorta antes de ":"', async (msg, secreto, esperado) => {
    guardarVuelta(STATE, CODIGO)
    getToken.mockResolvedValue({ tokens: { id_token: 'idt' } })
    verifyIdToken.mockRejectedValue(new Error(msg))
    ;(logger.warn as jest.Mock).mockClear()
    await leerPaseDeAndroid({ state: STATE, codeVerifier: VERIFIER }).catch(() => {})
    const logged = todoLoRegistrado()
    expect(logged).toContain('verificacion-fallida')
    expect(logged).toContain(esperado)
    expect(logged).not.toContain(secreto)
  })
  it('canje fallido de escritorio también queda en el log, sin code ni verificador', async () => {
    ;(logger.warn as jest.Mock).mockClear()
    getToken.mockRejectedValue(new Error('invalid_grant'))
    await leerPaseDeEscritorio({ code: 'CODIGO-X', codeVerifier: VERIFIER, redirectUri: 'http://127.0.0.1:5/cb' }).catch(() => {})
    const logged = todoLoRegistrado()
    expect(logged).toContain('canje-fallido')
    expect(logged).not.toMatch(/CODIGO-X|VERIF-X/)
  })
})

describe('configDeGoogleParaElPos', () => {
  it('config con las tres variables ⇒ android true, webClientId y redirectUri (sin audiencia ni nonce)', () => {
    expect(configDeGoogleParaElPos()).toEqual({
      android: true,
      windows: true,
      webClientId: WEB,
      redirectUri: REDIRECT,
      desktopClientId: 'desk-id',
    })
  })
  it.each(VARIABLES_WEB)('falta %s ⇒ android false y nulls', variable => {
    delete process.env[variable]
    expect(configDeGoogleParaElPos()).toMatchObject({ android: false, webClientId: null, redirectUri: null, windows: true })
  })
  it('ningún secreto sale; sin secreto de escritorio: windows false y su id null', () => {
    expect(JSON.stringify(configDeGoogleParaElPos())).not.toMatch(/secret/)
    delete process.env.GOOGLE_POS_DESKTOP_CLIENT_SECRET
    expect(configDeGoogleParaElPos()).toMatchObject({ windows: false, desktopClientId: null, android: true })
  })
})
