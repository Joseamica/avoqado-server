/**
 * D20 (13-nov-2026): el ayudante que usan los tres asistentes Blumon del superadmin (auto-fetch, full-setup y refetch).
 * Sólo «Usuario no encontrado» del paso de token es un 400; todo lo demás sigue su camino tal cual.
 */
const fetchMerchantCredentials = jest.fn()
jest.mock('@/services/tpv/blumon-tpv.service', () => ({ createBlumonTpvService: jest.fn(() => ({ fetchMerchantCredentials })) }))

import { credencialesDeBlumon } from '@/services/superadmin/credencialesDeBlumon'

const pedir = (environment: 'SANDBOX' | 'PRODUCTION' = 'PRODUCTION') => credencialesDeBlumon(environment, '1234567890', 'PAX', 'A910S')

beforeEach(() => fetchMerchantCredentials.mockReset())

it('serial que Blumon no conoce ⇒ 400 en español con el ambiente', async () => {
  fetchMerchantCredentials.mockRejectedValueOnce(new Error('Failed to authenticate with Blumon: Usuario no encontrado'))
  await expect(pedir()).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringMatching(/^No encontré esa terminal en Blumon \(producción\): serial 1234567890, PAX A910S\./),
  })
})

it.each([
  'Failed to authenticate with Blumon: Bad credentials',
  'Failed to authenticate with Blumon: timeout of 15000ms exceeded',
  'Usuario no encontrado en otro paso',
])('otra falla sigue igual: %s', async mensaje => {
  const original = new Error(mensaje)
  fetchMerchantCredentials.mockRejectedValueOnce(original)
  await expect(pedir()).rejects.toBe(original)
})

it('si Blumon contesta, devuelve lo mismo', async () => {
  fetchMerchantCredentials.mockResolvedValueOnce({ posId: '42' })
  await expect(pedir('SANDBOX')).resolves.toEqual({ posId: '42' })
})
