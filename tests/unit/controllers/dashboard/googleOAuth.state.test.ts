/**
 * 🔴 El `state` de Google (login CSRF), encontrado el 27-sep haciendo QA del alta con planes híbridos.
 *
 * Antes: la URL de Google no llevaba `state` y el callback canjeaba cualquier `code`. Un atacante sacaba
 * un `code` de SU cuenta de Google y le mandaba a la víctima
 * `https://dashboard.avoqado.io/auth/google/callback?code=…`: el navegador de la víctima terminaba el
 * login… dentro de la cuenta del atacante (y lo que capturara ahí, lo veía el atacante).
 *
 * Ahora: pedir la URL estrena un `state` al azar que viaja en la URL de Google Y en una cookie HttpOnly
 * de ESTE navegador; el callback sólo canjea si los dos coinciden, y la cookie se gasta en el intento.
 * El atacante puede poner el `state` que quiera en su liga, pero no puede leer ni escribir la cookie de
 * la víctima.
 *
 * Las pruebas usan un «navegador» de mentira: guarda lo que el servidor pone con `res.cookie` y borra lo
 * que quita con `res.clearCookie`, igual que un navegador real entre una petición y la siguiente.
 */
jest.mock('@/services/dashboard/googleOAuth.service', () => ({
  loginWithGoogle: jest.fn(),
  getGoogleAuthUrl: jest.fn((state: string) => `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`),
}))

import { getGoogleAuthUrl, googleOAuthCallback, GOOGLE_OAUTH_STATE_COOKIE } from '@/controllers/dashboard/googleOAuth.controller'
import { loginWithGoogle } from '@/services/dashboard/googleOAuth.service'

const login = loginWithGoogle as jest.Mock

function navegador() {
  const jar: Record<string, string> = {}
  const respuesta = () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    res.cookie = jest.fn((nombre: string, valor: string) => {
      jar[nombre] = valor
      return res
    })
    res.clearCookie = jest.fn((nombre: string) => {
      delete jar[nombre]
      return res
    })
    return res
  }

  async function pedirUrl() {
    const res = respuesta()
    const next = jest.fn()
    await getGoogleAuthUrl({ cookies: { ...jar } } as never, res as never, next)
    const authUrl: string = res.json.mock.calls[0][0].authUrl
    return { res, next, state: new URL(authUrl).searchParams.get('state') }
  }

  async function volverDeGoogle(body: Record<string, unknown>) {
    const res = respuesta()
    const next = jest.fn()
    const req = { body, cookies: { ...jar }, headers: {}, ip: '201.1.2.3', get: () => undefined }
    await googleOAuthCallback(req as never, res as never, next)
    return { res, next }
  }

  return { jar, pedirUrl, volverDeGoogle }
}

function rechazoPorState(next: jest.Mock) {
  expect(next).toHaveBeenCalledTimes(1)
  const error = next.mock.calls[0][0]
  expect(error).toMatchObject({ statusCode: 403, code: 'GOOGLE_OAUTH_STATE_INVALID' })
}

beforeEach(() => {
  jest.clearAllMocks()
  login.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staff: { id: 's' }, isNewUser: false })
})

describe('GET /auth/google/url — estrena el state', () => {
  it('🔴 la cookie HttpOnly y la URL de Google llevan el MISMO state, largo y de vida corta', async () => {
    const b = navegador()
    const { res, state } = await b.pedirUrl()

    expect(state).toEqual(expect.any(String))
    expect(state!.length).toBeGreaterThanOrEqual(32)
    expect(b.jar[GOOGLE_OAUTH_STATE_COOKIE]).toBe(state)
    const opciones = res.cookie.mock.calls[0][2]
    expect(opciones).toMatchObject({ httpOnly: true, path: '/api/v1/dashboard/auth/google' })
    expect(opciones.maxAge).toBeGreaterThan(0)
    expect(opciones.maxAge).toBeLessThanOrEqual(15 * 60 * 1000)
  })

  it('cada intento estrena un state distinto (nunca uno fijo que se pueda adivinar)', async () => {
    const b = navegador()
    const primero = await b.pedirUrl()
    const segundo = await b.pedirUrl()
    expect(primero.state).not.toBe(segundo.state)
  })
})

describe('POST /auth/google/callback — sólo canjea el state de ESTE navegador', () => {
  it('✅ el state coincide con la cookie: entra, y la cookie se gasta', async () => {
    const b = navegador()
    const { state } = await b.pedirUrl()

    const { res, next } = await b.volverDeGoogle({ code: 'c-1', state })

    expect(next).not.toHaveBeenCalled()
    expect(login).toHaveBeenCalledWith('c-1', true, undefined)
    expect(res.cookie).toHaveBeenCalledWith('accessToken', 'a', expect.anything())
    expect(b.jar[GOOGLE_OAUTH_STATE_COOKIE]).toBeUndefined()
  })

  it('🔴 login CSRF: la liga del atacante (su code y su state) en el navegador de la víctima NO entra', async () => {
    const atacante = navegador()
    const suyo = await atacante.pedirUrl()
    const victima = navegador()
    await victima.pedirUrl() // la víctima incluso tenía un intento propio a medias

    const { res, next } = await victima.volverDeGoogle({ code: 'code-del-atacante', state: suyo.state })

    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
    expect(res.cookie).not.toHaveBeenCalledWith('accessToken', expect.anything(), expect.anything())
  })

  it('🔴 sin state en el cuerpo (un cliente viejo o una liga armada a mano) → rechazado sin canjear', async () => {
    const b = navegador()
    await b.pedirUrl()
    const { next } = await b.volverDeGoogle({ code: 'c-1' })
    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
  })

  it('🔴 sin cookie (este navegador nunca pidió la URL de Google) → rechazado sin canjear', async () => {
    const b = navegador()
    const { next } = await b.volverDeGoogle({ code: 'c-1', state: 'x'.repeat(43) })
    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
  })

  it('🔴 un state ya usado no sirve una segunda vez', async () => {
    const b = navegador()
    const { state } = await b.pedirUrl()
    await b.volverDeGoogle({ code: 'c-1', state })

    const { next } = await b.volverDeGoogle({ code: 'c-1', state })

    rechazoPorState(next)
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('🔴 un intento rechazado también gasta la cookie (el state es de un solo intento)', async () => {
    const b = navegador()
    const { state } = await b.pedirUrl()
    await b.volverDeGoogle({ code: 'c-1', state: 'otro-state-que-no-es' })

    const { next } = await b.volverDeGoogle({ code: 'c-1', state })

    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
  })

  it('🔴 el camino alterno `token` (ID token) no se salta la prueba del state', async () => {
    const b = navegador()
    const { next } = await b.volverDeGoogle({ token: 'id-token-del-atacante' })
    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
  })

  it('un state que no es texto se trata como ausente', async () => {
    const b = navegador()
    const { state } = await b.pedirUrl()
    const { next } = await b.volverDeGoogle({ code: 'c-1', state: [state] })
    rechazoPorState(next)
    expect(login).not.toHaveBeenCalled()
  })
})
