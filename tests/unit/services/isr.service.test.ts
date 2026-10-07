/**
 * Unit tests (mock-first) para ISR — pago provisional (Capa B).
 *  - RESICO: ingresos del mes × tasa por tramo (1%–2.5%), sin deducciones.
 *  - GENERAL: (ingresos − deducciones) acumulado × tarifa art-96 acumulada − pagos previos.
 *  - tope RESICO $3.5M anual; periodo inválido → 400.
 */
import { BadRequestError, ServiceUnavailableError, ValidationError } from '../../../src/errors/AppError'

jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn(), findUnique: jest.fn() },
    expense: { aggregate: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
// B4b (fallo 1 de la ronda 8): el ISR corre en UNA foto; el doble pasa una «transacción» y delega en el mismo `getIncomeStatement`,
// así que las pruebas de siempre no cambian.
jest.mock('../../../src/services/dashboard/accounting.dashboard.service', () => {
  const getIncomeStatement = jest.fn()
  return {
    getIncomeStatement,
    LIMITES_DEL_REPORTE: { tiempoMaximoMs: 120_000, maxOrdenes: 300_000 },
    MENSAJE_MES_NO_CALCULADO: 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.',
    conFotoDeReporte: jest.fn((_contexto: unknown, fn: (tx: unknown) => unknown) => fn({ foto: 'del ISR' })),
    estadoDeResultadosEnFoto: jest.fn((_tx: unknown, venue: { id: string }, filters: unknown) => getIncomeStatement(venue.id, filters)),
  }
})
jest.mock('../../../src/services/fiscal/salesRetention.service', () => ({ getSalesRetentionCents: jest.fn() }))
jest.mock('../../../src/services/fiscal/cogs.service', () => ({ computePeriodCogsCentsRange: jest.fn() }))
jest.mock('../../../src/services/fiscal/fixedAssetDepreciation.service', () => ({ getYearDepreciationCents: jest.fn() }))
jest.mock('../../../src/services/fiscal/fiscalLoss.service', () => ({ getPendingLossCents: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'
import {
  conFotoDeReporte,
  estadoDeResultadosEnFoto,
  getIncomeStatement,
} from '../../../src/services/dashboard/accounting.dashboard.service'
import { getSalesRetentionCents } from '../../../src/services/fiscal/salesRetention.service'
import { computePeriodCogsCentsRange } from '../../../src/services/fiscal/cogs.service'
import { getYearDepreciationCents } from '../../../src/services/fiscal/fixedAssetDepreciation.service'
import { getPendingLossCents } from '../../../src/services/fiscal/fiscalLoss.service'
import { applyTariff, ART96_MONTHLY, getIsrProvisional, TIEMPO_MAXIMO_DEL_ISR_MS } from '../../../src/services/fiscal/isr.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock; findUnique: jest.Mock }
  expense: { aggregate: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mIncome = getIncomeStatement as jest.Mock
const mSalesRet = getSalesRetentionCents as jest.Mock
const mCogs = computePeriodCogsCentsRange as jest.Mock
const mDeprec = getYearDepreciationCents as jest.Mock
const mLoss = getPendingLossCents as jest.Mock

// La base de ISR es SIN IVA → el monto representa `taxableBaseCents` (lo que ISR usa como ingreso).
const income = (baseCents: number, salesCount = 1) => {
  const rev = {
    grossSalesCents: baseCents,
    refundsCents: 0,
    netRevenueCents: baseCents,
    taxableBaseCents: baseCents,
    ivaCents: 0,
    taxByRate: {} as Record<string, number>,
  }
  // Sin exclusiones de alcance → la vista fiscal espeja la gerencial (ISR lee fiscalRevenue).
  return {
    revenue: rev,
    fiscalRevenue: rev,
    tips: { totalCents: 0 },
    metrics: { salesCount, refundCount: 0, averageTicketCents: 0 },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9', venueType: 'AUTO_SERVICE' })
  p.venue.findMany.mockResolvedValue([{ id: 'v1', organizationId: 'org1' }])
  p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 0, descuentoCents: 0, iepsCents: 0 } })
  mSalesRet.mockResolvedValue(null) // sin retención capturada por default
  mCogs.mockResolvedValue(0) // sin costo de ventas por default (RESICO lo ignora)
  mDeprec.mockResolvedValue(0) // sin depreciación por default
  mLoss.mockResolvedValue(0) // sin pérdidas de ejercicios anteriores por default
})

describe('getIsrProvisional — RESICO', () => {
  it('periodo inválido → BadRequestError', async () => {
    await expect(getIsrProvisional('v1', '2026-13', 'RESICO')).rejects.toThrow(BadRequestError)
  })

  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.needsFiscalSetup).toBe(true)
  })

  it('$20,000/mes → tasa 1% → ISR $200', async () => {
    mIncome.mockResolvedValue(income(20_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(0.01)
    expect(r.isrCausadoCents).toBe(200_00)
    expect(r.isrAPagarCents).toBe(200_00)
  })

  it('resta la retención de ISR en ventas capturada del periodo', async () => {
    mIncome.mockResolvedValue(income(20_000_00)) // ISR causado $200
    mSalesRet.mockResolvedValue({ isrRetenidoCents: 50_00, ivaRetenidoCents: 0 }) // le retuvieron $50
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.retencionesIsrCents).toBe(50_00)
    expect(r.isrAPagarCents).toBe(150_00) // 200 − 50
  })

  it('$60,000/mes → tasa 1.5% → ISR $900', async () => {
    mIncome.mockResolvedValue(income(60_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(0.015)
    expect(r.isrCausadoCents).toBe(900_00)
  })

  it('marca excedeTopeResico si los ingresos ACUMULADOS rebasan $3.5M', async () => {
    mIncome.mockResolvedValue(income(4_000_000_00))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.excedeTopeResico).toBe(true)
  })

  it('sin ventas → zeroActivity, ISR 0', async () => {
    mIncome.mockResolvedValue(income(0, 0))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.zeroActivity).toBe(true)
    expect(r.isrCausadoCents).toBe(0)
  })
})

describe('getIsrProvisional — RESICO tabla de tasas por tramo (fronteras exactas)', () => {
  // `resicoTasa` usa `<=`: la frontera (tope) pertenece al tramo INFERIOR; un centavo más salta al siguiente.
  // Tabla 2024/2025: ≤25k→1% · ≤50k→1.1% · ≤83,333.33→1.5% · ≤208,333.33→2% · resto→2.5%.
  const casos: [string, number, number][] = [
    ['$1 (piso)', 1_00, 0.01],
    ['$25,000 exacto → tope del 1%', 25_000_00, 0.01],
    ['$25,000.01 → salta a 1.1%', 25_000_01, 0.011],
    ['$40,000 → dentro del 1.1%', 40_000_00, 0.011],
    ['$50,000 exacto → tope del 1.1%', 50_000_00, 0.011],
    ['$50,000.01 → salta a 1.5%', 50_000_01, 0.015],
    ['$83,333.33 exacto → tope del 1.5%', 83_333_33, 0.015],
    ['$83,333.34 → salta a 2%', 83_333_34, 0.02],
    ['$208,333.33 exacto → tope del 2%', 208_333_33, 0.02],
    ['$208,333.34 → salta a 2.5%', 208_333_34, 0.025],
    ['$300,000 → dentro del 2.5%', 300_000_00, 0.025],
  ]
  it.each(casos)('%s', async (_label, ingresoCents, tasaEsperada) => {
    mIncome.mockResolvedValue(income(ingresoCents))
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.tasaResico).toBe(tasaEsperada)
    expect(r.isrCausadoCents).toBe(Math.round(ingresoCents * tasaEsperada))
    expect(r.excedeTopeResico).toBe(false) // ningún caso rebasa el tope anual $3.5M
  })
})

describe('getIsrProvisional — GENERAL (art 96)', () => {
  it('enero: utilidad = ingresos − deducciones; ISR por tarifa art-96 (exacto)', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos acum ene = $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // deducciones $10,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.deduccionesAcumCents).toBe(10_000_00)
    expect(r.utilidadFiscalCents).toBe(20_000_00) // $20,000
    // tarifa mensual: renglón limInf $15,487.72 cuota $1,640.18 16... 21.36%
    // ISR = 164018 + (2,000,000 − 1,548,772) × 0.2136 = 260,400 centavos = $2,604.00
    expect(r.isrCausadoCents).toBe(260_400)
    expect(r.pagosProvisionalesPreviosCents).toBe(0) // enero no tiene previos
    expect(r.isrAPagarCents).toBe(260_400)
  })

  it('utilidad 0 (deducciones ≥ ingresos) → ISR 0', async () => {
    mIncome.mockResolvedValue(income(10_000_00))
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 15_000_00, descuentoCents: 0, iepsCents: 0 } })
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.utilidadFiscalCents).toBe(0)
    expect(r.isrCausadoCents).toBe(0)
  })

  it('el costo de ventas acumulado reduce la utilidad fiscal (deducible en GENERAL)', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // gastos $10,000
    mCogs.mockResolvedValue(5_000_00) // costo de ventas $5,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.costoVentasAcumCents).toBe(5_000_00)
    expect(r.utilidadFiscalCents).toBe(15_000_00) // 30,000 − 10,000 − 5,000
  })

  it('la depreciación de activos fijos (deducción de inversiones) reduce la utilidad fiscal', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // gastos $10,000
    mDeprec.mockResolvedValue(3_000_00) // depreciación del ejercicio $3,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.deduccionInversionesAcumCents).toBe(3_000_00)
    expect(r.utilidadFiscalCents).toBe(17_000_00) // 30,000 − 10,000 − 0 COGS − 3,000 depreciación
  })

  it('las pérdidas de ejercicios anteriores reducen la utilidad fiscal', async () => {
    mIncome.mockResolvedValue(income(30_000_00)) // ingresos $30,000
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 10_000_00, descuentoCents: 0, iepsCents: 0 } }) // gastos $10,000
    mLoss.mockResolvedValue(8_000_00) // pérdidas pendientes $8,000
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.perdidasFiscalesAplicadaCents).toBe(8_000_00)
    expect(r.utilidadFiscalCents).toBe(12_000_00) // 30,000 − 10,000 − 8,000
  })

  it('control — T6 M1 (revisión final) · marzo con ingresos de $1,000 / $2,000 / $3,000: los pagos previos son la tarifa acumulada de DOS meses sobre enero + febrero ($3,000), no otro tramo de meses', async () => {
    const porMes: Record<string, number> = { '2026-01-01': 1_000_00, '2026-02-01': 2_000_00, '2026-03-01': 3_000_00 }
    mIncome.mockImplementation(async (_venueId: string, { from }: { from: string }) => income(porMes[from]))
    const r = await getIsrProvisional('v1', '2026-03', 'GENERAL')
    // Tarifa de 2 meses (límite inferior y cuota fija × 2): renglón 2, 2,864 + (300,000 − 149,210) × 0.064 = 12,514.56 ⇒ 12,515 ¢.
    const dosMeses = ART96_MONTHLY.map(f => ({ limInfCents: f.limInfCents * 2, cuotaFijaCents: f.cuotaFijaCents * 2, pct: f.pct }))
    expect(applyTariff(3_000_00, dosMeses)).toBe(12_515)
    expect(r.pagosProvisionalesPreviosCents).toBe(12_515)
    // El mes: tarifa de 3 meses sobre $6,000 = 4,296 + (600,000 − 223,815) × 0.064 = 28,371.84 ⇒ 28,372 ¢; a pagar, la diferencia.
    expect(r.ingresosAcumCents).toBe(6_000_00)
    expect(r.isrCausadoCents).toBe(28_372)
    expect(r.isrAPagarCents).toBe(28_372 - 12_515)
    mIncome.mockReset() // `clearAllMocks` no borra un mockImplementation
  })

  it('las pérdidas se TOPAN a la utilidad (no la vuelven negativa)', async () => {
    mIncome.mockResolvedValue(income(30_000_00))
    p.expense.aggregate.mockResolvedValue({ _sum: { subtotalCents: 25_000_00, descuentoCents: 0, iepsCents: 0 } }) // utilidad antes = $5,000
    mLoss.mockResolvedValue(20_000_00) // pérdidas $20,000 > utilidad
    const r = await getIsrProvisional('v1', '2026-01', 'GENERAL')
    expect(r.perdidasFiscalesAplicadaCents).toBe(5_000_00) // solo se aplica lo que cabe
    expect(r.utilidadFiscalCents).toBe(0)
    expect(r.isrCausadoCents).toBe(0)
  })
})

describe('getIsrProvisional — RESICO ignora deducciones de GENERAL', () => {
  it('RESICO grava ingresos brutos: NI el COGS NI la depreciación reducen el ISR', async () => {
    mIncome.mockResolvedValue(income(20_000_00)) // ISR causado $200 (1%)
    mCogs.mockResolvedValue(5_000_00) // aunque haya costo de ventas...
    mDeprec.mockResolvedValue(3_000_00) // ...depreciación...
    mLoss.mockResolvedValue(9_000_00) // ...y pérdidas de años anteriores...
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.costoVentasAcumCents).toBe(0) // ...RESICO no los considera
    expect(r.deduccionInversionesAcumCents).toBe(0)
    expect(r.perdidasFiscalesAplicadaCents).toBe(0)
    expect(r.isrCausadoCents).toBe(200_00)
  })
})

describe('plan 4b · el ingreso del ISR es TODO el ingreso sin IVA (criterio 3)', () => {
  it('exento y no objeto incluidos: usa ingresosSinIvaCents, no la base gravable', async () => {
    const base = income(10000)
    mIncome.mockResolvedValue({ ...base, fiscalRevenue: { ...base.fiscalRevenue, ingresosSinIvaCents: 15000 } })
    const r = await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(r.ingresosMesCents).toBe(15000)
    expect(r.isrCausadoCents).toBe(150) // 1 %
  })

  it('sin el campo (Ruling 4b-R9) usa la base gravable, como hoy', async () => {
    mIncome.mockResolvedValue(income(10000))
    expect((await getIsrProvisional('v1', '2026-06', 'RESICO')).ingresosMesCents).toBe(10000)
  })
})

describe('B4b · el ISR acumulado, mes por mes y en UNA foto (fallos 2 de la ronda 7 y 1 de la ronda 8; Codex r5 R5-9, r6 R6-2, r7 R7-1)', () => {
  it('🔴 T7-I1 · el tiempo máximo del ISR queda bajo el corte de 100 s del proxy de Cloudflare, para que REPORT_TIMEOUT llegue al navegador (un 524 nunca trae nuestro código)', () => {
    const CORTE_DEL_PROXY_MS = 100_000
    expect(TIEMPO_MAXIMO_DEL_ISR_MS).toBeLessThan(CORTE_DEL_PROXY_MS)
  })

  it('🔴 fallo 1 de la ronda 8 (Codex r7 R7-1) · todos los meses y locales en UNA foto, con el tiempo del ISR y el texto mensual', async () => {
    p.venue.findMany.mockResolvedValue([
      { id: 'v1', organizationId: 'org1', name: 'X', timezone: null },
      { id: 'v2', organizationId: 'org1', name: 'Y', timezone: null },
    ])
    mIncome.mockResolvedValue(income(10_000_00))
    await getIsrProvisional('v1', '2026-03', 'GENERAL')
    expect(conFotoDeReporte).toHaveBeenCalledTimes(1)
    expect((conFotoDeReporte as jest.Mock).mock.calls[0][0]).toMatchObject({
      venueName: 'X',
      from: '2026-01-01',
      to: '2026-03-31',
      tiempoMaximoMs: TIEMPO_MAXIMO_DEL_ISR_MS,
      mensajeDeTiempo: 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.',
    })
    expect(TIEMPO_MAXIMO_DEL_ISR_MS).toBe(90_000) // T7-I1: bajo el corte de 100 s de Cloudflare
    const llamadas = (estadoDeResultadosEnFoto as jest.Mock).mock.calls
    expect(llamadas).toHaveLength(6) // 3 meses × 2 locales
    expect(new Set(llamadas.map(c => c[0])).size).toBe(1) // la MISMA transacción para todos
    expect(llamadas[0][0]).toEqual({ foto: 'del ISR' })
  })

  it('🔴 fallo 2 de la ronda 7 (Codex r6 R6-2) · 30,000 órdenes al mes: noviembre y su acumulado salen exactos, mes por mes, sin chocar con el tope de 300,000', async () => {
    // El doble aplica el tope como el reporte real: un rango de N meses tiene 30,000 × N órdenes.
    const mesesDe = (from: string, to: string) =>
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1
    let enCurso = 0
    let maximo = 0
    mIncome.mockImplementation(async (_venueId: string, { from, to }: { from: string; to: string }) => {
      const meses = mesesDe(from, to)
      if (30_000 * meses > 300_000) throw new ValidationError('El periodo tiene más de 300,000 ventas…', 'REPORT_TOO_LARGE')
      enCurso += 1
      maximo = Math.max(maximo, enCurso)
      await new Promise(r => setTimeout(r, 1))
      enCurso -= 1
      return income(1_000_00 * Number(from.slice(5, 7)), 30_000) // cada mes, un ingreso distinto: $1,000 × número de mes
    })
    const r = await getIsrProvisional('v1', '2026-11', 'RESICO')
    expect(r.ingresosMesCents).toBe(11_000_00)
    expect(r.ingresosAcumCents).toBe(66_000_00) // 1 + 2 + … + 11 miles: exacto
    expect(mIncome).toHaveBeenCalledTimes(11) // enero a noviembre, y noviembre se reusa como «el mes»
    expect(mIncome.mock.calls.every(c => mesesDe(c[1].from, c[1].to) === 1)).toBe(true) // nunca un rango de más de un mes
    expect(maximo).toBe(1) // uno tras otro
    mIncome.mockReset()
  })

  it('🔴 fallo 2 de la ronda 7 · GENERAL: el ISR causado del mes y el del mes anterior salen de la MISMA lista de meses, sin pedir uno más', async () => {
    mIncome.mockResolvedValue(income(10_000_00))
    await getIsrProvisional('v1', '2026-03', 'GENERAL')
    expect(mIncome).toHaveBeenCalledTimes(3) // enero, febrero y marzo, una vez cada uno
  })

  it('🔴 B4b · Codex r5 R5-9 y fallo 1 de la ronda 8: con cinco locales del RFC, uno a la vez dentro de la foto del ISR (una sola conexión)', async () => {
    p.venue.findMany.mockResolvedValue(['v1', 'v2', 'v3', 'v4', 'v5'].map(id => ({ id, organizationId: 'org1', name: id, timezone: null })))
    let enCurso = 0
    let maximo = 0
    mIncome.mockImplementation(async () => {
      enCurso += 1
      maximo = Math.max(maximo, enCurso)
      await new Promise(r => setTimeout(r, 5))
      enCurso -= 1
      return income(2_000_000)
    })
    await getIsrProvisional('v1', '2026-06', 'RESICO')
    expect(maximo).toBe(1)
    mIncome.mockReset() // `clearAllMocks` no borra un mockImplementation
  })
})

describe('B4b · T6 M5 (revisión final): el ISR es de UN mes, así que su error dice el texto mensual (salvo el de una venta)', () => {
  const MENSUAL = 'No pudimos calcular este mes de una vez; vuelve a intentarlo en unos minutos o escríbenos a soporte.'
  const RANGO = 'El periodo es muy grande para calcularlo de una vez; elige un rango más corto.'
  afterEach(() => mIncome.mockReset())

  it('🔴 un REPORT_TIMEOUT de adentro (con el texto del rango) sale con el texto mensual, mismo código y 503', async () => {
    mIncome.mockRejectedValue(new ServiceUnavailableError(RANGO, 'REPORT_TIMEOUT'))
    await expect(getIsrProvisional('v1', '2026-06', 'RESICO')).rejects.toMatchObject({
      message: MENSUAL,
      code: 'REPORT_TIMEOUT',
      statusCode: 503,
    })
  })

  it('🔴 un REPORT_TOO_LARGE del PERIODO (más de 300,000 órdenes) sale con el texto mensual; conserva código, 422 y details', async () => {
    const details = { motivo: 'PERIODO', limite: 300_000 }
    mIncome.mockRejectedValue(
      new ValidationError(
        'El periodo tiene más de 300,000 ventas y no se puede calcular de una vez; elige un rango más corto.',
        'REPORT_TOO_LARGE',
        details,
      ),
    )
    await expect(getIsrProvisional('v1', '2026-06', 'GENERAL')).rejects.toMatchObject({
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
    mIncome.mockRejectedValue(porVenta)
    await expect(getIsrProvisional('v1', '2026-06', 'RESICO')).rejects.toBe(porVenta)
  })
})
