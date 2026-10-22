import {
  buildReceiptInfo,
  getDeviceReceiptPayload,
  getDeviceReceiptPayloadWithStatus,
  RECEIPT_ASSOCIATION_COLUMNS,
  RECEIPT_EMISOR_COLUMNS,
  RECEIPT_VENUE_SELECT,
} from '@/services/dashboard/receiptLayout/devicePayload.service'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout'
import prisma from '@/utils/prismaClient'

const mock = prisma as unknown as { venue: { findUnique: jest.Mock }; receiptLayout: { findUnique: jest.Mock } }

const EMISOR_A = {
  id: 'emA',
  legalName: 'CAFE A SA',
  rfc: 'CAA010101AAA',
  lugarExpedicion: '06600',
  merchantConfigs: [{ merchantAccountId: 'maA' }],
}
const EMISOR_B = {
  id: 'emB',
  legalName: 'CAFE B SA',
  rfc: 'CBB020202BBB',
  lugarExpedicion: '06700',
  merchantConfigs: [{ merchantAccountId: 'maB' }, { merchantAccountId: null }],
}
const venue = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'Testarudo Cafe',
  logo: 'https://x/l.jpg',
  phone: '55 1234 5678',
  address: 'Nápoles 47',
  city: 'Cuauhtémoc',
  state: 'CDMX',
  zipCode: '06600',
  rfc: null,
  legalName: null,
  fiscalEmisors: [EMISOR_A, EMISOR_B],
  ...over,
})

describe('buildReceiptInfo — ADITIVO', () => {
  it('🔴 los TRES campos viejos siguen ahí y con el MISMO valor (el emisor principal)', () => {
    const r = buildReceiptInfo(venue() as never)
    expect(r.legalName).toBe(EMISOR_A.legalName)
    expect(r.rfc).toBe(EMISOR_A.rfc)
    expect(r.lugarExpedicion).toBe(EMISOR_A.lugarExpedicion)
    // Y los siete de identidad del negocio tampoco cambian de nombre.
    expect(Object.keys(r)).toEqual(
      expect.arrayContaining(['name', 'logoUrl', 'phone', 'address', 'city', 'state', 'zipCode', 'legalName', 'rfc', 'lugarExpedicion']),
    )
  })

  it('🔴 ahora viajan TODOS los emisores con sus cuentas, para elegir por venta', () => {
    const r = buildReceiptInfo(venue() as never)
    expect(r.fiscalEmisors).toHaveLength(2)
    expect(r.fiscalEmisors[1].merchantAccountIds).toEqual(['maB']) // la cuenta NULA se filtra
    expect(r.principalEmisorId).toBe('emA')
  })

  it('las columnas legacy de Venue viajan aparte (tercera fuente del RFC)', () => {
    const r = buildReceiptInfo(venue({ fiscalEmisors: [], rfc: 'VIE900101AAA', legalName: 'VIEJO SA' }) as never)
    expect(r.legacy).toEqual({ rfc: 'VIE900101AAA', legalName: 'VIEJO SA' })
    expect(r.legalName).toBeNull() // sin emisor, el campo viejo sigue siendo null como antes
  })
})

describe('getDeviceReceiptPayload', () => {
  beforeEach(() => jest.clearAllMocks())

  it('trae receiptInfo y receiptLayout con su revisión', async () => {
    mock.venue.findUnique.mockResolvedValue(venue())
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await getDeviceReceiptPayload('v1')
    expect(r.receiptInfo?.rfc).toBe(EMISOR_A.rfc)
    expect(r.receiptLayout).toMatchObject({ schemaVersion: 1, revision: 0, blocks: CANONICAL_LAYOUT })
  })

  it('🔴 si el venue no se puede leer, la respuesta sale SIN receiptInfo — nunca rota', async () => {
    mock.venue.findUnique.mockRejectedValue(new Error('base caída'))
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await getDeviceReceiptPayload('v1')
    expect(r.receiptInfo).toBeUndefined()
    expect(r.receiptLayout).toBeDefined() // el diseño sí se pudo resolver
  })

  it('🔴 si el diseño no se puede leer, la respuesta sale SIN receiptLayout — el POS sigue cobrando', async () => {
    mock.venue.findUnique.mockResolvedValue(venue())
    mock.receiptLayout.findUnique.mockRejectedValue(new Error('base caída'))
    const r = await getDeviceReceiptPayload('v1')
    expect(r.receiptLayout).toBeUndefined()
    expect(r.receiptInfo).toBeDefined()
  })

  // Reemplaza a «el select pide los emisores por fecha de alta y con sus cuentas», que fijaba el DEFECTO (hallazgo F3 de
  // la 5ª ronda): con sólo `createdAt`, dos emisores de la misma fecha salían en el orden que Postgres quisiera y el ticket
  // cambiaba de RFC. La cobertura de `merchantConfigs` pasó a la prueba de columnas de abajo; la de `take`, se conserva.
  it('🔴 orden TOTAL: por fecha y, a igual fecha, por id — el primero es el emisor PRINCIPAL del ticket', () => {
    expect(RECEIPT_VENUE_SELECT.fiscalEmisors.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }])
    expect(RECEIPT_VENUE_SELECT.fiscalEmisors.select.merchantConfigs.orderBy).toEqual([{ merchantAccountId: 'asc' }, { id: 'asc' }])
    // 🔴 Sin `take: 1`: antes sólo viajaba el principal; ahora se necesitan todos.
    expect(RECEIPT_VENUE_SELECT.fiscalEmisors).not.toHaveProperty('take')
  })

  it('las columnas que consume el recibo salen de las MISMAS constantes que usa la firma fiscal', () => {
    const { merchantConfigs, ...emisor } = RECEIPT_VENUE_SELECT.fiscalEmisors.select
    expect(Object.keys(emisor).sort()).toEqual([...RECEIPT_EMISOR_COLUMNS].sort())
    expect(Object.keys(merchantConfigs.select).sort()).toEqual([...RECEIPT_ASSOCIATION_COLUMNS].sort())
  })
})

describe('getDeviceReceiptPayloadWithStatus — el estado explícito (spec §5.7.4)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('ok sólo si llegaron los DOS bloques', async () => {
    mock.venue.findUnique.mockResolvedValue(venue())
    mock.receiptLayout.findUnique.mockResolvedValue(null) // sin fila ⇒ la canónica: también cuenta como llegada
    const r = await getDeviceReceiptPayloadWithStatus('v1')
    expect(r.status).toBe('ok')
    expect(r.payload.receiptInfo).toBeDefined()
    expect(r.payload.receiptLayout).toBeDefined()
  })

  it('failed si el encabezado no se pudo leer', async () => {
    mock.venue.findUnique.mockRejectedValue(new Error('base caída'))
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await getDeviceReceiptPayloadWithStatus('v1')
    expect(r.status).toBe('failed')
    expect(r.payload.receiptInfo).toBeUndefined()
    expect(r.payload.receiptLayout).toBeDefined()
  })

  it('failed si el diseño no se pudo leer', async () => {
    mock.venue.findUnique.mockResolvedValue(venue())
    mock.receiptLayout.findUnique.mockRejectedValue(new Error('base caída'))
    expect((await getDeviceReceiptPayloadWithStatus('v1')).status).toBe('failed')
  })

  it('la función de siempre (la PAX la usa) sigue devolviendo SÓLO el payload', async () => {
    mock.venue.findUnique.mockResolvedValue(venue())
    mock.receiptLayout.findUnique.mockResolvedValue(null)
    const r = await getDeviceReceiptPayload('v1')
    expect(r).not.toHaveProperty('status')
    expect(r.receiptInfo?.principalEmisorId).toBe(EMISOR_A.id)
  })
})
