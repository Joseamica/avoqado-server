import {
  getReceiptDevices,
  getReceiptReadiness,
  minimoDeVersion,
  parseVersionName,
  posSoportaDiseno,
} from '@/services/dashboard/receiptLayout/readiness.service'
import prisma from '@/utils/prismaClient'

const mock = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  terminal: { findMany: jest.Mock }
}
const salud = (appVersionCode: number, appVersion: string) => [{ appVersionCode, appVersion }]

describe('getReceiptReadiness', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con emisor y con logo, las dos en true', async () => {
    mock.venue.findUnique.mockResolvedValue({ logo: 'https://x/logo.jpg', fiscalEmisors: [{ id: 'e1' }], rfc: null, legalName: null })
    await expect(getReceiptReadiness('v1')).resolves.toEqual({ fiscalEmisor: true, logo: true })
  })

  it('🔴 sin emisor pero CON las columnas legacy de Venue, fiscalEmisor sigue siendo true', async () => {
    // La PAX imprime hoy esas columnas: decirle al negocio «no tienes datos fiscales» sería falso.
    mock.venue.findUnique.mockResolvedValue({ logo: null, fiscalEmisors: [], rfc: 'VIE900101AAA', legalName: 'VIEJO SA' })
    await expect(getReceiptReadiness('v1')).resolves.toEqual({ fiscalEmisor: true, logo: false })
  })

  it('sin nada, las dos en false', async () => {
    mock.venue.findUnique.mockResolvedValue({ logo: null, fiscalEmisors: [], rfc: null, legalName: null })
    await expect(getReceiptReadiness('v1')).resolves.toEqual({ fiscalEmisor: false, logo: false })
  })

  it('un venue que no existe no revienta: todo en false', async () => {
    mock.venue.findUnique.mockResolvedValue(null)
    await expect(getReceiptReadiness('v1')).resolves.toEqual({ fiscalEmisor: false, logo: false })
  })
})

describe('getReceiptDevices', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 versión DESCONOCIDA cuenta como "no soporta" (conservador)', async () => {
    mock.terminal.findMany.mockResolvedValue([{ name: 'Caja 1', type: 'POS_ANDROID', brand: null, healthMetrics: [] }])
    const r = await getReceiptDevices('v1')
    expect(r.supporting).toBe(0)
    expect(r.notSupporting).toEqual([{ name: 'Caja 1', platform: 'POS_ANDROID', brand: null, appVersion: null }])
  })

  it('una versión por debajo del mínimo no soporta; una por encima sí', async () => {
    mock.terminal.findMany.mockResolvedValue([
      { name: 'Vieja', type: 'POS_DESKTOP', brand: null, healthMetrics: salud(10, '2.8.7') },
      { name: 'Nueva', type: 'POS_DESKTOP', brand: null, healthMetrics: salud(Number.MAX_SAFE_INTEGER, '9.9.9') },
    ])
    const r = await getReceiptDevices('v1')
    expect(r.supporting).toBe(1)
    expect(r.notSupporting).toEqual([{ name: 'Vieja', platform: 'POS_DESKTOP', brand: null, appVersion: '2.8.7' }])
  })

  it('un venue sin aparatos no es un error: cero y lista vacía', async () => {
    mock.terminal.findMany.mockResolvedValue([])
    await expect(getReceiptDevices('v1')).resolves.toEqual({ supporting: 0, notSupporting: [] })
  })

  it('🔴 sólo se consultan los tipos que INTERPRETAN la receta: ni impresoras ni KDS', async () => {
    mock.terminal.findMany.mockResolvedValue([])
    await getReceiptDevices('v1')
    const consulta = mock.terminal.findMany.mock.calls[0][0]
    expect(consulta.where.type.in).toEqual(['TPV_ANDROID', 'TPV_IOS', 'POS_ANDROID', 'POS_IOS', 'POS_DESKTOP'])
    expect(consulta.where.venueId).toBe('v1')
    // Lista acotada: un venue con cientos de aparatos no puede tumbar el endpoint.
    expect(consulta.take).toBeLessThanOrEqual(200)
  })

  it('🔴 toma la salud MÁS RECIENTE (TerminalHealth es histórico, no una fila por aparato)', async () => {
    mock.terminal.findMany.mockResolvedValue([])
    await getReceiptDevices('v1')
    const consulta = mock.terminal.findMany.mock.calls[0][0]
    expect(consulta.select.healthMetrics).toMatchObject({ take: 1, orderBy: { createdAt: 'desc' } })
  })

  it('🔴 la lista dice la MARCA del aparato: «TPV_ANDROID» no distingue una PAX de una Nexgo', async () => {
    mock.terminal.findMany.mockResolvedValue([
      { name: 'Terminal 2', type: 'TPV_ANDROID', brand: 'Nexgo', healthMetrics: salud(107, '2.9.2') },
    ])
    const r = await getReceiptDevices('v1')
    expect(mock.terminal.findMany.mock.calls[0][0].select.brand).toBe(true)
    expect(r.notSupporting).toEqual([{ name: 'Terminal 2', platform: 'TPV_ANDROID', brand: 'NEXGO', appVersion: '2.9.2' }])
  })
})

/**
 * 🔴 La PAX y la Nexgo son el MISMO `Terminal.type` (TPV_ANDROID) y comparten `versionCode`, pero
 * imprimen con motores distintos (Neptune contra AngelPay). Si el intérprete sale en uno antes que
 * en el otro, un mínimo por TIPO contaría como «ya lo aplica» a la marca que todavía no lo tiene.
 */
describe('minimoDeVersion', () => {
  const env = {
    RECEIPT_LAYOUT_MIN_TPV_ANDROID_PAX: '110',
    RECEIPT_LAYOUT_MIN_TPV_ANDROID_NEXGO: '120',
    RECEIPT_LAYOUT_MIN_POS_ANDROID: '40',
  }

  it('la terminal Android se mide por MARCA', () => {
    expect(minimoDeVersion('TPV_ANDROID', 'PAX', env)).toBe(110)
    expect(minimoDeVersion('TPV_ANDROID', 'NEXGO', env)).toBe(120)
  })

  it('la marca se normaliza: una Nexgo auto-registrada llega como «NexGo»', () => {
    expect(minimoDeVersion('TPV_ANDROID', 'NexGo', env)).toBe(120)
  })

  it('🔴 terminal Android SIN marca o de otra marca: nunca se da por soportada', () => {
    expect(minimoDeVersion('TPV_ANDROID', null, env)).toBe(Number.MAX_SAFE_INTEGER)
    expect(minimoDeVersion('TPV_ANDROID', 'Ingenico', env)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('🔴 un mínimo por TIPO para la terminal Android se IGNORA: aplicaría a las dos marcas a la vez', () => {
    expect(minimoDeVersion('TPV_ANDROID', 'PAX', { RECEIPT_LAYOUT_MIN_TPV_ANDROID: '1' })).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('los POS (una sola app por plataforma) siguen midiéndose por tipo', () => {
    expect(minimoDeVersion('POS_ANDROID', 'SUNMI', env)).toBe(40)
    expect(minimoDeVersion('POS_IOS', null, env)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('un valor que no es número no abre la puerta', () => {
    expect(minimoDeVersion('POS_ANDROID', null, { RECEIPT_LAYOUT_MIN_POS_ANDROID: 'pronto' })).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('capacidad de las tablets por nombre de versión (Terminal.version)', () => {
  const env = { RECEIPT_LAYOUT_MIN_POS_ANDROID_VERSION: '2.19.0', RECEIPT_LAYOUT_MIN_POS_IOS_VERSION: '1.11' }

  it('lee «2.18.3-dev», «1.10» y rechaza lo que no es versión', () => {
    expect(parseVersionName('2.18.3-dev')).toEqual([2, 18, 3])
    expect(parseVersionName('1.10')).toEqual([1, 10, 0])
    expect(parseVersionName('desconocida')).toBeNull()
    expect(parseVersionName(null)).toBeNull()
  })

  it('P1 una tablet actualizada SÍ cuenta; una vieja o sin versión, no', () => {
    expect(posSoportaDiseno('POS_ANDROID', '2.19.0-dev', env)).toBe(true)
    expect(posSoportaDiseno('POS_ANDROID', '2.20.1', env)).toBe(true)
    expect(posSoportaDiseno('POS_ANDROID', '2.18.3', env)).toBe(false)
    expect(posSoportaDiseno('POS_IOS', '1.11.0', env)).toBe(true)
    expect(posSoportaDiseno('POS_IOS', null, env)).toBe(false)
  })

  it('sin la variable de mínimo, ninguna tablet cuenta (el banner no miente antes de publicar)', () => {
    expect(posSoportaDiseno('POS_ANDROID', '9.9.9', {})).toBe(false)
  })

  it('getReceiptDevices usa Terminal.version para las tablets y la enseña en la lista', async () => {
    mock.terminal.findMany.mockResolvedValue([
      { name: 'Sunmi', type: 'POS_ANDROID', brand: 'Sunmi', version: '2.19.0', healthMetrics: [] },
      { name: 'iPad', type: 'POS_IOS', brand: null, version: '1.10.2', healthMetrics: [] },
    ])
    const r = await getReceiptDevices('v1', env)
    expect(mock.terminal.findMany.mock.calls[0][0].select.version).toBe(true)
    expect(r.supporting).toBe(1)
    expect(r.notSupporting).toEqual([{ name: 'iPad', platform: 'POS_IOS', brand: null, appVersion: '1.10.2' }])
  })
})
