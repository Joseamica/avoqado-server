// tests/unit/services/customer-display/customerDisplayAsset.test.ts
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prismaMock } from '@tests/__helpers__/setup'
import { NotFoundError, ValidationError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  authorizeAssetPlan,
  authorizeAssetTerminal,
  authorizeAssetUpload,
  inspectImage,
  MAX_ASSET_BYTES,
  uploadCustomerDisplayAsset,
} from '@/services/customer-display/customerDisplayAsset.service'
import { getEffectiveDesign, invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayDesign.service'
import { recognizeStorageUrl } from '@/services/customer-display/storageOrigins'

/**
 * 🔴 Nunca se sube nada a Firebase: el bucket es falso. Pero el que arma la URL es el `uploadFileToStorage` REAL, así
 * que la URL que devuelve la subida es la forma que de verdad se guarda y que la ficha tiene que reconocer.
 */
const MOCK_BUCKET_NAME = 'avoqado-pruebas.appspot.com'
const mockBucket = {
  name: MOCK_BUCKET_NAME,
  file: jest.fn(() => ({ save: jest.fn(async () => undefined), makePublic: jest.fn(async () => undefined) })),
}
jest.mock('@/config/firebase', () => ({
  getStorageBucket: () => ({ bucket: () => mockBucket }),
  getFirebaseApp: () => null,
}))
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: jest.fn((p: string) => `dev/${p}`),
  uploadFileToStorage: jest.fn((buffer: Buffer, ruta: string, tipo: string) =>
    jest.requireActual('@/services/storage.service').uploadFileToStorage(buffer, ruta, tipo),
  ),
}))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(async () => true) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const img = (nombre: string) => readFileSync(join(__dirname, '../../../fixtures/customer-display', nombre))
const storage = jest.requireMock('@/services/storage.service')
const accesoAlPlan = venueHasFeatureAccess as jest.Mock
const sinPlanDePromos = async (_v: string, code: string) => code !== 'CUSTOMER_DISPLAY_PROMOS'

const terminal = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  venueId: 'v1',
  name: 'Caja',
  type: 'POS_ANDROID',
  customerDisplayDesignVersion: 2,
  venue: { logo: null, updatedAt: new Date() },
  customerDisplayDesign: null,
  ...over,
})

beforeEach(() => {
  accesoAlPlan.mockImplementation(async () => true)
  prismaMock.terminal.findFirst.mockResolvedValue(terminal() as any)
  prismaMock.customerDisplayAsset.create.mockImplementation(async (args: any) => ({ id: 'a1', ...args.data }))
})

describe('inspectImage — el tipo y las medidas salen de los BYTES de imágenes reales', () => {
  it.each([
    ['imagen-1280x720.png', 'image/png'],
    ['imagen-1280x720.jpg', 'image/jpeg'],
    ['imagen-1280x720-progresiva.jpg', 'image/jpeg'],
    ['imagen-1280x720.webp', 'image/webp'],
    ['imagen-1280x720-sin-perdida.webp', 'image/webp'],
    ['imagen-1280x720-alfa.webp', 'image/webp'],
  ])('%s → %s, 1280×720', (archivo, mime) => {
    expect(inspectImage(img(archivo))).toMatchObject({ mime, width: 1280, height: 720 })
  })

  it.each([
    'png-truncado.png',
    'jpeg-sin-sof.jpg',
    'riff-no-webp.webp',
    'zip-disfrazado.png',
    // El contenedor dice WEBP pero lo de adentro no es un cuadro VP8/VP8L: sin revisar la firma, se leerían medidas al azar.
    'webp-vp8-sin-codigo-de-inicio.webp',
    'webp-vp8l-sin-firma.webp',
  ])('%s se rechaza sin reventar', archivo => {
    expect(inspectImage(img(archivo))).toBeNull()
  })

  it('un buffer vacío se rechaza', () => {
    expect(inspectImage(Buffer.alloc(0))).toBeNull()
  })

  // El lector es PURO y corre sobre bytes que manda cualquiera: ningún recorte de una imagen real lo puede tumbar.
  it('ningún recorte de las imágenes reales lo hace reventar', () => {
    const reales = [
      'imagen-1280x720.png',
      'imagen-1280x720.jpg',
      'imagen-1280x720-progresiva.jpg',
      'imagen-1280x720.webp',
      'imagen-1280x720-sin-perdida.webp',
      'imagen-1280x720-alfa.webp',
    ]
    for (const archivo of reales) {
      const bytes = img(archivo)
      for (let n = 0; n <= bytes.length; n++) expect(() => inspectImage(bytes.subarray(0, n))).not.toThrow()
    }
  })
})

describe('authorizeAssetUpload — lo que la ruta corre ANTES de multer', () => {
  it('una terminal de otro negocio o inexistente: 404', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null as any)
    await expect(authorizeAssetUpload({ venueId: 'v1', terminalId: 'ajena', kind: 'LOGO' })).rejects.toBeInstanceOf(NotFoundError)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ajena', venueId: 'v1' } }))
  })

  it('una terminal propia sin pantalla del cliente: 422', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ type: 'TPV_ANDROID' }) as any)
    await expect(authorizeAssetUpload({ venueId: 'v1', terminalId: 't1', kind: 'LOGO' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('SIN plan de promos: una SLIDE da 403 FEATURE_REQUIRES_PRO', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await expect(authorizeAssetUpload({ venueId: 'v1', terminalId: 't1', kind: 'SLIDE' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FEATURE_REQUIRES_PRO',
    })
  })

  it('SIN plan de promos: el LOGO se permite (la marca es gratis)', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await expect(authorizeAssetUpload({ venueId: 'v1', terminalId: 't1', kind: 'LOGO' })).resolves.toBeUndefined()
  })

  // 🔴 FALLA CERRADO: el candado del plan sólo corre para el literal 'SLIDE'. Si cualquier otro valor pasara, un llamador
  // que mande la consulta cruda ('slide', en minúsculas) o un tipo inventado se saltaría el candado del plan.
  it.each([['slide'], ['OTRA'], [''], [undefined]])(
    // 400 y no 422: es una ENTRADA mal formada, el mismo código y el mismo estado que da la ruta (`assetKindFromQuery`).
    'un tipo que no es exactamente SLIDE o LOGO (%p) es 400, sin consultar nada',
    async kind => {
      accesoAlPlan.mockImplementation(sinPlanDePromos)
      await expect(authorizeAssetUpload({ venueId: 'v1', terminalId: 't1', kind: kind as never })).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_ASSET_KIND',
      })
      expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
      expect(accesoAlPlan).not.toHaveBeenCalled()
    },
  )
})

// La ruta corre las dos mitades por separado porque el PERMISO va en medio (spec §5.4: amarrar la terminal → permiso →
// plan). Cada mitad hace SÓLO lo suyo: amarrar no consulta el plan y el plan no consulta la terminal.
describe('las dos mitades que la ruta corre por separado', () => {
  it('authorizeAssetTerminal: 404 ajena/inexistente, 422 sin pantalla, y nunca consulta el plan', async () => {
    // `mockResolvedValue` y no `…Once`: un «once» sin consumir sobrevive a `clearAllMocks` y contamina la prueba siguiente.
    prismaMock.terminal.findFirst.mockResolvedValue(null as any)
    await expect(authorizeAssetTerminal({ venueId: 'v1', terminalId: 'ajena' })).rejects.toBeInstanceOf(NotFoundError)
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'ajena', venueId: 'v1' } }))
    prismaMock.terminal.findFirst.mockResolvedValue(terminal({ type: 'TPV_ANDROID' }) as any)
    await expect(authorizeAssetTerminal({ venueId: 'v1', terminalId: 't1' })).rejects.toBeInstanceOf(ValidationError)
    prismaMock.terminal.findFirst.mockResolvedValue(terminal() as any)
    await expect(authorizeAssetTerminal({ venueId: 'v1', terminalId: 't1' })).resolves.toBeUndefined()
    expect(accesoAlPlan).not.toHaveBeenCalled()
  })

  it('authorizeAssetPlan: sin plan, SLIDE da 403 y LOGO pasa — sin consultar la terminal', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await expect(authorizeAssetPlan({ venueId: 'v1', kind: 'SLIDE' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FEATURE_REQUIRES_PRO',
    })
    await expect(authorizeAssetPlan({ venueId: 'v1', kind: 'LOGO' })).resolves.toBeUndefined()
    expect(prismaMock.terminal.findFirst).not.toHaveBeenCalled()
  })

  it.each([['slide'], ['OTRA'], [undefined]])('authorizeAssetPlan falla CERRADO con %p: 400, sin consultar el plan', async kind => {
    await expect(authorizeAssetPlan({ venueId: 'v1', kind: kind as never })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_ASSET_KIND',
    })
    expect(accesoAlPlan).not.toHaveBeenCalled()
  })
})

describe('uploadCustomerDisplayAsset', () => {
  const entrada = (over: Record<string, unknown> = {}) => ({
    venueId: 'v1',
    terminalId: 't1',
    kind: 'SLIDE' as const,
    buffer: img('imagen-1280x720.png'),
    staffId: 's1',
    ...over,
  })

  it('vuelve a autorizar por dentro: sin plan, una SLIDE no llega al storage aunque alguien llame directo', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await expect(uploadCustomerDisplayAsset(entrada())).rejects.toMatchObject({ statusCode: 403 })
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
  })

  it('vuelve a amarrar la terminal por dentro: con una terminal ajena, 404 y nada llega al storage ni a la base', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue(null as any)
    await expect(uploadCustomerDisplayAsset(entrada({ terminalId: 'ajena', kind: 'LOGO' }))).rejects.toBeInstanceOf(NotFoundError)
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
    expect(prismaMock.customerDisplayAsset.create).not.toHaveBeenCalled()
  })

  it('un tipo inválido tampoco pasa por dentro: sin plan, `slide` en minúsculas no llega al storage ni a la base', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await expect(uploadCustomerDisplayAsset(entrada({ kind: 'slide' }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_ASSET_KIND',
    })
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
    expect(prismaMock.customerDisplayAsset.create).not.toHaveBeenCalled()
  })

  it('SIN plan de promos: el LOGO sí se sube', async () => {
    accesoAlPlan.mockImplementation(sinPlanDePromos)
    await uploadCustomerDisplayAsset(entrada({ kind: 'LOGO' }))
    expect(prismaMock.customerDisplayAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'LOGO' }) }),
    )
  })

  it('guarda bajo el prefijo propio, con el venueId y un uuid, nunca con el nombre del archivo', async () => {
    await uploadCustomerDisplayAsset(entrada())
    expect(storage.buildStoragePath).toHaveBeenCalledWith(expect.stringMatching(/^customer-display-assets\/v1\/[0-9a-f-]{36}\.png$/))
  })

  it('el tipo con el que se guarda y la extensión de la ruta salen de los BYTES', async () => {
    const jpg = img('imagen-1280x720.jpg')
    await uploadCustomerDisplayAsset(entrada({ buffer: jpg }))
    expect(storage.uploadFileToStorage).toHaveBeenCalledWith(
      jpg,
      expect.stringMatching(/^dev\/customer-display-assets\/v1\/[0-9a-f-]{36}\.jpg$/),
      'image/jpeg',
    )
    expect(prismaMock.customerDisplayAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mime: 'image/jpeg', bytes: jpg.length, createdById: 's1' }) }),
    )
  })

  it('la URL que devuelve es la que la ficha reconoce, y apunta justo al objectPath guardado', async () => {
    const r = await uploadCustomerDisplayAsset(entrada())
    const guardado = prismaMock.customerDisplayAsset.create.mock.calls[0][0].data.objectPath

    expect(guardado).toMatch(/^dev\/customer-display-assets\/v1\/[0-9a-f-]{36}\.png$/)
    expect(recognizeStorageUrl(r.url, MOCK_BUCKET_NAME)).toEqual({ bucket: MOCK_BUCKET_NAME, path: guardado })
  })

  it('el sha256 es el de ESOS bytes: dos imágenes distintas dan dos huellas distintas', async () => {
    const png = img('imagen-1280x720.png')
    const jpg = img('imagen-1280x720.jpg')
    const a = await uploadCustomerDisplayAsset(entrada({ buffer: png }))
    const b = await uploadCustomerDisplayAsset(entrada({ buffer: jpg }))

    expect(a.sha256).toBe(createHash('sha256').update(png).digest('hex'))
    expect(b.sha256).toBe(createHash('sha256').update(jpg).digest('hex'))
    expect(a.sha256).not.toBe(b.sha256)
    expect(prismaMock.customerDisplayAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'v1', kind: 'SLIDE', sha256: a.sha256, width: 1280, height: 720 }),
      }),
    )
  })

  it('deja bitácora con quién, qué terminal y qué archivo', async () => {
    const r = await uploadCustomerDisplayAsset(entrada())
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 's1',
        venueId: 'v1',
        action: 'CUSTOMER_DISPLAY_ASSET_UPLOADED',
        entity: 'CustomerDisplayAsset',
        entityId: r.assetId,
        data: expect.objectContaining({ terminalId: 't1', kind: 'SLIDE', sha256: r.sha256 }),
      }),
    )
  })

  it('invalida la caché de la ficha de esa terminal', async () => {
    const lecturas = () => prismaMock.terminal.findFirst.mock.calls.length
    invalidateCustomerDisplayCache('t1') // arranque limpio: nada de otra prueba en la caché
    const inicio = lecturas()
    await getEffectiveDesign('v1', 't1', { cache: true })
    await getEffectiveDesign('v1', 't1', { cache: true })
    expect(lecturas()).toBe(inicio + 1) // la segunda salió de la caché: la caché SÍ estaba viva

    await uploadCustomerDisplayAsset(entrada({ kind: 'LOGO' }))
    // Sólo se cuentan las lecturas de la ficha, no la de la autorización de la subida.
    const antes = lecturas()
    await getEffectiveDesign('v1', 't1', { cache: true })
    expect(lecturas()).toBe(antes + 1) // tras subir, la ficha se vuelve a calcular
  })

  it('rechaza lo que pesa de más ANTES de subir nada', async () => {
    const gordo = Buffer.concat([img('imagen-1280x720.png'), Buffer.alloc(MAX_ASSET_BYTES)])
    await expect(uploadCustomerDisplayAsset(entrada({ buffer: gordo }))).rejects.toMatchObject({ statusCode: 400, code: 'ASSET_TOO_LARGE' })
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
  })

  // Una imagen por cada una de las CUATRO revisiones de medidas: el ancho y el alto, por abajo y por arriba. `alta` y
  // `baja` tienen el ancho dentro del rango a propósito: así sólo la revisión del ALTO las puede rechazar.
  it.each([
    ['chica-200x200.png', 'demasiado chica'],
    ['ancha-5000x400.png', 'demasiado ancha'],
    ['alta-1280x5000.png', 'demasiado alta (ancho válido)'],
    ['baja-1280x200.png', 'demasiado baja (ancho válido)'],
  ])('rechaza %s (%s) y no llega al storage', async archivo => {
    await expect(uploadCustomerDisplayAsset(entrada({ buffer: img(archivo) }))).rejects.toMatchObject({
      code: 'ASSET_BAD_DIMENSIONS',
    })
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
  })

  it.each(['limite-400x4096.png', 'limite-4096x400.png'])('%s está justo en los límites y se acepta', async archivo => {
    await expect(uploadCustomerDisplayAsset(entrada({ buffer: img(archivo) }))).resolves.toMatchObject({ assetId: 'a1' })
  })

  it('un archivo que no es imagen no llega al storage', async () => {
    await expect(uploadCustomerDisplayAsset(entrada({ buffer: img('zip-disfrazado.png') }))).rejects.toMatchObject({
      code: 'ASSET_NOT_AN_IMAGE',
    })
    expect(storage.uploadFileToStorage).not.toHaveBeenCalled()
  })
})
