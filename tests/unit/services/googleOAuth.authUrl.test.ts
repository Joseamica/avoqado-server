/**
 * La URL que manda a la persona a Google lleva el `state` que el controlador guardó en su cookie: Google
 * lo devuelve tal cual al regresar, y es lo que el callback compara. Sin él, el callback no tiene nada
 * que comparar (login CSRF, 27-sep). Se usa el `OAuth2Client` REAL: armar la URL no toca la red.
 */
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

function servicio() {
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_CLIENT_SECRET = 'secret'
  process.env.FRONTEND_URL = 'https://dashboard.avoqado.test'
  let mod: typeof import('../../../src/services/dashboard/googleOAuth.service')
  jest.isolateModules(() => {
    mod = require('../../../src/services/dashboard/googleOAuth.service')
  })
  return mod!
}

it('🔴 la URL de Google lleva el state que se le pasa, y regresa al callback del dashboard', () => {
  const url = new URL(servicio().getGoogleAuthUrl('state-de-este-navegador'))

  expect(url.searchParams.get('state')).toBe('state-de-este-navegador')
  expect(url.searchParams.get('redirect_uri')).toBe('https://dashboard.avoqado.test/auth/google/callback')
  expect(url.searchParams.get('client_id')).toBe('client-id.apps.googleusercontent.com')
})
