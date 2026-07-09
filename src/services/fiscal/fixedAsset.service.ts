// src/services/fiscal/fixedAsset.service.ts
//
// Activos fijos (Capa B fiscal) — "deducción de inversiones" LISR art. 34-35. Slice 1: registro + listado.
// OPT-IN: el sistema solo SUGIERE por monto que una compra parece inversión; el usuario CONFIRMA aquí
// (registra el activo) antes de que algo se deprecie. La tasa default sale del catálogo por tipo, pero es
// EDITABLE (el founder eligió "oficiales por default, editables"). Depreciación en línea recta (slice 2).
// (org, rfc) = contribuyente, mismo scope que Expense/SalesRetention. Money en CENTAVOS enteros.

import { Prisma } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { ASSET_TYPE_CATALOG, cappedMoiCents, getAssetType, type AssetTypeDef } from './assetTypeCatalog'

export interface RegisterFixedAssetInput {
  description: string
  assetType: string
  moiCents: number
  /** Tasa anual (fracción). Si se omite, toma la del catálogo por tipo. */
  annualRate?: number
  acquisitionDate: string // AAAA-MM-DD
  /** Inicio de uso (arranca la depreciación). Default = fecha de adquisición. */
  inServiceDate?: string
  salvageValueCents?: number
  sourceExpenseId?: string | null
}

export interface FixedAssetView {
  id: string
  organizationId: string
  rfc: string
  venueId: string | null
  description: string
  assetType: string
  assetTypeLabel: string
  moiCents: number
  /** Base depreciable = MOI topado (autos $175k) − valor de rescate. */
  depreciableBaseCents: number
  annualRate: number
  acquisitionDate: string
  inServiceDate: string
  salvageValueCents: number
  status: string
  sourceExpenseId: string | null
  disposalDate: string | null
  disposalProceedsCents: number | null
  createdAt: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Ancla al mediodía → el día/mes calendario NO se corre bajo la tz del host (prod corre UTC). */
function parseDay(dateStr: string, field: string): Date {
  if (!DATE_RE.test(dateStr)) throw new BadRequestError(`La fecha de ${field} debe tener formato AAAA-MM-DD.`)
  const d = new Date(`${dateStr}T12:00:00`)
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`La fecha de ${field} no es válida.`)
  return d
}

function toView(a: {
  id: string
  organizationId: string
  rfc: string
  venueId: string | null
  description: string
  assetType: string
  moiCents: number
  annualRate: Prisma.Decimal
  acquisitionDate: Date
  inServiceDate: Date
  salvageValueCents: number
  status: string
  sourceExpenseId: string | null
  disposalDate: Date | null
  disposalProceedsCents: number | null
  createdAt: Date
}): FixedAssetView {
  const def = getAssetType(a.assetType)
  const capped = cappedMoiCents(a.moiCents, a.assetType)
  return {
    id: a.id,
    organizationId: a.organizationId,
    rfc: a.rfc,
    venueId: a.venueId,
    description: a.description,
    assetType: a.assetType,
    assetTypeLabel: def?.label ?? a.assetType,
    moiCents: a.moiCents,
    depreciableBaseCents: Math.max(0, capped - a.salvageValueCents),
    annualRate: Number(a.annualRate),
    acquisitionDate: a.acquisitionDate.toISOString().slice(0, 10),
    inServiceDate: a.inServiceDate.toISOString().slice(0, 10),
    salvageValueCents: a.salvageValueCents,
    status: a.status,
    sourceExpenseId: a.sourceExpenseId,
    disposalDate: a.disposalDate ? a.disposalDate.toISOString().slice(0, 10) : null,
    disposalProceedsCents: a.disposalProceedsCents,
    createdAt: a.createdAt.toISOString(),
  }
}

/** Catálogo de tipos con su tasa default (para poblar el selector del dashboard/MCP). */
export function listAssetTypes(): AssetTypeDef[] {
  return ASSET_TYPE_CATALOG
}

/**
 * Registra (CONFIRMA) una compra como activo fijo. Valida tipo, monto, tasa (0-1) y fechas. La tasa cae al
 * default del catálogo si no se envía. Audita `FIXED_ASSET_REGISTERED`. No deprecia nada todavía (eso es la
 * corrida de depreciación, slice 2) — registrar ≠ depreciar; es el paso de opt-in.
 */
export async function registerFixedAsset(
  venueId: string,
  input: RegisterFixedAssetInput,
  actorStaffId: string | null = null,
): Promise<FixedAssetView> {
  const def = getAssetType(input.assetType)
  if (!def) throw new BadRequestError('Tipo de activo fijo no válido.')
  if (!input.description || !input.description.trim()) throw new BadRequestError('La descripción del activo es requerida.')
  if (!Number.isFinite(input.moiCents) || input.moiCents <= 0)
    throw new BadRequestError('El monto de la inversión (MOI) debe ser mayor a cero.')
  const rate = input.annualRate ?? def.annualRate
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1)
    throw new BadRequestError('La tasa anual de depreciación debe estar entre 0 y 1 (ej. 0.30 = 30%).')
  const salvage = input.salvageValueCents ?? 0
  if (!Number.isFinite(salvage) || salvage < 0) throw new BadRequestError('El valor de rescate no puede ser negativo.')

  const acq = parseDay(input.acquisitionDate, 'adquisición')
  const inService = input.inServiceDate ? parseDay(input.inServiceDate, 'inicio de uso') : acq
  if (inService < acq) throw new BadRequestError('El inicio de uso no puede ser anterior a la adquisición.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) throw new BadRequestError('El local no tiene RFC/emisor fiscal configurado.')

  const asset = await prisma.fixedAsset.create({
    data: {
      organizationId: scope.organizationId,
      rfc: scope.rfc,
      venueId,
      description: input.description.trim(),
      assetType: input.assetType,
      moiCents: Math.round(input.moiCents),
      annualRate: new Prisma.Decimal(rate),
      acquisitionDate: acq,
      inServiceDate: inService,
      salvageValueCents: Math.round(salvage),
      sourceExpenseId: input.sourceExpenseId ?? null,
      createdById: actorStaffId,
    },
  })

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FIXED_ASSET_REGISTERED',
    entity: 'FixedAsset',
    entityId: asset.id,
    data: { assetType: asset.assetType, moiCents: asset.moiCents, annualRate: rate },
  })

  return toView(asset)
}

/** Lista los activos fijos del contribuyente del local (o needsFiscalSetup si no hay RFC). */
export async function listFixedAssets(venueId: string): Promise<{ needsFiscalSetup: boolean; assets: FixedAssetView[] }> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, assets: [] }
  const rows = await prisma.fixedAsset.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc },
    orderBy: { acquisitionDate: 'desc' },
  })
  return { needsFiscalSetup: false, assets: rows.map(toView) }
}

/** Edita un activo fijo (mientras siga ACTIVO). Solo los campos enviados. Valida igual que registrar. Audita. */
export async function updateFixedAsset(
  venueId: string,
  assetId: string,
  input: Partial<RegisterFixedAssetInput>,
  actorStaffId: string | null = null,
): Promise<FixedAssetView> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) throw new BadRequestError('El local no tiene RFC/emisor fiscal configurado.')
  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, organizationId: scope.organizationId, rfc: scope.rfc } })
  if (!asset) throw new NotFoundError('Activo fijo no encontrado.')
  if (asset.status === 'DISPOSED') throw new BadRequestError('No se puede editar un activo dado de baja.')

  const data: Record<string, unknown> = {}
  if (input.description !== undefined) {
    if (!input.description.trim()) throw new BadRequestError('La descripción del activo es requerida.')
    data.description = input.description.trim()
  }
  if (input.assetType !== undefined) {
    if (!getAssetType(input.assetType)) throw new BadRequestError('Tipo de activo fijo no válido.')
    data.assetType = input.assetType
  }
  if (input.moiCents !== undefined) {
    if (!Number.isFinite(input.moiCents) || input.moiCents <= 0) throw new BadRequestError('El monto de la inversión (MOI) debe ser mayor a cero.')
    data.moiCents = Math.round(input.moiCents)
  }
  if (input.annualRate !== undefined) {
    if (!Number.isFinite(input.annualRate) || input.annualRate <= 0 || input.annualRate > 1)
      throw new BadRequestError('La tasa anual de depreciación debe estar entre 0 y 1 (ej. 0.30 = 30%).')
    data.annualRate = new Prisma.Decimal(input.annualRate)
  }
  if (input.salvageValueCents !== undefined) {
    if (!Number.isFinite(input.salvageValueCents) || input.salvageValueCents < 0) throw new BadRequestError('El valor de rescate no puede ser negativo.')
    data.salvageValueCents = Math.round(input.salvageValueCents)
  }
  if (input.acquisitionDate !== undefined) data.acquisitionDate = parseDay(input.acquisitionDate, 'adquisición')
  if (input.inServiceDate !== undefined) data.inServiceDate = parseDay(input.inServiceDate, 'inicio de uso')

  const updated = await prisma.fixedAsset.update({ where: { id: assetId }, data })
  void logAction({ staffId: actorStaffId, venueId, action: 'FIXED_ASSET_UPDATED', entity: 'FixedAsset', entityId: assetId, data: { fields: Object.keys(data) } })
  return toView(updated)
}

export interface DisposeResult {
  asset: FixedAssetView
  accumulatedDepreciationCents: number
  /** Valor en libros = base depreciable − depreciación acumulada. */
  bookValueCents: number
  proceedsCents: number
  /** Ganancia (+) o pérdida (−) contable = precio de venta − valor en libros. */
  gainLossCents: number
}

/**
 * Da de baja un activo (venta u obsolescencia): lo marca DISPOSED (deja de depreciarse) y calcula el valor
 * en libros + la ganancia/pérdida contable (precio de venta − valor en libros). Audita. LIMITACIÓN v1: no
 * postea la póliza de baja al ledger (el activo aún no está en una cuenta de activo — ver limitación de la
 * póliza de depreciación); el número queda para el contador. `proceedsCents` null = baja sin venta.
 */
export async function disposeFixedAsset(
  venueId: string,
  assetId: string,
  input: { disposalDate: string; proceedsCents?: number | null },
  actorStaffId: string | null = null,
): Promise<DisposeResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) throw new BadRequestError('El local no tiene RFC/emisor fiscal configurado.')
  const asset = await prisma.fixedAsset.findFirst({ where: { id: assetId, organizationId: scope.organizationId, rfc: scope.rfc } })
  if (!asset) throw new NotFoundError('Activo fijo no encontrado.')
  if (asset.status === 'DISPOSED') throw new BadRequestError('El activo ya está dado de baja.')
  const proceeds = input.proceedsCents != null ? Math.round(input.proceedsCents) : null
  if (proceeds != null && proceeds < 0) throw new BadRequestError('El precio de venta no puede ser negativo.')
  const disposalDate = parseDay(input.disposalDate, 'baja')

  const agg = await prisma.fixedAssetDepreciation.aggregate({ where: { fixedAssetId: assetId }, _sum: { depreciationCents: true } })
  const accumulated = agg._sum.depreciationCents ?? 0
  const base = Math.max(0, cappedMoiCents(asset.moiCents, asset.assetType) - asset.salvageValueCents)
  const bookValue = Math.max(0, base - accumulated)
  const gainLoss = (proceeds ?? 0) - bookValue

  const updated = await prisma.fixedAsset.update({
    where: { id: assetId },
    data: { status: 'DISPOSED', disposalDate, disposalProceedsCents: proceeds },
  })
  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FIXED_ASSET_DISPOSED',
    entity: 'FixedAsset',
    entityId: assetId,
    data: { proceedsCents: proceeds, bookValueCents: bookValue, gainLossCents: gainLoss },
  })
  return { asset: toView(updated), accumulatedDepreciationCents: accumulated, bookValueCents: bookValue, proceedsCents: proceeds ?? 0, gainLossCents: gainLoss }
}
