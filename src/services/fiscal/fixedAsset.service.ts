// src/services/fiscal/fixedAsset.service.ts
//
// Activos fijos (Capa B fiscal) — "deducción de inversiones" LISR art. 34-35. Slice 1: registro + listado.
// OPT-IN: el sistema solo SUGIERE por monto que una compra parece inversión; el usuario CONFIRMA aquí
// (registra el activo) antes de que algo se deprecie. La tasa default sale del catálogo por tipo, pero es
// EDITABLE (el founder eligió "oficiales por default, editables"). Depreciación en línea recta (slice 2).
// (org, rfc) = contribuyente, mismo scope que Expense/SalesRetention. Money en CENTAVOS enteros.

import { Prisma } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
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
