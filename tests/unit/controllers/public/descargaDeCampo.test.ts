/**
 * App de campo, bloque 3: la liga que el supervisor manda por WhatsApp (o en QR) siempre baja la última versión de la app
 * de campo de PRODUCCIÓN, nunca un APK de la TPV. `?ambiente=sandbox` existe sólo para la prueba de punta a punta.
 */
import { descargarAppDeCampo } from '@/controllers/public/descargaDeCampo.controller'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { appUpdate: { findFirst: jest.fn() } } }))

const findFirst = prisma.appUpdate.findFirst as jest.Mock
const response = () => {
  const res: any = { status: jest.fn(), redirect: jest.fn(), set: jest.fn(), type: jest.fn(), send: jest.fn() }
  for (const k of ['status', 'set', 'type']) res[k].mockReturnValue(res)
  return res
}

beforeEach(() => jest.clearAllMocks())

it('redirige a la versión de producción activa más alta de la app de campo, para todos', async () => {
  findFirst.mockResolvedValue({ downloadUrl: 'https://storage.googleapis.com/b/campo-updates/production/avoqado-campo-0.3.0-3.apk' })
  const res = response()
  await descargarAppDeCampo({ query: {} } as any, res)

  expect(findFirst.mock.calls[0][0]).toEqual(
    expect.objectContaining({
      where: { platform: 'ANDROID_CAMPO', environment: 'PRODUCTION', isActive: true, targetType: 'ALL' },
      orderBy: { versionCode: 'desc' },
    }),
  )
  expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  expect(res.redirect).toHaveBeenCalledWith(302, 'https://storage.googleapis.com/b/campo-updates/production/avoqado-campo-0.3.0-3.apk')
})

it('con ?ambiente=sandbox busca la de pruebas', async () => {
  findFirst.mockResolvedValue({ downloadUrl: 'https://x.test/campo-sandbox.apk' })
  await descargarAppDeCampo({ query: { ambiente: 'sandbox' } } as any, response())

  expect(findFirst.mock.calls[0][0].where.environment).toBe('SANDBOX')
})

it('sin versión publicada: 404 con texto en español', async () => {
  findFirst.mockResolvedValue(null)
  const res = response()
  await descargarAppDeCampo({ query: {} } as any, res)

  expect(res.status).toHaveBeenCalledWith(404)
  expect(res.send).toHaveBeenCalledWith(expect.stringContaining('La app de campo todavía no está publicada'))
  expect(res.redirect).not.toHaveBeenCalled()
})
