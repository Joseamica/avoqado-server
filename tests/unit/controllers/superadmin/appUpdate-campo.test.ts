/**
 * App de campo, bloque 3: el alta de versiones por plataforma. La de campo exige su paquete, su ambiente según el
 * versionName, que los números sean los del APK (si no, el celular pediría la misma versión para siempre) y, en
 * producción, la huella de la llave propia de campo. La de la TPV sin plataforma sigue igual que hoy.
 */
import { createAppUpdate, previewApkMetadata } from '@/controllers/superadmin/appUpdate.controller'
import prisma from '@/utils/prismaClient'
import { extractApkMetadata } from '@/services/apk-parser.service'
import { huellaDelCertificadoDeclarado, HUELLA_DE_FIRMA_DE_CAMPO } from '@/services/apk/certificadoDeclarado'
import { getStorageBucket } from '@/config/firebase'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { appUpdate: { findUnique: jest.fn(), create: jest.fn() }, activityLog: { create: jest.fn() } },
}))
jest.mock('@/config/firebase', () => ({ getStorageBucket: jest.fn() }))
jest.mock('@/services/apk-parser.service', () => ({
  ...jest.requireActual('@/services/apk-parser.service'),
  extractApkMetadata: jest.fn(),
}))
jest.mock('@/services/apk/certificadoDeclarado', () => ({
  ...jest.requireActual('@/services/apk/certificadoDeclarado'),
  huellaDelCertificadoDeclarado: jest.fn(),
}))

const archivo = { save: jest.fn(), makePublic: jest.fn() }
const bucket = { name: 'bucket-prueba', file: jest.fn(() => archivo) }
const metadata = (packageName: string, versionName: string, versionCode = 3) => ({ packageName, versionName, versionCode, minSdkVersion: 27 })
const response = () => {
  const res: any = { status: jest.fn(), json: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}
const alta = (body: Record<string, unknown>) => {
  const res = response()
  return createAppUpdate({ body: { apkBase64: 'QUJD', ...body }, authContext: { userId: 'cstaff0000000000000000001' } } as any, res).then(() => res)
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(getStorageBucket as jest.Mock).mockReturnValue({ bucket: () => bucket })
  ;(prisma.appUpdate.findUnique as jest.Mock).mockResolvedValue(null)
  ;(prisma.appUpdate.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'cupd', ...data }))
  ;(huellaDelCertificadoDeclarado as jest.Mock).mockReturnValue(HUELLA_DE_FIRMA_DE_CAMPO)
})

it('campo en producción con su paquete, su nombre y su llave: 201 en su carril y su carpeta', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(201)
  expect((prisma.appUpdate.create as jest.Mock).mock.calls[0][0].data).toEqual(expect.objectContaining({ platform: 'ANDROID_CAMPO', versionCode: 3 }))
  expect(bucket.file).toHaveBeenCalledWith(expect.stringMatching(/^campo-updates\/production\/avoqado-campo-0\.3\.0-3-[0-9a-f]{12}\.apk$/))
  expect((prisma.appUpdate.findUnique as jest.Mock).mock.calls[0][0].where).toEqual({
    versionCode_environment_platform: { versionCode: 3, environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' },
  })
})

it('campo siempre queda para todos los celulares aunque pidan sucursales', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO', targetType: 'VENUES', targetVenueIds: ['cvenue000000000000000001'] })

  expect(res.status).toHaveBeenCalledWith(201)
  expect((prisma.appUpdate.create as jest.Mock).mock.calls[0][0].data).toEqual(
    expect.objectContaining({ targetType: 'ALL', targetVenueIds: [], targetTerminalIds: [] }),
  )
})

it('campo en producción firmado con otra llave: 400 y no sube nada', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  ;(huellaDelCertificadoDeclarado as jest.Mock).mockReturnValue('c27a1420' + '0'.repeat(56))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(400)
  expect(res.json.mock.calls[0][0].error).toMatch(/llave de la app de campo/)
  expect(archivo.save).not.toHaveBeenCalled()
  expect(prisma.appUpdate.create).not.toHaveBeenCalled()
})

it('campo sin bloque de firma en producción: 400', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  ;(huellaDelCertificadoDeclarado as jest.Mock).mockReturnValue(null)
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(400)
})

it.each([
  ['0.3.0-sandbox', 'PRODUCTION'],
  ['0.3.0', 'SANDBOX'],
])('campo con versionName %s en %s: 400 (el ambiente sale del nombre)', async (versionName, environment) => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', versionName))
  const res = await alta({ environment, platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(400)
  expect(archivo.save).not.toHaveBeenCalled()
})

it('campo en sandbox no exige la llave de producción', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0-sandbox'))
  ;(huellaDelCertificadoDeclarado as jest.Mock).mockReturnValue('otra')
  const res = await alta({ environment: 'SANDBOX', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(201)
  expect(bucket.file).toHaveBeenCalledWith(expect.stringMatching(/^campo-updates\/sandbox\/avoqado-campo-0\.3\.0-sandbox-3-[0-9a-f]{12}\.apk$/))
})

it.each([{ versionCode: 9 }, { versionName: '0.9.0' }])('campo con números distintos a los del APK (%j): 400', async extra => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO', ...extra })

  expect(res.status).toHaveBeenCalledWith(400)
})

it('un APK de la TPV en el carril de campo: 400', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv', '2.18.0', 129))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(400)
})

it('un APK de campo sin plataforma (carril TPV): 400, como hoy', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  const res = await alta({ environment: 'PRODUCTION' })

  expect(res.status).toHaveBeenCalledWith(400)
})

it('la TPV sin plataforma sigue igual: su paquete, su carpeta y ANDROID_TPV', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv', '2.18.0', 129))
  const res = await alta({ environment: 'PRODUCTION' })

  expect(res.status).toHaveBeenCalledWith(201)
  expect(bucket.file).toHaveBeenCalledWith('tpv-updates/production/avoqado-tpv-2.18.0-production.apk')
  expect((prisma.appUpdate.create as jest.Mock).mock.calls[0][0].data).toEqual(expect.objectContaining({ platform: 'ANDROID_TPV' }))
  expect(huellaDelCertificadoDeclarado).not.toHaveBeenCalled()
})

it('el preview reconoce la app de campo y su ambiente por el nombre', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0-sandbox'))
  const res = response()
  await previewApkMetadata({ body: { apkBase64: 'QUJD' } } as any, res)

  expect(res.json.mock.calls[0][0].data).toEqual(expect.objectContaining({ detectedPlatform: 'ANDROID_CAMPO', detectedEnvironment: 'SANDBOX' }))
})

it('dos altas simultáneas de builds distintos: archivos distintos, y la que pierde el INSERT es 409', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  ;(prisma.appUpdate.create as jest.Mock)
    .mockImplementationOnce(async ({ data }: any) => ({ id: 'cupd', ...data }))
    .mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
  const [a, b] = await Promise.all([
    createAppUpdate({ body: { apkBase64: 'QUFB', environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' }, authContext: { userId: 'cstaff0000000000000000001' } } as any, response()).then(() => null),
    createAppUpdate({ body: { apkBase64: 'QkJC', environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' }, authContext: { userId: 'cstaff0000000000000000001' } } as any, response()).then(() => null),
  ])
  void a, void b
  const nombres = (bucket.file as jest.Mock).mock.calls.map(([n]) => n)
  expect(new Set(nombres).size).toBe(2)
  const urls = (prisma.appUpdate.create as jest.Mock).mock.calls.map(([arg]) => arg.data.downloadUrl)
  expect(urls[0]).toContain(nombres[0].split('/').pop())
})

it('si el INSERT choca con la llave única (otra alta ganó): 409, no 500', async () => {
  ;(extractApkMetadata as jest.Mock).mockResolvedValue(metadata('com.jaac.avoqado_tpv.campo', '0.3.0'))
  ;(prisma.appUpdate.create as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
  const res = await alta({ environment: 'PRODUCTION', platform: 'ANDROID_CAMPO' })

  expect(res.status).toHaveBeenCalledWith(409)
})
