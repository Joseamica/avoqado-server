/**
 * 🔴 Un despliegue a medias apagaba los sellos del iPhone EN SILENCIO.
 *
 * `notifyCustomerPassUpdated` envuelve todo en un try/catch que devolvía `{ notified: 0 }`
 * ante CUALQUIER excepción. Ese valor es indistinguible de «este cliente no tenía tarjeta»:
 * el cobro pasa, el sello se guarda en la base, y el iPhone nunca se entera.
 *
 * La ventana es real y se midió el 3-sep-2026 en el full-testing: si el código sube antes
 * de que corra la migración, la consulta revienta con
 *   `Unknown field \`googleObjectId\` for select statement on model \`WalletPass\``
 * y nadie se entera.
 *
 * Dos garantías aquí:
 *   1. El resultado DISTINGUE «reventó» de «no había a quién avisar» (`failed`).
 *   2. Un defecto de ESQUEMA se grita distinto que un fallo pasajero de red, para que
 *      la alerta de logs lo pueda cazar.
 */
const logError = jest.fn()

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: (...a: unknown[]) => logError(...a), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/wallet/apnsClient', () => ({
  sendSilentPush: jest.fn().mockResolvedValue({ ok: true }),
  apnsAvailable: jest.fn().mockReturnValue(true),
}))
jest.mock('@/services/wallet/googleWalletClient', () => ({
  googleWalletAvailable: jest.fn(() => false),
  issuerId: jest.fn(() => '338'),
  walletBaseUrl: jest.fn(() => 'https://api.avoqado.io'),
  walletClient: jest.fn(),
}))

import { notifyCustomerPassUpdated } from '@/services/wallet/notifyPassUpdated.service'
import { prismaMock } from '../../../__helpers__/setup'

/** Lo que Prisma lanza cuando el cliente generado no conoce un campo del select. */
function errorDeEsquema(): Error {
  const e = new Error('Unknown field `googleObjectId` for select statement on model `WalletPass`.')
  e.name = 'PrismaClientValidationError'
  return e
}

describe('un despliegue incompleto no puede apagar los sellos en silencio', () => {
  beforeEach(() => jest.clearAllMocks())

  it('un cliente SIN tarjeta no es un fallo: notified 0 y failed falso', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([] as any)
    const r = await notifyCustomerPassUpdated('v1', 'c1')
    expect(r.notified).toBe(0)
    expect(r.failed).toBeFalsy()
    expect(logError).not.toHaveBeenCalled()
  })

  it('un error de ESQUEMA se marca como fallo, no como «no había a quién avisar»', async () => {
    prismaMock.walletPass.findMany.mockRejectedValue(errorDeEsquema())
    const r = await notifyCustomerPassUpdated('v1', 'c1')
    expect(r.notified).toBe(0)
    expect(r.failed).toBe(true)
  })

  it('un error de ESQUEMA se grita como despliegue incompleto, con el negocio y el cliente', async () => {
    prismaMock.walletPass.findMany.mockRejectedValue(errorDeEsquema())
    await notifyCustomerPassUpdated('v9', 'c9')
    expect(logError).toHaveBeenCalledTimes(1)
    const [mensaje, meta] = logError.mock.calls[0] as [string, Record<string, unknown>]
    expect(mensaje).toMatch(/despliegue incompleto/i)
    expect(meta).toMatchObject({ despliegueIncompleto: true, venueId: 'v9', customerId: 'c9' })
  })

  it('un fallo PASAJERO se marca fallido pero NO se confunde con un despliegue incompleto', async () => {
    prismaMock.walletPass.findMany.mockRejectedValue(new Error('socket hang up'))
    const r = await notifyCustomerPassUpdated('v1', 'c1')
    expect(r.failed).toBe(true)
    const [mensaje, meta] = logError.mock.calls[0] as [string, Record<string, unknown>]
    expect(mensaje).not.toMatch(/despliegue incompleto/i)
    expect(meta).toMatchObject({ despliegueIncompleto: false })
  })

  it('el camino feliz sigue sin marcar fallo', async () => {
    prismaMock.walletPass.findMany.mockResolvedValue([
      { id: 'wp-a', platform: 'APPLE', serialNumber: 'AVQ-A', qrToken: 'a'.repeat(48), revision: 1, venueId: 'v1', customerId: 'c1', googleObjectId: null },
    ] as any)
    prismaMock.walletPass.findUnique.mockResolvedValue({ id: 'wp-a', serialNumber: 'AVQ-A', revision: 1 } as any)
    prismaMock.walletPass.update.mockResolvedValue({ revision: 2 } as any)
    prismaMock.walletPassRegistration.findMany.mockResolvedValue([] as any)
    const r = await notifyCustomerPassUpdated('v1', 'c1')
    expect(r.failed).toBeFalsy()
  })
})
