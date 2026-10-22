/**
 * Control de actualización forzada de la TPV (`tpvVersionGate`)
 *
 * El control compara `x-app-version-code` contra el mínimo FORCE de la app TPV. Las apps POS
 * (Android, Windows, iOS) también mandan `x-app-version-code` (su PROPIO versionCode) pero
 * nunca `x-app-version-name`; la TPV siempre manda los dos. Por eso el nombre de versión es
 * lo que identifica a la TPV: sin él, el control no aplica (si no, un POS con versionCode 55
 * recibiría 426 al escanear una tarjeta de lealtad cuando la TPV tiene un FORCE > 55).
 */
import { Request, Response, NextFunction } from 'express'
import prisma from '@/utils/prismaClient'
import { tpvVersionGate, invalidateVersionCache } from '@/middlewares/tpv-version-gate.middleware'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { appUpdate: { findFirst: jest.fn() } },
}))

const findFirst = prisma.appUpdate.findFirst as jest.Mock

const FORCE_MINIMO = 56

function correr(headers: Record<string, string>, path = '/venues/v1/wallet/scan') {
  const req = { headers, path } as unknown as Request
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response
  const next = jest.fn() as NextFunction
  return tpvVersionGate(req, res, next).then(() => ({ res, next }))
}

describe('tpvVersionGate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    invalidateVersionCache()
    // Hay un FORCE de TPV con versionCode 56 en sandbox y en producción.
    findFirst.mockResolvedValue({
      versionCode: FORCE_MINIMO,
      versionName: '1.5.0',
      downloadUrl: 'https://example.test/tpv.apk',
      releaseNotes: null,
    })
  })

  it('POS con su propio versionCode y sin nombre de versión pasa', async () => {
    const { res, next } = await correr({ 'x-app-version-code': '55' })

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('nombre de versión en blanco se trata como ausente y pasa', async () => {
    const { res, next } = await correr({ 'x-app-version-code': '55', 'x-app-version-name': '   ' })

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('TPV vieja con nombre sandbox recibe 426', async () => {
    const { res, next } = await correr({ 'x-app-version-code': '50', 'x-app-version-name': '1.4.2-sandbox' })

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(426)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'UPGRADE_REQUIRED', minVersionCode: FORCE_MINIMO }))
  })

  it('TPV al día pasa', async () => {
    const { res, next } = await correr({ 'x-app-version-code': '60', 'x-app-version-name': '1.5.1-sandbox' })

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('sin cabecera de código pasa', async () => {
    const { res, next } = await correr({ 'x-app-version-name': '1.4.2-sandbox' })

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it('ruta excluida pasa', async () => {
    const { res, next } = await correr({ 'x-app-version-code': '50', 'x-app-version-name': '1.4.2-sandbox' }, '/heartbeat')

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })
})
