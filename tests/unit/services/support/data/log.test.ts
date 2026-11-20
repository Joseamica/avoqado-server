import { paramsHmac } from '@/services/support/data/log'

const KEY = process.env.SUPPORT_WHATSAPP_ENC_KEY
beforeAll(() => (process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)))
afterAll(() => {
  if (KEY === undefined) delete process.env.SUPPORT_WHATSAPP_ENC_KEY
  else process.env.SUPPORT_WHATSAPP_ENC_KEY = KEY
})

const params = { day: 'today' as const, amount: '850', time: null }

it('paramsHmac: 64 hex, stable, changes with the amount and does not contain it', () => {
  const hmac = paramsHmac(params)
  expect(hmac).toMatch(/^[a-f0-9]{64}$/)
  expect(paramsHmac({ ...params })).toBe(hmac)
  expect(paramsHmac({ ...params, amount: '851' })).not.toBe(hmac)
  expect(hmac).not.toContain('850')
})

it('paramsHmac depends on the server key, so «monto 850» cannot be reversed without it', () => {
  const hmac = paramsHmac(params)
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'f'.repeat(64)
  expect(paramsHmac(params)).not.toBe(hmac)
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
})

it('paramsHmac refuses to run without a valid key', () => {
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'short'
  expect(() => paramsHmac(params)).toThrow()
  process.env.SUPPORT_WHATSAPP_ENC_KEY = 'e'.repeat(64)
})
