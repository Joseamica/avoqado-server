/**
 * El callback de Google pasa el sobre de ALTA al servicio sólo cuando es válido, con la IP real
 * del visitante (no la del borde de Cloudflare), y descarta en silencio lo que no valida.
 */
jest.mock('@/services/dashboard/googleOAuth.service', () => ({ loginWithGoogle: jest.fn() }))

import { googleOAuthCallback } from '@/controllers/dashboard/googleOAuth.controller'
import { loginWithGoogle } from '@/services/dashboard/googleOAuth.service'

const login = loginWithGoogle as jest.Mock

function llamar(body: unknown) {
  const res = { cookie: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() }
  const next = jest.fn()
  const req = { body, headers: { 'cf-connecting-ip': '201.1.2.3' }, ip: '172.70.0.1', get: () => undefined } as never
  return googleOAuthCallback(req, res as never, next).then(() => ({ res, next }))
}

beforeEach(() => {
  jest.clearAllMocks()
  login.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', staff: { id: 's' }, isNewUser: true })
})

it('🔴 el sobre del alta viaja al servicio con la campaña, los UTM limpios y la versión legal', async () => {
  await llamar({
    code: 'c-1',
    signup: { legalVersion: 'v1-2026-09-17', launchCampaignCode: 'pos-22-mx', utm: { utm_source: 'google', basura: 'x' } },
  })
  expect(login).toHaveBeenCalledWith(
    'c-1',
    true,
    // el schema compartido lo sube a forma de código; `findClaimableByCodeOrSlug` lo vuelve a probar como slug
    expect.objectContaining({ legalVersion: 'v1-2026-09-17', launchCampaignCode: 'POS-22-MX', utm: { utm_source: 'google' } }),
  )
})

it('🔴 sin sobre, es un inicio de sesión normal (el servicio conserva el 403 para correos desconocidos)', async () => {
  await llamar({ code: 'c-1' })
  expect(login).toHaveBeenCalledWith('c-1', true, undefined)
})

it('un sobre que no es un objeto se trata como ausente, nunca como alta', async () => {
  await llamar({ code: 'c-1', signup: 'crea-un-negocio' })
  expect(login).toHaveBeenCalledWith('c-1', true, undefined)
})

it('un código de campaña basura se descarta sin tumbar el alta', async () => {
  await llamar({ code: 'c-1', signup: { launchCampaignCode: '<script>' } })
  expect(login.mock.calls[0][2]).toMatchObject({ launchCampaignCode: undefined })
})

it('🔴 la IP del consentimiento es la del visitante, no la del borde de Cloudflare', async () => {
  await llamar({ code: 'c-1', signup: { legalVersion: 'v1-2026-09-17' } })
  expect(login.mock.calls[0][2]).toMatchObject({ ipAddress: '201.1.2.3' })
})
