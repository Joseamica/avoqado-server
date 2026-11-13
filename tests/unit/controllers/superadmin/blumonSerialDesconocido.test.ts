/**
 * D20 (13-nov-2026): el asistente Blumon con un serial que Blumon no conoce respondía 500 y dejaba `error` en el log.
 * Blumon sandbox contesta 401 `{"error":"unauthorized","error_description":"Usuario no encontrado"}` (medido con un serial
 * falso) y el servicio de `tpv/` (que no se toca) lo envuelve en `Error('Failed to authenticate with Blumon: …')`.
 * Ahora: 400 en español con el ambiente, y el controlador lo registra como `warn`. Cualquier otra falla sigue igual.
 */
import type { Request, Response } from 'express'

const fetchMerchantCredentials = jest.fn()
jest.mock('@/services/tpv/blumon-tpv.service', () => ({
  createBlumonTpvService: jest.fn(() => ({ fetchMerchantCredentials })),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    paymentProvider: { findUnique: jest.fn().mockResolvedValue(null) },
    merchantAccount: { findFirst: jest.fn().mockResolvedValue(null) },
    venuePaymentConfig: { findUnique: jest.fn().mockResolvedValue(null) },
    organizationPaymentConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('@/services/shared/candadoDePosiciones', () => ({
  ...jest.requireActual('@/services/shared/candadoDePosiciones'),
  exigirConfirmacionDePosiciones: jest.fn().mockResolvedValue(undefined),
}))

import logger from '@/config/logger'
import { autoFetchBlumonCredentials, fullSetupBlumonMerchant } from '@/controllers/superadmin/merchantAccount.controller'

const NO_ENCONTRADO = new Error('Failed to authenticate with Blumon: Usuario no encontrado')
const RED = new Error('Failed to authenticate with Blumon: timeout of 15000ms exceeded')

const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as unknown as Response
const cuerpo = { serialNumber: 'FULLTEST-SERIAL-D20', brand: 'PAX', model: 'A910S', environment: 'SANDBOX' }

async function correr(handler: typeof autoFetchBlumonCredentials, body: Record<string, unknown>) {
  let error: any
  await handler({ body, params: {}, query: {}, user: { uid: 'sa' } } as unknown as Request, res(), (e?: unknown) => (error = e))
  return error
}

const llamados = (fn: jest.Mock) => fn.mock.calls.map(c => String(c[0]))

beforeEach(() => jest.clearAllMocks())

describe.each([
  ['auto-fetch', autoFetchBlumonCredentials, cuerpo, '[Blumon Auto-Fetch] Failed'],
  [
    'full-setup',
    fullSetupBlumonMerchant,
    { ...cuerpo, target: { type: 'venue', id: 'v1' }, accountSlot: 'PRIMARY' },
    '[Full Setup] Failed',
  ],
] as const)('%s con un serial que Blumon no conoce', (_nombre, handler, body, lineaDeError) => {
  it('responde 400 en español con el ambiente y lo registra como warn, no como error', async () => {
    fetchMerchantCredentials.mockRejectedValueOnce(NO_ENCONTRADO)
    const error = await correr(handler, body)

    expect(error.statusCode).toBe(400)
    expect(error.message).toMatch(/No encontré esa terminal en Blumon/)
    expect(error.message).toMatch(/sandbox/)
    expect(error.message).toMatch(/FULLTEST-SERIAL-D20/)
    expect(llamados(logger.error as jest.Mock)).not.toContain(lineaDeError)
    expect(llamados(logger.warn as jest.Mock).some(l => l.startsWith(lineaDeError.split(']')[0]))).toBe(true)
  })

  it('otra falla (red, Blumon caído) sigue igual: el error original y su línea de error', async () => {
    fetchMerchantCredentials.mockRejectedValueOnce(RED)
    const error = await correr(handler, body)

    expect(error).toBe(RED)
    expect(llamados(logger.error as jest.Mock)).toContain(lineaDeError)
  })
})
