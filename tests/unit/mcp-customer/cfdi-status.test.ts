/**
 * C2 · Tarea 10 (Codex C2-31): `cfdi_status` dice el estado de la cancelación derivado en CADA consulta. Una cancelación enviada y sin
 * acuse es ENVIANDO mientras el envío puede seguir en vuelo, y CANCELACION_EN_DUDA en una consulta NUEVA pasado el umbral
 * (`ENVIO_TERMINADO_MS`: consulta previa + POST + margen, 90 s; el plan decía 60 s, la ronda 1 de la T2 lo derivó de los tiempos límite).
 * Con acuse, EN_TRAMITE. Las fechas internas no salen; `cancelacionEnTramite` se conserva.
 */
import { registerCfdiTools, TEXTO_CANCELACION_EN_DUDA } from '../../../src/mcp/tools/cfdi'
import { ENVIO_TERMINADO_MS } from '../../../src/services/fiscal/cfdi.service'
import type { McpScope } from '../../../src/mcp/scope'

const mockCfdiFindMany = jest.fn()
const mockCfdiCount = jest.fn().mockResolvedValue(0)
jest.mock('@/services/fiscal/cfdiEmail.service', () => ({ sendCfdiByEmail: jest.fn() }))
jest.mock('@/services/fiscal/cfdiCreditNote.service', () => ({ emitRefundCreditNote: jest.fn(), getRefundCreditNoteStatus: jest.fn() }))
jest.mock('@/services/fiscal/confirmarContratoDePrecio.service', () => ({
  vistaPreviaContrato: jest.fn(),
  confirmarContratoIvaIncluido: jest.fn(),
}))
jest.mock('@/services/access/access.service', () => ({ hasPermission: jest.fn(() => true) }))
jest.mock('@/services/access/basePlan.service', () => ({ venuesWithFeatureAccess: jest.fn(async () => new Set(['v1'])) }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))
jest.mock('@/mcp/guard', () => ({ createGuard: () => ({ venueFilter: jest.fn(), requirePermission: jest.fn() }) }))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cfdi: {
      findMany: (...a: unknown[]) => mockCfdiFindMany(...(a as [])),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalCents: 0 }, _count: { _all: 0 } }),
      count: (...a: unknown[]) => mockCfdiCount(...(a as [])),
    },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
  },
}))

const handlers = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
const scope = { staffId: 's1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as McpScope
beforeAll(() => {
  registerCfdiTools({ tool: (...a: unknown[]) => handlers.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
})

const T0 = new Date('2026-10-05T18:00:00.000Z')
const base = {
  venueId: 'v1',
  serie: 'A',
  uuid: 'U',
  totalCents: 11600,
  receptorNombre: 'X',
  stampedAt: T0,
  venue: { name: 'T' },
  replacedBy: [],
}
const enviada = {
  ...base,
  id: 'enviada',
  folio: '1',
  cancelStatus: 'REQUESTED',
  cancelIntento: 1,
  cancelEnviadaAt: T0,
  cancelAcusadaAt: null,
}
const acusada = { ...enviada, id: 'acusada', folio: '2', cancelAcusadaAt: new Date(T0.getTime() + 5_000) }

/** Una consulta NUEVA del operador en `ahora`. */
async function consultar(ahora: Date): Promise<any[]> {
  jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
  mockCfdiFindMany.mockResolvedValueOnce([enviada, acusada])
  const r = await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {})
  jest.useRealTimers()
  return JSON.parse(r.content[0].text).recentStamped
}

afterEach(() => jest.useRealTimers())

describe('cfdi_status — C2 · T10 (C2-31): el estado de la cancelación en cada consulta', () => {
  it('control — enviada hace 30 s y sin acuse ⇒ ENVIANDO (sin texto de duda); con acuse ⇒ EN_TRAMITE', async () => {
    const [e, a] = await consultar(new Date(T0.getTime() + 30_000))
    expect(e).toMatchObject({ id: 'enviada', estadoCancelacion: 'ENVIANDO', cancelacionEnTramite: true })
    expect(e).not.toHaveProperty('cancelacion')
    expect(a).toMatchObject({ id: 'acusada', estadoCancelacion: 'EN_TRAMITE', cancelacionEnTramite: true })
  })
  it('control — la MISMA fila, en una consulta NUEVA pasado el umbral ⇒ CANCELACION_EN_DUDA (sin que nadie escriba nada)', async () => {
    await consultar(new Date(T0.getTime() + 30_000))
    const [e, a] = await consultar(new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000))
    expect(e).toMatchObject({ estadoCancelacion: 'CANCELACION_EN_DUDA', cancelacion: TEXTO_CANCELACION_EN_DUDA })
    expect(a).toMatchObject({ estadoCancelacion: 'EN_TRAMITE' })
  })
  it('control — ninguna lectura devuelve `cancelEnviadaAt` ni `cancelAcusadaAt`', async () => {
    for (const c of await consultar(new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000))) {
      expect(c).not.toHaveProperty('cancelEnviadaAt')
      expect(c).not.toHaveProperty('cancelAcusadaAt')
    }
  })
  it('🔴 T2 R2 + I3: el texto «en duda» dice que puede tardar hasta 24 horas, nombra el botón «Consultar estado» y qué pasa si no se registra', () => {
    expect(TEXTO_CANCELACION_EN_DUDA).toMatch(/^Cancelación en duda: la estamos confirmando con el SAT/)
    expect(TEXTO_CANCELACION_EN_DUDA).toMatch(/hasta 24 horas/)
    expect(TEXTO_CANCELACION_EN_DUDA).toMatch(/«Consultar estado»/)
    expect(TEXTO_CANCELACION_EN_DUDA).toMatch(/podrás pedirla otra vez/)
    expect(TEXTO_CANCELACION_EN_DUDA).not.toMatch(/pulsa «Cancelar»/)
  })
})

// C2 · T10 ronda 1 (M5): `estadoCancelacion: 'RECHAZADA'` decía QUÉ pasó pero no POR QUÉ. El hermano de M9 (la lista del panel ya lo dice).
describe('cfdi_status — C2 · T10 ronda 1 (M5): el porqué de una cancelación rechazada', () => {
  const MOTIVO = 'El receptor rechazó la cancelación ante el SAT: la factura sigue vigente.'
  async function con(filas: unknown[]): Promise<any[]> {
    mockCfdiFindMany.mockResolvedValueOnce(filas)
    const r = await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {})
    return JSON.parse(r.content[0].text).recentStamped
  }
  it('🔴 rechazada ⇒ `motivoRechazoCancelacion` con el texto de la fila; la consulta lo pide', async () => {
    const [r] = await con([{ ...base, id: 'rech', folio: '3', cancelStatus: 'REJECTED', cancelIntento: 1, lastError: MOTIVO }])
    expect(r).toMatchObject({ estadoCancelacion: 'RECHAZADA', motivoRechazoCancelacion: MOTIVO })
    expect(mockCfdiFindMany.mock.calls.at(-1)[0].select).toMatchObject({ lastError: true })
  })
  it('control — sin rechazo no viaja (ni el `lastError` crudo de la fila)', async () => {
    const [r] = await con([{ ...acusada, lastError: 'un error técnico viejo' }])
    expect(r).not.toHaveProperty('motivoRechazoCancelacion')
    expect(r).not.toHaveProperty('lastError')
  })
})

// Ronda QA (hermanos): `byStatus.STAMP_FAILED` mezcla rechazos y timbres EN DUDA; el agente no puede llamarlos «rechazados».
describe('cfdi_status — ronda QA (hermanos): timbres en duda', () => {
  it('🔴 cuenta aparte los timbres en duda (`timbresEnDuda`), con la MISMA regla que la conciliación', async () => {
    mockCfdiFindMany.mockResolvedValueOnce([])
    mockCfdiCount.mockResolvedValueOnce(3)
    const out = JSON.parse((await handlers.get('cfdi_status')!({ venueId: 'v1', limit: 5 }, {})).content[0].text)
    expect(out.timbresEnDuda).toBe(3)
    expect(mockCfdiCount).toHaveBeenCalledWith({
      where: { venueId: { in: ['v1'] }, status: 'STAMP_FAILED', protocoloIva: 1, enviadoAt: { not: null }, falloDefinitivo: false },
    })
  })
})
