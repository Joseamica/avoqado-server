import { getSpecificVersion, checkForUpdate } from '@/controllers/tpv/appUpdate.tpv.controller'
import prisma from '@/utils/prismaClient'
jest.mock('@/utils/prismaClient', () => ({ __esModule: true,
  default: { appUpdate: { findFirst: jest.fn(), findUnique: jest.fn() }, terminal: { findFirst: jest.fn() } } }))
const response = () => { const res: any = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res); return res }
beforeEach(() => jest.clearAllMocks())
it.each(['123oops', '123.8', '0', '-1', '2147483648', ['123'], {}])('P2 get-version rejects malformed code %j', async versionCode => {
  const res = response()
  await getSpecificVersion({ query: { versionCode, environment: 'SANDBOX' }, headers: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(400)
  expect(prisma.appUpdate.findFirst).not.toHaveBeenCalled()
  expect(prisma.appUpdate.findUnique).not.toHaveBeenCalled()
})
it('P2 check-update also rejects suffixes', async () => {
  const res = response()
  await checkForUpdate({ query: { currentVersion: '123oops', environment: 'SANDBOX' }, headers: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(400)
})
it('TPV get-version excludes desktop executables', async () => {
  const res = response()
  await getSpecificVersion({ query: { versionCode: '123', environment: 'SANDBOX' }, headers: {} } as any, res)
  expect(prisma.appUpdate.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ platform: 'ANDROID_TPV' }) }),
  )
})

it('Nexgo versions are distributed through TMS, not the PAX APK channel', async () => {
  const res = response()
  await getSpecificVersion({ query: { versionCode: '123', environment: 'SANDBOX' }, headers: { 'x-tpv-processor': 'NEXGO' } } as any, res)
  expect(prisma.appUpdate.findFirst).not.toHaveBeenCalled()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ found: false }))
})

// Codex, apps viejas antes de publicar (11-nov): las TPV menores a 2.12.2 no mandan X-Terminal-Serial. Para ellas
// «Instalar versión» busca como antes de «Aplica a» (D3): sin filtro de audiencia, porque el comando ya eligió la terminal.
const versionActiva = { id: 'u1', versionName: '2.17.0', versionCode: 140, downloadUrl: 'https://x/a.apk', fileSize: BigInt(1),
  checksum: 'c', releaseNotes: null, updateMode: 'NONE', isActive: true, minAndroidSdk: 27, createdAt: new Date(0) }
it('una TPV vieja sin serial encuentra una versión dirigida (como antes de «Aplica a»)', async () => {
  ;(prisma.appUpdate.findFirst as jest.Mock).mockResolvedValue(versionActiva)
  const res = response()
  await getSpecificVersion({ query: { versionCode: '140', environment: 'PRODUCTION' }, headers: {}, get: () => undefined } as any, res)
  expect((prisma.appUpdate.findFirst as jest.Mock).mock.calls[0][0].where.OR).toBeUndefined()
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ found: true }))
})
it('una TPV con serial que no está dada de alta sólo ve las versiones para todas', async () => {
  ;(prisma.terminal.findFirst as jest.Mock).mockResolvedValue(null)
  const res = response()
  await getSpecificVersion({ query: { versionCode: '140', environment: 'PRODUCTION' }, headers: {}, get: () => 'AVQD-DESCONOCIDA' } as any, res)
  expect((prisma.appUpdate.findFirst as jest.Mock).mock.calls[0][0].where.OR).toEqual([{ targetType: 'ALL' }])
})
