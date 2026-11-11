/**
 * App de campo, bloque 3: el check-update atiende el carril ANDROID_CAMPO y dice cuál es la versión OBLIGATORIA pendiente
 * (`minVersionCode`), aparte de la más nueva: con FORCE 4 y luego BANNER 5, un celular en 3 sigue obligado a llegar a 4.
 */
import { checkForUpdate } from '@/controllers/tpv/appUpdate.tpv.controller'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { appUpdate: { findFirst: jest.fn() }, terminal: { findFirst: jest.fn() } },
}))

const findFirst = prisma.appUpdate.findFirst as jest.Mock
const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}
const fila = (versionCode: number, updateMode: string) => ({
  id: `cu${versionCode}`,
  versionName: `0.3.${versionCode}`,
  versionCode,
  downloadUrl: `https://example.test/campo-${versionCode}.apk`,
  fileSize: BigInt(1000),
  checksum: 'abc',
  releaseNotes: null,
  updateMode,
  minAndroidSdk: 27,
  createdAt: new Date('2026-11-11T00:00:00Z'),
})
const pedir = (query: Record<string, string>) => {
  const res = response()
  return checkForUpdate({ query, headers: {} } as any, res).then(() => res)
}

beforeEach(() => jest.clearAllMocks())

it('platform=ANDROID_CAMPO es válido y busca sólo en ese carril', async () => {
  findFirst.mockResolvedValue(null)
  const res = await pedir({ currentVersion: '3', environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).not.toHaveBeenCalledWith(400)
  expect(findFirst).toHaveBeenCalled()
  for (const [arg] of findFirst.mock.calls) expect(arg.where.platform).toBe('ANDROID_CAMPO')
})

it('FORCE 4 y después BANNER 5: ofrece la 5 y dice que la 4 es obligatoria', async () => {
  findFirst.mockImplementation(async (arg: any) => (arg.where.updateMode === 'FORCE' ? { versionCode: 4 } : fila(5, 'BANNER')))
  const res = await pedir({ currentVersion: '3', environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  const cuerpo = res.json.mock.calls[0][0]
  expect(cuerpo.hasUpdate).toBe(true)
  expect(cuerpo.update.versionCode).toBe(5)
  expect(cuerpo.minVersionCode).toBe(4)
  const consultaForce = findFirst.mock.calls.map(([a]) => a).find(a => a.where.updateMode === 'FORCE')
  expect(consultaForce.where).toEqual(
    expect.objectContaining({ platform: 'ANDROID_CAMPO', environment: 'PRODUCTION', isActive: true, versionCode: { gt: 3 } }),
  )
})

it('sin FORCE pendiente, minVersionCode es null', async () => {
  findFirst.mockImplementation(async (arg: any) => (arg.where.updateMode === 'FORCE' ? null : fila(5, 'BANNER')))
  const res = await pedir({ currentVersion: '3', environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.json.mock.calls[0][0].minVersionCode).toBeNull()
})

it('sin platform sigue siendo la TPV', async () => {
  findFirst.mockResolvedValue(null)
  await pedir({ currentVersion: '129', environment: 'PRODUCTION' })

  for (const [arg] of findFirst.mock.calls) expect(arg.where.platform).toBe('ANDROID_TPV')
})

it('la respuesta de la TPV con versión nueva queda igual que antes: sin minVersionCode ni consulta extra', async () => {
  findFirst.mockResolvedValue({ ...fila(130, 'FORCE'), versionName: '2.19.0' })
  const res = await pedir({ currentVersion: '129', environment: 'PRODUCTION' })

  expect(findFirst).toHaveBeenCalledTimes(1)
  expect(res.json.mock.calls[0][0]).not.toHaveProperty('minVersionCode')
})
