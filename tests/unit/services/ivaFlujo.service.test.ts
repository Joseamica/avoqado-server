/**
 * Unit tests (mock-first) para IVA en flujo de efectivo (Capa B).
 * Lock fiscal: (1) suma multi-venue por RFC la base y el IVA que cada income statement ya calculó por
 * tasa real (el split es por-pago dentro de getIncomeStatement, no un split único del agregado);
 * (2) IVA acreditable pagado (Fase 2) resta al IVA a cargo y el IVA retenido a proveedores se reporta
 * aparte; la retención de ventas sigue null (NUNCA 0); (3) periodo inválido → 400; (4) zeroActivity
 * recuerda declarar en ceros.
 */
import { BadRequestError, ServiceUnavailableError, ValidationError } from '../../../src/errors/AppError'
import { splitIvaIncluded } from '../../../src/services/fiscal/ivaMath'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
    cfdi: { aggregate: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({
  resolveScopeOrNull: jest.fn(),
}))
jest.mock('../../../src/services/dashboard/accounting.dashboard.service', () => ({
  getIncomeStatement: jest.fn(),
  // I2 y T6 M5 (revisión final): el presupuesto de la petición y el texto mensual salen de aquí.
  TIEMPO_MAXIMO_DEL_REPORTE_MS: 90_000,
  LIMITES_DEL_REPORTE: { tiempoMaximoMs: 90_000, maxOrdenes: 300_000 },
  MENSAJE_MES_NO_CALCULADO: 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.',
}))
jest.mock('../../../src/services/fiscal/expense.service', () => ({
  getAcreditablePagado: jest.fn(),
}))
jest.mock('../../../src/services/fiscal/salesRetention.service', () => ({
  getSalesRetentionCents: jest.fn(),
}))
jest.mock('../../../src/utils/datetime', () => ({
  parseDbDateRange: () => ({ from: new Date('2026-06-01T06:00:00Z'), to: new Date('2026-07-01T05:59:59Z') }),
}))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import { getIncomeStatement } from '../../../src/services/dashboard/accounting.dashboard.service'
import { getAcreditablePagado } from '../../../src/services/fiscal/expense.service'
import { getSalesRetentionCents } from '../../../src/services/fiscal/salesRetention.service'
import { getIvaCashflow } from '../../../src/services/fiscal/ivaFlujo.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  cfdi: { aggregate: jest.Mock }
}
const mockScope = resolveScopeOrNull as jest.Mock
const mockIncome = getIncomeStatement as jest.Mock
const mockAcreditable = getAcreditablePagado as jest.Mock
const mockSalesRet = getSalesRetentionCents as jest.Mock
const acreditableResult = (acreditablePagadoCents: number, ivaRetenidoTercerosCents = 0) => ({
  organizationId: 'org1',
  rfc: 'EKU9003173C9',
  period: '2026-06',
  acreditablePagadoCents,
  ivaRetenidoTercerosCents,
  isrRetenidoTercerosCents: 0,
  expenseCount: acreditablePagadoCents > 0 ? 1 : 0,
})

// Mock de un income statement de un local: el monto es GROSS (IVA-incluido) y se desglosa al 16% como
// lo haría el read-model real (base + IVA por tasa). ivaFlujo SUMA estos campos ya calculados.
const income = (grossCents: number, salesCount = 1) => {
  const { netCents, taxCents } = splitIvaIncluded(grossCents, 0.16)
  const rev = {
    grossSalesCents: grossCents,
    refundsCents: 0,
    netRevenueCents: grossCents,
    taxableBaseCents: netCents,
    ivaCents: taxCents,
    taxByRate: taxCents ? { '0.16': taxCents } : {},
  }
  // Sin exclusiones de alcance → la vista fiscal espeja la gerencial.
  return {
    revenue: rev,
    fiscalRevenue: rev,
    tips: { totalCents: 0 },
    metrics: { salesCount, refundCount: 0, averageTicketCents: 0 },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'FOOD_SERVICE' })
  p.cfdi.aggregate.mockResolvedValue({ _sum: { taxCents: 0 }, _count: { _all: 0 } })
  mockAcreditable.mockResolvedValue(acreditableResult(0)) // por defecto: sin gastos acreditables
  mockSalesRet.mockResolvedValue(null) // sin retención de ventas capturada por default
})

it('periodo inválido (mes 13) → 400', async () => {
  await expect(getIvaCashflow('v1', '2026-13')).rejects.toThrow(BadRequestError)
})

it('sin RFC → needsFiscalSetup, no consulta ingresos', async () => {
  mockScope.mockResolvedValue(null)
  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.needsFiscalSetup).toBe(true)
  expect(mockIncome).not.toHaveBeenCalled()
})

it('suma multi-venue del MISMO RFC la base y el IVA ya calculados por local (split por-pago, no del agregado)', async () => {
  // 2 locales del mismo RFC, misma org. Cada income statement ya trae su split al 16%; ivaFlujo SUMA.
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
  ])
  mockIncome.mockResolvedValueOnce(income(10000)).mockResolvedValueOnce(income(10001))

  const r = await getIvaCashflow('v1', '2026-06')

  // v1 10000 → base 8621, tax 1379 · v2 10001 → base 8622, tax 1379 · Σ tax 2758, Σ base 17243
  expect(r.ivaTrasladadoCobradoCents).toBe(2758)
  expect(r.baseGravableCents).toBe(17243)
  expect(r.ivaTrasladadoPorTasaCents).toEqual({ '0.16': 2758 })
  expect(r.venueIds).toEqual(['v1', 'v2'])
  expect(mockIncome).toHaveBeenCalledTimes(2)
})

it('sin gastos acreditables: acreditable=0 disponible, retención de ventas null (NUNCA 0), a pagar = trasladado', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000))

  const r = await getIvaCashflow('v1', '2026-06')

  expect(r.acreditablePagadoCents).toBe(0) // disponible (lado gastos existe), 0 legítimo
  expect(r.acreditableDisponible).toBe(true)
  expect(r.incompletoPorFaltaDeGastos).toBe(false)
  expect(r.retencionesCents).toBeNull() // retención AL contribuyente (ventas) aún no capturada
  expect(r.saldoAFavorAplicadoCents).toBeNull()
  expect(r.computedAt16Percent).toBe(false) // IVA por tasa real; ya no es un 16% plano asumido
  // 116000 → split: base 100000, tax 16000; sin acreditable, a pagar == trasladado
  expect(r.ivaTrasladadoCobradoCents).toBe(16000)
  expect(r.ivaAPagarPreliminarCents).toBe(16000)
  expect(r.saldoAFavorDelPeriodoCents).toBe(0)
})

it('resta la retención de IVA en ventas capturada del periodo', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000)) // trasladado 16000
  mockSalesRet.mockResolvedValue({ isrRetenidoCents: 0, ivaRetenidoCents: 3000 }) // le retuvieron 3000 de IVA
  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.retencionesCents).toBe(3000) // ya no es null
  expect(r.ivaAPagarPreliminarCents).toBe(13000) // 16000 − 0 acreditable − 3000 retención
})

it('con IVA acreditable pagado: resta al IVA a cargo y reporta el IVA retenido a proveedores aparte', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000)) // trasladado 16000
  mockAcreditable.mockResolvedValue(acreditableResult(10000, 500)) // acreditable 10000, IVA retenido a terceros 500

  const r = await getIvaCashflow('v1', '2026-06')

  expect(r.acreditablePagadoCents).toBe(10000)
  expect(r.ivaRetenidoTercerosCents).toBe(500) // obligación separada, NO resta al neto
  expect(r.ivaAPagarPreliminarCents).toBe(6000) // 16000 − 10000
  expect(r.saldoAFavorDelPeriodoCents).toBe(0)
})

it('acreditable > trasladado → saldo a favor del periodo (neto negativo)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000)) // trasladado 16000
  mockAcreditable.mockResolvedValue(acreditableResult(20000)) // acreditable 20000 > 16000

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.ivaAPagarPreliminarCents).toBe(0)
  expect(r.saldoAFavorDelPeriodoCents).toBe(4000) // 20000 − 16000
})

it('sin ventas cobradas → zeroActivity (recordar declarar en ceros)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(0, 0))

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.zeroActivity).toBe(true)
  expect(r.ivaTrasladadoCobradoCents).toBe(0)
})

it('RFC que abarca >1 organización → flag rfcSpansMultipleOrgs (igual se suman)', async () => {
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org2', timezone: 'America/Mexico_City' },
  ])
  mockIncome.mockResolvedValue(income(58000))

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.rfcSpansMultipleOrgs).toBe(true)
  expect(r.venueIds).toHaveLength(2)
})

it('CFDI contraste: Σ Cfdi.taxCents se reporta como ivaAmparadoPorCfdi (NO como base)', async () => {
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
  mockIncome.mockResolvedValue(income(116000))
  p.cfdi.aggregate.mockResolvedValue({ _sum: { taxCents: 9999 }, _count: { _all: 3 } })

  const r = await getIvaCashflow('v1', '2026-06')
  expect(r.ivaAmparadoPorCfdiCents).toBe(9999)
  expect(r.cfdiCount).toBe(3)
  // el contraste NO cambia la base derivada de Payments
  expect(r.ivaTrasladadoCobradoCents).toBe(16000)
})

it('plan 4b · suma por local las bases de tasa 0, exenta y no objeto; la base gravable sigue siendo la suma de taxableBaseCents', async () => {
  p.venue.findMany.mockResolvedValue([
    { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
    { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
  ])
  const conBases = (base: number, tasa0: number, exento: number, noObjeto: number) => {
    const r = income(11600)
    const rev = { ...r.fiscalRevenue, taxableBaseCents: base, tasa0BaseCents: tasa0, exentoBaseCents: exento, noObjetoBaseCents: noObjeto }
    return { ...r, revenue: rev, fiscalRevenue: rev }
  }
  mockIncome.mockResolvedValueOnce(conBases(15000, 5000, 3000, 2000)).mockResolvedValueOnce(conBases(10000, 0, 700, 0))
  expect(await getIvaCashflow('v1', '2026-06')).toMatchObject({
    baseGravableCents: 25000,
    tasa0BaseCents: 5000,
    exentoBaseCents: 3700,
    noObjetoBaseCents: 2000,
  })
})

describe('B4b · movimientos con IVA aproximado (lado fiscal; desconocido ≠ 0)', () => {
  const conAproximados = (gross: number, cuantos: number) => {
    const i = income(gross)
    return { ...i, fiscalRevenue: { ...i.fiscalRevenue, movimientosConIvaAproximado: cuantos } }
  }
  beforeEach(() =>
    p.venue.findMany.mockResolvedValue([
      { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
      { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
    ]),
  )

  it('🔴 suma lo fiscal de cada local del RFC', async () => {
    mockIncome.mockResolvedValueOnce(conAproximados(10000, 2)).mockResolvedValueOnce(conAproximados(10001, 0))
    const r = await getIvaCashflow('v1', '2026-06')
    expect(r.movimientosConIvaAproximado).toBe(2)
    expect(r.computedAt16Percent).toBe(false) // el campo de siempre se queda
  })

  it('🔴 si un local no lo trae, no se afirma nada: undefined', async () => {
    mockIncome.mockResolvedValueOnce(conAproximados(10000, 2)).mockResolvedValueOnce(income(10001))
    expect((await getIvaCashflow('v1', '2026-06')).movimientosConIvaAproximado).toBeUndefined()
  })
})

describe('B4b · los locales del RFC de dos en dos, y un mes sólo con devoluciones no es «sin actividad» (Codex r5 R5-9, R5-10)', () => {
  afterEach(() => mockIncome.mockReset()) // `clearAllMocks` no borra un mockImplementation

  it('🔴 con cinco locales, nunca más de dos estados de resultados a la vez, y la suma no cambia', async () => {
    p.venue.findMany.mockResolvedValue(
      ['v1', 'v2', 'v3', 'v4', 'v5'].map(id => ({ id, organizationId: 'org1', timezone: 'America/Mexico_City' })),
    )
    let enCurso = 0
    let maximo = 0
    mockIncome.mockImplementation(async () => {
      enCurso += 1
      maximo = Math.max(maximo, enCurso)
      await new Promise(r => setTimeout(r, 5))
      enCurso -= 1
      return income(11600)
    })
    const r = await getIvaCashflow('v1', '2026-06')
    expect(maximo).toBe(2)
    expect(mockIncome).toHaveBeenCalledTimes(5)
    expect(r.ivaTrasladadoCobradoCents).toBe(5 * 1600)
  })

  it('🔴 un mes con devoluciones y sin ventas: zeroActivity es false y refundCount las suma', async () => {
    p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
    const soloDevoluciones = income(0, 0)
    mockIncome.mockResolvedValueOnce({ ...soloDevoluciones, metrics: { ...soloDevoluciones.metrics, refundCount: 2 } })
    const r = await getIvaCashflow('v1', '2026-06')
    expect(r.zeroActivity).toBe(false)
    expect(r.refundCount).toBe(2)
  })

  it('control · sin ventas ni devoluciones sigue siendo zeroActivity', async () => {
    p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }])
    mockIncome.mockResolvedValueOnce(income(0, 0))
    expect((await getIvaCashflow('v1', '2026-06')).zeroActivity).toBe(true)
  })
})

describe('B4b · I2 (revisión final): UN presupuesto por petición, para que el IVA en flujo de un RFC con varios locales no pase el corte de 100 s del proxy', () => {
  const MENSUAL = 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.'
  const INICIO = 1_000_000
  let ahora = INICIO
  beforeEach(() => {
    ahora = INICIO
    jest.spyOn(Date, 'now').mockImplementation(() => ahora)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    mockIncome.mockReset() // `clearAllMocks` no borra un mockImplementation
  })
  const locales = (n: number) =>
    p.venue.findMany.mockResolvedValue(
      Array.from({ length: n }, (_, i) => ({ id: `v${i + 1}`, organizationId: 'org1', timezone: 'America/Mexico_City' })),
    )

  it('🔴 la segunda pareja recibe lo que QUEDA del presupuesto (90 s desde que empezó la petición), no otros 90 s', async () => {
    locales(4)
    const recibio: Record<string, unknown> = {}
    mockIncome.mockImplementation(async (id: string, _f: unknown, limites?: { tiempoMaximoMs: number; maxOrdenes: number }) => {
      recibio[id] = limites
      await Promise.resolve()
      ahora = Math.max(ahora, INICIO + 40_000) // la primera pareja tarda 40 s
      return income(11600)
    })
    const r = await getIvaCashflow('v1', '2026-06')
    expect(recibio).toEqual({
      v1: { tiempoMaximoMs: 90_000, maxOrdenes: 300_000 },
      v2: { tiempoMaximoMs: 90_000, maxOrdenes: 300_000 },
      v3: { tiempoMaximoMs: 50_000, maxOrdenes: 300_000 },
      v4: { tiempoMaximoMs: 50_000, maxOrdenes: 300_000 },
    })
    expect(r.ivaTrasladadoCobradoCents).toBe(4 * 1600)
  })

  it('🔴 con el presupuesto agotado no arranca otro estado de resultados: REPORT_TIMEOUT con el texto mensual', async () => {
    locales(3)
    mockIncome.mockImplementation(async () => {
      await Promise.resolve()
      ahora = INICIO + 89_500 // quedan 500 ms: menos del mínimo para abrir una foto
      return income(11600)
    })
    const error = await getIvaCashflow('v1', '2026-06').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(error).toMatchObject({ message: MENSUAL, code: 'REPORT_TIMEOUT', statusCode: 503 })
    expect(mockIncome).toHaveBeenCalledTimes(2) // el tercero nunca arranca
    expect(p.cfdi.aggregate).not.toHaveBeenCalled() // ni nada de lo que sigue
  })

  it('🔴 si la petición ya gastó su presupuesto antes de empezar (buscar los locales), no arranca ninguno', async () => {
    p.venue.findMany.mockImplementation(async () => {
      ahora = INICIO + 90_000
      return [{ id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' }]
    })
    mockIncome.mockResolvedValue(income(11600))
    await expect(getIvaCashflow('v1', '2026-06')).rejects.toMatchObject({ message: MENSUAL, code: 'REPORT_TIMEOUT' })
    expect(mockIncome).not.toHaveBeenCalled()
  })
})

describe('B4b · T6 M5 (revisión final): el IVA en flujo es de UN mes, así que su error dice el texto mensual (salvo el de una venta)', () => {
  const MENSUAL = 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.'
  beforeEach(() =>
    p.venue.findMany.mockResolvedValue([
      { id: 'v1', organizationId: 'org1', timezone: 'America/Mexico_City' },
      { id: 'v2', organizationId: 'org1', timezone: 'America/Mexico_City' },
    ]),
  )
  afterEach(() => mockIncome.mockReset())

  it('🔴 el REPORT_TIMEOUT de un estado de resultados de adentro («elige un rango más corto») sale con el texto mensual y 503', async () => {
    mockIncome.mockRejectedValue(
      new ServiceUnavailableError('El periodo es muy grande para calcularlo de una vez; elige un rango más corto.', 'REPORT_TIMEOUT'),
    )
    await expect(getIvaCashflow('v1', '2026-06')).rejects.toMatchObject({ message: MENSUAL, code: 'REPORT_TIMEOUT', statusCode: 503 })
  })

  it('🔴 un REPORT_TOO_LARGE del PERIODO (más de 300,000 órdenes) sale con el texto mensual; conserva código, 422 y details', async () => {
    const details = { motivo: 'PERIODO', limite: 300_000 }
    mockIncome.mockRejectedValue(
      new ValidationError(
        'El periodo tiene más de 300,000 ventas y no se puede calcular de una vez; elige un rango más corto.',
        'REPORT_TOO_LARGE',
        details,
      ),
    )
    await expect(getIvaCashflow('v1', '2026-06')).rejects.toMatchObject({
      message: MENSUAL,
      code: 'REPORT_TOO_LARGE',
      statusCode: 422,
      details,
    })
  })

  it('control — un REPORT_TOO_LARGE de una VENTA conserva su texto, que nombra el folio', async () => {
    const porVenta = new ValidationError(
      'La venta F-1234 tiene demasiados renglones, descuentos o devoluciones para calcular este reporte. Escríbenos a soporte con ese folio.',
      'REPORT_TOO_LARGE',
      { motivo: 'ORDEN', folio: 'F-1234' },
    )
    mockIncome.mockRejectedValue(porVenta)
    await expect(getIvaCashflow('v1', '2026-06')).rejects.toBe(porVenta)
  })
})
