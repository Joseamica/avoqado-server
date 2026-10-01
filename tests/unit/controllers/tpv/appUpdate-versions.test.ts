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
