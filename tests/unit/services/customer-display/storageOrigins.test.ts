// tests/unit/services/customer-display/storageOrigins.test.ts
import { getFirebaseApp } from '@/config/firebase'
import { configuredStorageBucket, recognizeStorageUrl } from '@/services/customer-display/storageOrigins'

// `configuredStorageBucket` es lo único del módulo que toca Firebase: se simula aquí (el reconocedor no lo usa).
jest.mock('@/config/firebase', () => ({ getFirebaseApp: jest.fn() }))
jest.mock('firebase-admin', () => ({ storage: jest.fn() }))
const mockGetFirebaseApp = getFirebaseApp as jest.Mock
const mockStorage = jest.requireMock('firebase-admin').storage as jest.Mock

// Un bucket FIJO de prueba: el reconocedor lo recibe por parámetro y no lee el entorno.
const BUCKET = 'bucket-de-prueba.appspot.com'
const ADMIN = `https://storage.googleapis.com/${BUCKET}`
const NAVEGADOR = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o`

describe('recognizeStorageUrl — sólo las dos formas nuestras, con el bucket exacto', () => {
  it('acepta la forma del Admin SDK', () => {
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/cafe/logo.jpg`, BUCKET)).toEqual({ bucket: BUCKET, path: 'prod/venues/cafe/logo.jpg' })
  })

  it('acepta la forma del navegador, con su token', () => {
    expect(recognizeStorageUrl(`${NAVEGADOR}/prod%2Fvenues%2Fcafe%2Flogo.jpg?alt=media&token=abc-123`, BUCKET)).toEqual({
      bucket: BUCKET,
      path: 'prod/venues/cafe/logo.jpg',
      token: 'abc-123',
    })
  })

  it('sin bucket configurado no reconoce NADA (no adivina uno)', () => {
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/cafe/logo.jpg`, null)).toBeNull()
  })

  // 🔴 La prueba de arriba pasa aunque se quite la guarda `!bucket`: con `null`, la comparación del bucket ya rechaza.
  // Ésta no: con un bucket VACÍO, una URL cuyo segmento de bucket también está vacío igualaría `'' === ''`.
  it('un bucket vacío tampoco reconoce nada, ni la URL con el segmento del bucket vacío', () => {
    expect(recognizeStorageUrl('https://storage.googleapis.com//prod/venues/x/logo.png', '')).toBeNull()
    expect(recognizeStorageUrl('https://storage.googleapis.com//prod/venues/x/logo.png', null)).toBeNull()
  })

  // 🔴 El reconocedor es PURO: aunque el entorno traiga un bucket, sin bucket por parámetro no reconoce nada.
  it('no toma el bucket del entorno aunque la variable exista', () => {
    const previo = process.env.FIREBASE_STORAGE_BUCKET
    process.env.FIREBASE_STORAGE_BUCKET = BUCKET
    try {
      expect(recognizeStorageUrl(`${ADMIN}/prod/venues/cafe/logo.jpg`, null)).toBeNull()
    } finally {
      if (previo === undefined) delete process.env.FIREBASE_STORAGE_BUCKET
      else process.env.FIREBASE_STORAGE_BUCKET = previo
    }
  })

  it('rechaza otro bucket', () => {
    expect(recognizeStorageUrl('https://storage.googleapis.com/otro-bucket/prod/venues/cafe/logo.jpg', BUCKET)).toBeNull()
  })

  it('rechaza un host ajeno que CONTIENE el nuestro', () => {
    expect(recognizeStorageUrl(`https://storage.googleapis.com.evil.test/${BUCKET}/x.png`, BUCKET)).toBeNull()
  })

  // 🔴 El parser (WHATWG y OkHttp en la tablet) CORTA la autoridad https en la barra invertida; si se leyera del texto
  // con `[^/?#]+`, el bucket y la ruta saldrían del crudo mientras la URL real pide OTRO bucket. Medido:
  // `new URL('https://storage.googleapis.com\\otro-bucket/BUCKET/x.png')` pide `/otro-bucket/BUCKET/x.png`.
  it('la autoridad cruda termina en la barra invertida como en el parser: no se cuela otro bucket', () => {
    expect(recognizeStorageUrl(`https://storage.googleapis.com\\otro-bucket/${BUCKET}/x.png`, BUCKET)).toBeNull()
    expect(
      recognizeStorageUrl(`https://firebasestorage.googleapis.com\\v0\\b\\otro\\o\\y/v0/b/${BUCKET}/o/x.png?alt=media`, BUCKET),
    ).toBeNull()
  })

  it('la autoridad cruda es EXACTAMENTE el host que genera nuestro código: sin @, sin puerto, sin %, en minúsculas', () => {
    expect(recognizeStorageUrl(`https://@storage.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://storage.googleapis.com:443/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://storage%2egoogleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://STORAGE.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://@firebasestorage.googleapis.com/v0/b/${BUCKET}/o/x.png?alt=media`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://firebasestorage.googleapis.com:443/v0/b/${BUCKET}/o/x.png?alt=media`, BUCKET)).toBeNull()
  })

  it('rechaza un usuario solo y una contraseña sola', () => {
    expect(recognizeStorageUrl(`https://usuario@storage.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://:clave@storage.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
  })

  it('rechaza credenciales, puerto, fragmento y http', () => {
    expect(recognizeStorageUrl(`https://usuario:clave@storage.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://storage.googleapis.com:8443/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/x.png#otra`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`http://storage.googleapis.com/${BUCKET}/prod/x.png`, BUCKET)).toBeNull()
  })

  it('la forma del navegador exige alt=media (el token es opcional)', () => {
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?token=abc`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?alt=json&token=abc`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?alt=media`, BUCKET)).toEqual({ bucket: BUCKET, path: 'logo.jpg' })
  })

  // `get()` devuelve el PRIMER valor: con claves repetidas, lo que revisamos y lo que lee otro cliente pueden diferir.
  it('rechaza alt o token repetidos', () => {
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?alt=media&alt=json`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?alt=media&token=a&token=b`, BUCKET)).toBeNull()
  })

  it('rechaza una query que no sea alt y token (navegador) y cualquier query (Admin)', () => {
    expect(recognizeStorageUrl(`${NAVEGADOR}/logo.jpg?alt=media&token=abc&redirect=http://evil.test`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/x.png?v=2`, BUCKET)).toBeNull()
  })

  // 🔴 Cada caso CONSERVA el bucket después de normalizar: si el reconocedor mirara la ruta ya normalizada,
  // pasarían. Son los casos que la v1 no tenía (su única prueba subía dos niveles y perdía el bucket).
  it('rechaza el recorrido de directorios aunque el bucket sobreviva a la normalización', () => {
    expect(recognizeStorageUrl(`${ADMIN}/prod/../logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/%2e%2e/logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/./logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod//logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod%2Fvenues/logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/..%5Clogo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${NAVEGADOR}/prod%2F..%2Flogo.png?alt=media`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/../o/logo.png?alt=media`, BUCKET)).toBeNull()
  })

  // 🔴 El parser de URL BORRA los tabuladores y saltos de línea crudos antes de resolver `..`: `.\t.` no parece un
  // recorrido en el texto, pero `new URL()` lo vuelve `..` y la URL apunta a OTRA carpeta que la ruta que devolveríamos.
  // Medido: `new URL('https://storage.googleapis.com/b/prod/venues/mine/.\t./other/logo.png').pathname`
  // === '/b/prod/venues/other/logo.png'.
  it('rechaza los caracteres que el parser borra en silencio (tabulador, salto de línea, espacio al final)', () => {
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/mine/.\t./other/logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/mine/.\n./other/logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/mine/.\r./other/logo.png`, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${ADMIN}/prod/venues/cafe/logo.jpg `, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(`${NAVEGADOR}/prod%2Fvenues%2Fmine%2F.\t.%2Fother%2Flogo.png?alt=media`, BUCKET)).toBeNull()
  })

  it('rechaza lo que no es una URL', () => {
    expect(recognizeStorageUrl('no soy una url', BUCKET)).toBeNull()
    expect(recognizeStorageUrl(null, BUCKET)).toBeNull()
    expect(recognizeStorageUrl(undefined, BUCKET)).toBeNull()
  })
})

describe('configuredStorageBucket — el bucket con el que escribe uploadFileToStorage', () => {
  beforeEach(() => {
    mockGetFirebaseApp.mockReset()
    mockStorage.mockReset()
  })

  it('sin Firebase inicializado devuelve null y no toca el storage', () => {
    mockGetFirebaseApp.mockReturnValue(null)
    expect(configuredStorageBucket()).toBeNull()
    expect(mockStorage).not.toHaveBeenCalled()
  })

  it('si el storage lanza, devuelve null en vez de propagar', () => {
    mockGetFirebaseApp.mockReturnValue({ name: '[DEFAULT]' })
    mockStorage.mockReturnValue({
      bucket: () => {
        throw new Error('Bucket name not specified or invalid')
      },
    })
    expect(configuredStorageBucket()).toBeNull()
  })

  it('devuelve el nombre del bucket de LA app de Firebase inicializada', () => {
    const app = { name: '[DEFAULT]' }
    mockGetFirebaseApp.mockReturnValue(app)
    mockStorage.mockReturnValue({ bucket: () => ({ name: 'mi-proyecto.appspot.com' }) })
    expect(configuredStorageBucket()).toBe('mi-proyecto.appspot.com')
    expect(mockStorage).toHaveBeenCalledWith(app)
  })

  it('un nombre vacío cuenta como sin bucket', () => {
    mockGetFirebaseApp.mockReturnValue({ name: '[DEFAULT]' })
    mockStorage.mockReturnValue({ bucket: () => ({ name: '' }) })
    expect(configuredStorageBucket()).toBeNull()
  })
})
