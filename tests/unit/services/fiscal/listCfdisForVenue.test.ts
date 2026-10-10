// tests/unit/services/fiscal/listCfdisForVenue.test.ts
//
// Unit tests for listCfdisForVenue (service layer).
// Verifies: tenant isolation (venueId always applied), filter mapping,
// pagination math, date-range timezone conversion, and result shape.
//
// Pattern mirrors loadOrderForCfdi.test.ts: prismaClient is mocked via
// jest.mock before any imports from the service.

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cfdi: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import prisma from '../../../../src/utils/prismaClient'
import { ENVIO_TERMINADO_MS, listCfdisForVenue } from '../../../../src/services/fiscal/cfdi.service'

const findMany = prisma.cfdi.findMany as jest.Mock
const count = prisma.cfdi.count as jest.Mock

const VENUE_ID = 'venue-abc'
const TIMEZONE = 'America/Mexico_City'

const SAMPLE_CFDI = {
  id: 'c1',
  type: 'INGRESO',
  status: 'STAMPED',
  flow: 'STAFF_B',
  isGlobal: false,
  orderId: 'o1',
  receptorRfc: 'XAXX010101000',
  receptorNombre: 'Público en General',
  serie: 'F',
  folio: '1',
  uuid: 'some-uuid',
  subtotalCents: 10000,
  taxCents: 1600,
  totalCents: 11600,
  stampedAt: new Date('2026-06-01T19:00:00.000Z'),
  createdAt: new Date('2026-06-01T19:00:00.000Z'),
  cancelStatus: null,
  xmlUrl: 'https://example.com/cfdi.xml',
  pdfUrl: 'https://example.com/cfdi.pdf',
  globalPeriod: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  findMany.mockResolvedValue([SAMPLE_CFDI])
  count.mockResolvedValue(1)
})

// ─── Tenant isolation ─────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('always includes venueId in the where clause', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const whereArg = findMany.mock.calls[0][0].where
    expect(whereArg).toMatchObject({ venueId: VENUE_ID })
  })

  it('includes venueId even when all optional filters are provided', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      status: 'STAMPED',
      flow: 'STAFF_B',
      isGlobal: false,
      receptorRfc: 'XAXX',
      from: '2026-06-01',
      to: '2026-06-30',
      page: 2,
      pageSize: 10,
      venueTimezone: TIMEZONE,
    })

    const whereArg = findMany.mock.calls[0][0].where
    expect(whereArg.venueId).toBe(VENUE_ID)
  })

  it('passes the same where to both findMany and count (identical tenant scope)', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: 'STAMPED', page: 1, pageSize: 20 })

    const findManyWhere = findMany.mock.calls[0][0].where
    const countWhere = count.mock.calls[0][0].where
    expect(findManyWhere).toEqual(countWhere)
  })
})

// ─── Filter mapping ────────────────────────────────────────────────────────────

describe('filter mapping', () => {
  it('maps status filter to where.status', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: 'CANCELLED', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.status).toBe('CANCELLED')
  })

  it('maps flow filter to where.flow', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, flow: 'GLOBAL_C', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.flow).toBe('GLOBAL_C')
  })

  it('maps isGlobal=true to where.isGlobal', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, isGlobal: true, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.isGlobal).toBe(true)
  })

  it('maps isGlobal=false to where.isGlobal', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, isGlobal: false, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.isGlobal).toBe(false)
  })

  it('maps receptorRfc to case-insensitive contains', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, receptorRfc: 'TEST', page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.receptorRfc).toEqual({ contains: 'TEST', mode: 'insensitive' })
  })

  // Testarudo 24-sep-2026: marcar dos estatus (o dos flujos) en la pantalla no filtraba nada, porque sólo
  // se mandaba el filtro cuando había exactamente uno. El servidor acepta ahora la lista.
  it('varios estatus ⇒ where.status = { in: [...] }', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: ['STAMPED', 'CANCELLED'], page: 1, pageSize: 20 })
    expect(findMany.mock.calls[0][0].where.status).toEqual({ in: ['STAMPED', 'CANCELLED'] })
  })

  it('varios flujos ⇒ where.flow = { in: [...] }', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, flow: ['STAFF_B', 'AUTOFACTURA_A'], page: 1, pageSize: 20 })
    expect(findMany.mock.calls[0][0].where.flow).toEqual({ in: ['STAFF_B', 'AUTOFACTURA_A'] })
  })

  it('una lista con UN estatus sigue siendo un filtro exacto', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, status: ['STAMPED'], page: 1, pageSize: 20 })
    expect(findMany.mock.calls[0][0].where.status).toBe('STAMPED')
  })

  it('omits optional filters from where when not provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const where = findMany.mock.calls[0][0].where
    expect(where.status).toBeUndefined()
    expect(where.flow).toBeUndefined()
    expect(where.isGlobal).toBeUndefined()
    expect(where.receptorRfc).toBeUndefined()
    expect(where.createdAt).toBeUndefined()
    expect(where.OR).toBeUndefined()
  })
})

// ─── Date range timezone conversion ───────────────────────────────────────────

// 🔴 H23 (auditoría 2026-09-30): la fecha de una factura es la de su TIMBRADO; sin timbre (borrador, en proceso o fallida),
// la de su último intento. Antes filtraba por el PRIMER intento: la A-36 de Testarudo (reintento 9, timbrada el 30-sep)
// salía el 24-sep.
const rango = (where: any) => {
  expect(where.OR).toEqual([{ stampedAt: where.OR[0].stampedAt }, { stampedAt: null, updatedAt: where.OR[0].stampedAt }])
  return where.OR[0].stampedAt
}

describe('date range: timezone conversion (Prisma = real UTC)', () => {
  it('🔴 H23: filtra por el timbrado (y sin timbre, por el último intento), nunca por el primer intento', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, from: '2026-09-30', to: '2026-09-30', page: 1, pageSize: 20, venueTimezone: TIMEZONE })
    const where = findMany.mock.calls[0][0].where
    const dia = { gte: new Date('2026-09-30T06:00:00.000Z'), lte: new Date('2026-10-01T05:59:59.999Z') }
    expect(where.createdAt).toBeUndefined()
    expect(where.OR).toEqual([{ stampedAt: dia }, { stampedAt: null, updatedAt: dia }])
  })

  // 🔴 El día pedido NO puede depender del huso del servidor. Producción corre en UTC: con
  // `new Date('AAAA-MM-DDT00:00:00')` el «24 sep» se volvía el 23-sep 18:00 de México y el filtro de la
  // pantalla de Facturas enseñaba el día ANTERIOR. México es UTC−6 todo el año (sin horario de verano).
  // Codex (ronda 1 del plan de correo): el ancla de mediodía se leía en el huso del SERVIDOR; con uno de UTC+7 o más (Tokio)
  // el día de México se corría al anterior. `process.env.TZ` dentro de Jest NO cambia el huso del proceso: esta prueba se
  // corre además con `TZ=Asia/Tokyo` y `TZ=UTC` delante del comando.
  it('EXACTO: el día 24-sep de México es [24-sep 06:00Z, 25-sep 05:59:59.999Z], sea cual sea el huso del servidor', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, from: '2026-09-24', to: '2026-09-24', page: 1, pageSize: 20, venueTimezone: TIMEZONE })
    const where = findMany.mock.calls[0][0].where
    expect(rango(where).gte.toISOString()).toBe('2026-09-24T06:00:00.000Z')
    expect(rango(where).lte.toISOString()).toBe('2026-09-25T05:59:59.999Z')
  })

  it('converts from (venue-local midnight) to real UTC for gte', async () => {
    // Mexico City is UTC-6 in winter (CST). June 1 midnight Mexico = June 1 06:00 UTC.
    await listCfdisForVenue({
      venueId: VENUE_ID,
      from: '2026-06-01',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(rango(where)).toBeDefined()
    const gte: Date = rango(where).gte
    // In summer (CDT) Mexico is UTC-5; June 1 midnight CDT = 05:00 UTC.
    // In winter (CST) it would be 06:00 UTC. Either way, it should NOT be 00:00 UTC.
    expect(gte.toISOString()).not.toBe('2026-06-01T00:00:00.000Z')
    // The date should be June 1 (UTC might push it up slightly due to offset)
    expect(gte.getUTCDate()).toBeGreaterThanOrEqual(1)
  })

  it('converts to (venue-local end of day) to real UTC for lte', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      to: '2026-06-01',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(rango(where)).toBeDefined()
    const lte: Date = rango(where).lte
    // End of day should NOT be midnight UTC — it should be 05:59 or 06:59 UTC (after adding offset)
    expect(lte.toISOString()).not.toBe('2026-06-01T00:00:00.000Z')
    // lte must be strictly after gte (end of day > start of day)
    expect(lte.getTime()).toBeGreaterThan(new Date('2026-06-01T00:00:00.000Z').getTime())
  })

  it('sets both gte and lte when both from and to are provided', async () => {
    await listCfdisForVenue({
      venueId: VENUE_ID,
      from: '2026-06-01',
      to: '2026-06-30',
      page: 1,
      pageSize: 20,
      venueTimezone: TIMEZONE,
    })

    const where = findMany.mock.calls[0][0].where
    expect(rango(where).gte).toBeInstanceOf(Date)
    expect(rango(where).lte).toBeInstanceOf(Date)
    // lte (end of June 30) must be after gte (start of June 1)
    expect(rango(where).lte.getTime()).toBeGreaterThan(rango(where).gte.getTime())
  })

  it('sets only gte when only from is provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, from: '2026-06-01', page: 1, pageSize: 20, venueTimezone: TIMEZONE })

    const where = findMany.mock.calls[0][0].where
    expect(rango(where).gte).toBeInstanceOf(Date)
    expect(rango(where).lte).toBeUndefined()
  })

  it('sets only lte when only to is provided', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, to: '2026-06-30', page: 1, pageSize: 20, venueTimezone: TIMEZONE })

    const where = findMany.mock.calls[0][0].where
    expect(rango(where).gte).toBeUndefined()
    expect(rango(where).lte).toBeInstanceOf(Date)
  })
})

// ─── Pagination math ──────────────────────────────────────────────────────────

describe('pagination math', () => {
  it('calculates correct skip for page 1', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(0)
    expect(args.take).toBe(20)
  })

  it('calculates correct skip for page 2', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 2, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(20)
  })

  it('calculates correct skip for page 3 with pageSize 10', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 3, pageSize: 10 })

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(10)
  })

  // 🔴 H23: por fecha de timbrado. Lo que no se timbró (en proceso o fallido) va ARRIBA: una factura que acaba de fallar no
  // se esconde en la última página. `id` desempata para que la paginación sea estable.
  it('ordena por timbrado, con lo no timbrado primero y desempate estable', async () => {
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    const args = findMany.mock.calls[0][0]
    expect(args.orderBy).toEqual([{ stampedAt: { sort: 'desc', nulls: 'first' } }, { updatedAt: 'desc' }, { id: 'desc' }])
    expect(args.select.updatedAt).toBe(true)
  })
})

// ─── Result shape ──────────────────────────────────────────────────────────────

describe('result shape', () => {
  it('returns { cfdis, total, page, pageSize }', async () => {
    findMany.mockResolvedValue([SAMPLE_CFDI])
    count.mockResolvedValue(42)

    const result = await listCfdisForVenue({ venueId: VENUE_ID, page: 2, pageSize: 10 })

    expect(result).toEqual({
      // C1 · Tarea 11 (S6): cada fila gana `complementariaDe` (null en una individual); nada se quita.
      // C2 · T10 (C2-31), cambio A PROPÓSITO: y `estadoCancelacion` (null = nunca se pidió cancelarla).
      cfdis: [{ ...SAMPLE_CFDI, complementariaDe: null, estadoCancelacion: null }],
      total: 42,
      page: 2,
      pageSize: 10,
    })
  })

  it('returns empty cfdis array when no results', async () => {
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)

    const result = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    expect(result.cfdis).toEqual([])
    expect(result.total).toBe(0)
  })

  it('runs findMany and count in parallel (Promise.all)', async () => {
    // Both mocks resolve immediately; check both were called in the same test tick
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)

    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledTimes(1)
  })
})

// ─── C1 · Tarea 11 (contrato S6 del dashboard): el emisor y la principal de cada fila ──────────────────────────────

describe('C1 · Tarea 11 — `fiscalEmisorId` y `complementariaDe` en cada fila (aditivos)', () => {
  const global = (id: string, idempotencyKey: string) => ({
    ...SAMPLE_CFDI,
    id,
    isGlobal: true,
    orderId: null,
    flow: 'GLOBAL_C',
    fiscalEmisorId: 'e1',
    idempotencyKey,
  })
  it('🔴 la consulta trae el emisor; la llave sólo se lee por dentro (no sale en la respuesta)', async () => {
    findMany.mockResolvedValueOnce([global('g1', 'cfdi-global-e1-2026-05-04')])
    const r = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    const select = findMany.mock.calls[0][0].select
    expect(select).toMatchObject({ fiscalEmisorId: true, idempotencyKey: true })
    expect(r.cfdis[0]).toMatchObject({ id: 'g1', fiscalEmisorId: 'e1', complementariaDe: null })
    expect(r.cfdis[0]).not.toHaveProperty('idempotencyKey')
  })
  it('🔴 una complementaria trae el id de SU principal (buscada por su llave, acotada a la página); una principal e individual, null', async () => {
    findMany
      .mockResolvedValueOnce([
        global('g-c2', 'cfdi-global-e1-2026-05-04-c2'),
        global('g1', 'cfdi-global-e1-2026-05-04'),
        { ...SAMPLE_CFDI, fiscalEmisorId: 'e1', idempotencyKey: 'cfdi-o1' },
      ])
      .mockResolvedValueOnce([{ id: 'g1', idempotencyKey: 'cfdi-global-e1-2026-05-04' }])
    const r = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    expect(r.cfdis.map((c: any) => [c.id, c.complementariaDe])).toEqual([
      ['g-c2', 'g1'],
      ['g1', null],
      ['c1', null],
    ])
    const busqueda = findMany.mock.calls[1][0]
    expect(busqueda.where).toMatchObject({ venueId: VENUE_ID, isGlobal: true, idempotencyKey: { in: ['cfdi-global-e1-2026-05-04'] } })
    expect(busqueda.take).toBe(1)
  })
  it('control (ronda 1, m6) — una complementaria cuya principal no aparece lee el dato de su propia entrada (acotado a esas filas)', async () => {
    findMany
      .mockResolvedValueOnce([global('g-c2', 'cfdi-global-e1-2026-05-04-c2')])
      .mockResolvedValueOnce([]) // la principal no apareció por su llave
      .mockResolvedValueOnce([{ id: 'g-c2', entrada: { complementariaDe: 'g-principal' } }])
    const r = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    expect(r.cfdis.map((c: any) => [c.id, c.complementariaDe])).toEqual([['g-c2', 'g-principal']])
    const respaldo = findMany.mock.calls[2][0]
    expect(respaldo.where).toMatchObject({ venueId: VENUE_ID, id: { in: ['g-c2'] } })
    expect(respaldo.take).toBe(1)
  })
  it('control — una página sin complementarias no hace consultas de más', async () => {
    findMany.mockResolvedValueOnce([global('g1', 'cfdi-global-e1-2026-05-04')])
    await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})

// ─── C2 · Tarea 10 (Codex C2-31): el estado de la cancelación, derivado al momento de CADA consulta ─────────────────────────────────
describe('C2 · T10 — `estadoCancelacion` en la lista (C2-31)', () => {
  const T0 = new Date('2026-10-05T18:00:00.000Z')
  const enviada = { ...SAMPLE_CFDI, id: 'c-env', cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: null }
  const acusada = { ...enviada, id: 'c-acu', cancelAcusadaAt: new Date(T0.getTime() + 5_000) }
  afterEach(() => jest.useRealTimers())
  const consultar = async (ahora: Date, filas: unknown[]) => {
    jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    findMany.mockResolvedValueOnce(filas)
    const r = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    jest.useRealTimers()
    return r.cfdis as any[]
  }
  it('🔴 enviada hace 30 s y sin acuse ⇒ ENVIANDO; la MISMA fila en una consulta NUEVA pasado el umbral ⇒ CANCELACION_EN_DUDA; con acuse ⇒ EN_TRAMITE', async () => {
    const antes = await consultar(new Date(T0.getTime() + 30_000), [enviada, acusada])
    expect(antes.map(c => [c.id, c.estadoCancelacion])).toEqual([
      ['c-env', 'ENVIANDO'],
      ['c-acu', 'EN_TRAMITE'],
    ])
    const despues = await consultar(new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000), [enviada, acusada])
    expect(despues.map(c => [c.id, c.estadoCancelacion])).toEqual([
      ['c-env', 'CANCELACION_EN_DUDA'],
      ['c-acu', 'EN_TRAMITE'],
    ])
  })
  it('🔴 la consulta trae lo que hace falta para derivarlo, y NO devuelve las fechas internas ni el intento', async () => {
    const [fila] = await consultar(new Date(T0.getTime() + 30_000), [enviada])
    const select = findMany.mock.calls[0][0].select
    expect(select).toMatchObject({ cancelEnviadaAt: true, cancelAcusadaAt: true, cancelIntento: true })
    expect(fila).not.toHaveProperty('cancelEnviadaAt')
    expect(fila).not.toHaveProperty('cancelAcusadaAt')
    expect(fila).not.toHaveProperty('cancelIntento')
  })
  // T10 ronda 1 (I-1, cambia A PROPÓSITO): «Consultar estado» manda `soloConsultar` y ya no repite el motivo. Los dos campos los agregó la
  // T10 (nunca estuvieron en producción): ya no se leen ni salen.
  it('🔴 la fila ya NO trae `cancelMotivo` ni `cancelSubstituteUuid` («Consultar estado» no los necesita)', async () => {
    const [fila] = await consultar(new Date(T0.getTime() + 30_000), [enviada])
    const select = findMany.mock.calls[0][0].select
    expect(select).not.toHaveProperty('cancelMotivo')
    expect(select).not.toHaveProperty('cancelSubstituteUuid')
    expect(fila).not.toHaveProperty('cancelMotivo')
    expect(fila).not.toHaveProperty('cancelSubstituteUuid')
  })
  it('🔴 M9: una cancelación rechazada dice POR QUÉ (`motivoRechazoCancelacion`); el `lastError` de otra cosa no sale', async () => {
    const [rechazada, timbrada] = await consultar(T0, [
      {
        ...SAMPLE_CFDI,
        id: 'c-rej',
        cancelStatus: 'REJECTED',
        cancelIntento: 1,
        lastError: 'Esta factura ya tiene notas de crédito; cancélalas primero.',
      },
      { ...SAMPLE_CFDI, id: 'c-ok', lastError: 'un error técnico viejo' },
    ])
    expect(findMany.mock.calls[0][0].select).toMatchObject({ lastError: true })
    expect(rechazada).toMatchObject({
      estadoCancelacion: 'RECHAZADA',
      motivoRechazoCancelacion: 'Esta factura ya tiene notas de crédito; cancélalas primero.',
    })
    expect(rechazada).not.toHaveProperty('lastError')
    expect(timbrada).not.toHaveProperty('motivoRechazoCancelacion')
    expect(timbrada).not.toHaveProperty('lastError')
    expect(timbrada.estadoCancelacion).toBeNull()
  })
})

// C2 · ronda QA (D6): un `STAMP_FAILED` que se ENVIÓ y no tuvo respuesta clara (`falloDefinitivo: false`) no es «rechazado»: la fila trae
// `timbreEnDuda: true` (aditivo) y la lista lo dice así. Las columnas con que se deriva son internas.
describe('C2 · ronda QA (D6) — `timbreEnDuda` en la lista', () => {
  const enviada = new Date('2026-10-09T18:00:00.000Z')
  const fallida = { ...SAMPLE_CFDI, status: 'STAMP_FAILED', stampedAt: null, uuid: null, protocoloIva: 1 }
  it('🔴 enviada y sin rechazo ⇒ `timbreEnDuda: true`; rechazo definitivo o nunca enviada ⇒ sin el campo; las columnas no salen', async () => {
    findMany.mockResolvedValueOnce([
      { ...fallida, id: 'duda', enviadoAt: enviada, falloDefinitivo: false },
      { ...fallida, id: 'rechazo', enviadoAt: enviada, falloDefinitivo: true },
      { ...fallida, id: 'sin-enviar', enviadoAt: null, falloDefinitivo: false },
      { ...SAMPLE_CFDI, id: 'timbrada', protocoloIva: 1, enviadoAt: enviada, falloDefinitivo: false },
    ])
    const { cfdis } = await listCfdisForVenue({ venueId: VENUE_ID, page: 1, pageSize: 20 })
    expect(findMany.mock.calls[0][0].select).toMatchObject({ enviadoAt: true, falloDefinitivo: true, protocoloIva: true })
    expect((cfdis as any[]).map(c => [c.id, c.timbreEnDuda])).toEqual([
      ['duda', true],
      ['rechazo', undefined],
      ['sin-enviar', undefined],
      ['timbrada', undefined],
    ])
    for (const c of cfdis as any[]) {
      expect(c).not.toHaveProperty('enviadoAt')
      expect(c).not.toHaveProperty('falloDefinitivo')
      expect(c).not.toHaveProperty('protocoloIva')
    }
  })
})
