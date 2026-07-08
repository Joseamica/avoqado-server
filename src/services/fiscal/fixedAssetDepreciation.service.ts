// src/services/fiscal/fixedAssetDepreciation.service.ts
//
// Depreciación de activos fijos en LÍNEA RECTA (deducción de inversiones, LISR art. 31/34-35), slice 2:
// calcular + persistir por periodo. El founder pidió que "el sistema calcule los plazos SOLO".
//
// Método: base depreciable = MOI topado (autos $175k) − valor de rescate. Deducción anual = base × tasa;
// mensual = anual / 12, por meses COMPLETOS desde el inicio de uso. El acumulado se topa a la base (el
// último mes es el remanente) → al llegar a la base el activo queda FULLY_DEPRECIATED. Se calcula el
// acumulado a `period` y a `period-1` y se resta → la suma de los meses = base exacta (telescopio, sin
// deriva de redondeo). Idempotente por (activo, periodo).
//
// LIMITACIÓN v1: base NOMINAL (sin actualización por INPC, art. 31) y SIN póliza al ledger todavía (la
// cuenta de depreciación acumulada es no-hoja en varios giros; postear con la hoja correcta = follow-up).
// El número SÍ se persiste y alimenta la deducción del ISR general (ver isr.service).

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { cappedMoiCents } from './assetTypeCatalog'
import { resolveScopeOrNull } from './chartOfAccounts.service'

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

interface DepreciableAsset {
  moiCents: number
  assetType: string
  salvageValueCents: number
  annualRate: { toString(): string } | number // Prisma.Decimal o number
  inServiceDate: Date
}

/** Meses COMPLETOS de uso desde el inicio hasta `period` inclusive (0 si `period` es anterior). */
export function monthsElapsed(inServiceDate: Date, period: string): number {
  const iy = inServiceDate.getUTCFullYear()
  const im = inServiceDate.getUTCMonth() + 1 // 1-12
  const [py, pm] = period.split('-').map(Number)
  return Math.max(0, (py - iy) * 12 + (pm - im) + 1)
}

export interface DepreciationCompute {
  baseCents: number
  /** Depreciación acumulada a `period` (topada a la base). */
  accumulatedCents: number
  /** Depreciación que corresponde SOLO a `period`. */
  periodCents: number
  fullyDepreciated: boolean
}

/** Cálculo puro de la depreciación en línea recta de un activo a un periodo. */
export function computeDepreciation(asset: DepreciableAsset, period: string): DepreciationCompute {
  const base = Math.max(0, cappedMoiCents(asset.moiCents, asset.assetType) - asset.salvageValueCents)
  const rate = Number(asset.annualRate)
  const monthly = (base * rate) / 12
  const nThis = monthsElapsed(asset.inServiceDate, period)
  const nPrev = Math.max(0, nThis - 1)
  const accThis = Math.min(base, Math.round(monthly * nThis))
  const accPrev = Math.min(base, Math.round(monthly * nPrev))
  const periodCents = Math.max(0, accThis - accPrev)
  return { baseCents: base, accumulatedCents: accThis, periodCents, fullyDepreciated: base > 0 && accThis >= base }
}

export interface GenerateDepreciationResult {
  needsFiscalSetup: boolean
  period: string
  assetsProcessed: number
  assetsDepreciated: number
  totalPeriodCents: number
}

/**
 * Corre la depreciación del periodo para todos los activos ACTIVOS del contribuyente: calcula, PERSISTE el
 * renglón (idempotente por activo+periodo) y marca FULLY_DEPRECIATED al agotarse. No postea póliza (v1).
 */
export async function generateDepreciationForVenue(
  venueId: string,
  period: string,
  _actorStaffId: string | null = null,
): Promise<GenerateDepreciationResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, period, assetsProcessed: 0, assetsDepreciated: 0, totalPeriodCents: 0 }

  const assets = await prisma.fixedAsset.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc, status: 'ACTIVE' },
  })

  let assetsDepreciated = 0
  let totalPeriodCents = 0
  for (const asset of assets) {
    const comp = computeDepreciation(asset, period)
    if (comp.periodCents <= 0) continue // aún no en uso, o ya totalmente depreciado
    await prisma.fixedAssetDepreciation.upsert({
      where: { fixedAssetId_period: { fixedAssetId: asset.id, period } },
      create: { fixedAssetId: asset.id, period, depreciationCents: comp.periodCents, accumulatedCents: comp.accumulatedCents },
      update: { depreciationCents: comp.periodCents, accumulatedCents: comp.accumulatedCents },
    })
    assetsDepreciated++
    totalPeriodCents += comp.periodCents
    if (comp.fullyDepreciated) {
      await prisma.fixedAsset.update({ where: { id: asset.id }, data: { status: 'FULLY_DEPRECIATED' } })
    }
  }

  return { needsFiscalSetup: false, period, assetsProcessed: assets.length, assetsDepreciated, totalPeriodCents }
}

/**
 * Deducción de inversiones ACUMULADA del ejercicio (ene→`throughPeriod`) del contribuyente — lo que el ISR
 * general resta a la utilidad. Lee los renglones ya persistidos (la corrida mensual los genera). 0 si no hay.
 */
export async function getYearDepreciationCents(organizationId: string, rfc: string, year: number, throughPeriod: string): Promise<number> {
  const from = `${year}-01`
  const agg = await prisma.fixedAssetDepreciation.aggregate({
    where: {
      period: { gte: from, lte: throughPeriod },
      fixedAsset: { organizationId, rfc },
    },
    _sum: { depreciationCents: true },
  })
  return agg._sum.depreciationCents ?? 0
}
