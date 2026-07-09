// src/services/fiscal/fixedAsset.service.ts
//
// Activos fijos (Capa B fiscal) — "deducción de inversiones" LISR art. 34-35. Slice 1: registro + listado.
// OPT-IN: el sistema solo SUGIERE por monto que una compra parece inversión; el usuario CONFIRMA aquí
// (registra el activo) antes de que algo se deprecie. La tasa default sale del catálogo por tipo, pero es
// EDITABLE (el founder eligió "oficiales por default, editables"). Depreciación en línea recta (slice 2).
// (org, rfc) = contribuyente, mismo scope que Expense/SalesRetention. Money en CENTAVOS enteros.

import { JournalEntrySource, JournalEntryType, Prisma } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { postJournalEntry } from './journalEntry.service'
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
  /** Factor de actualización INPC (art. 31 LISR) que capture el contador. null lo borra; omitido = sin cambio. */
  inpcFactor?: number | null
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
  /** Factor INPC capturado (null = costo histórico, factor 1). Solo afecta la DEDUCCIÓN fiscal, no el libro. */
  inpcFactor: number | null
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
  inpcFactor: Prisma.Decimal | null
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
    inpcFactor: a.inpcFactor != null ? Number(a.inpcFactor) : null,
    status: a.status,
    sourceExpenseId: a.sourceExpenseId,
    disposalDate: a.disposalDate ? a.disposalDate.toISOString().slice(0, 10) : null,
    disposalProceedsCents: a.disposalProceedsCents,
    createdAt: a.createdAt.toISOString(),
  }
}

// ── Pólizas de alta/baja del activo (Capa B, best-effort) ─────────────────────────────────────────
// Resolución POR CÓDIGO del catálogo base (no por mapping: la cuenta de activo depende del TIPO).
// Si el contribuyente aún no tiene las cuentas (catálogo sembrado antes de esta versión), la póliza se
// salta sin bloquear — re-sembrar el catálogo (insert-if-absent) agrega las cuentas nuevas.
const BANK_CODE = '102.01' // Bancos nacionales — contrapartida default de la compra (LISR exige pago electrónico para deducir)
const DEBTORS_CODE = '107.05' // Otros deudores diversos — el cobro de la venta del activo
const GAIN_CODE = '403.01' // Otros ingresos — ganancia por baja
const LOSS_CODE = '701.09' // Pérdida por baja de activos fijos
const ACUM_CODE = '171.09' // Depreciación acumulada del ejercicio
const acqKey = (assetId: string) => `fa-alta:${assetId}`
const disposalKey = (assetId: string) => `fa-baja:${assetId}`
const assetLeafCode = (assetType: string) => `${getAssetType(assetType)?.satAccountGroup ?? '153'}.09`

async function accountIdByCode(scope: { organizationId: string; rfc: string }, code: string): Promise<string | null> {
  const a = await prisma.ledgerAccount.findFirst({
    where: { organizationId: scope.organizationId, rfc: scope.rfc, code, isPostable: true, isActive: true },
    select: { id: true },
  })
  return a?.id ?? null
}

export interface LedgerPostResult {
  posted: boolean
  reason?: string
  journalEntryId?: string
}

/** Póliza de ALTA: DEBE Activo fijo ({grupo}.09, por tipo) / HABER Bancos, por el MOI. Idempotente. */
async function postAcquisitionEntry(
  venueId: string,
  scope: { organizationId: string; rfc: string },
  asset: { id: string; description: string; assetType: string; moiCents: number; acquisitionDate: Date; sourceExpenseId: string | null },
  staffId: string | null,
): Promise<LedgerPostResult> {
  try {
    // La compra ligada a un gasto YA movió dinero en la póliza del gasto — no duplicar la salida de banco.
    if (asset.sourceExpenseId) return { posted: false, reason: 'linkedExpense' }
    const [activo, banco] = await Promise.all([accountIdByCode(scope, assetLeafCode(asset.assetType)), accountIdByCode(scope, BANK_CODE)])
    if (!activo || !banco) return { posted: false, reason: 'missingAccounts' }
    const entry = await postJournalEntry(
      venueId,
      {
        date: asset.acquisitionDate.toISOString().slice(0, 10),
        type: JournalEntryType.DIARIO,
        source: JournalEntrySource.DEPRECIATION,
        idempotencyKey: acqKey(asset.id),
        concept: `Alta de activo fijo — ${asset.description}`,
        lines: [
          { ledgerAccountId: activo, debitCents: asset.moiCents, creditCents: 0 },
          { ledgerAccountId: banco, debitCents: 0, creditCents: asset.moiCents },
        ],
      },
      { staffId },
    )
    return { posted: true, journalEntryId: entry.id }
  } catch {
    return { posted: false, reason: 'error' }
  }
}

/**
 * Póliza de BAJA: DEBE Depreciación acumulada + DEBE Deudores (precio de venta) + pérdida/ganancia como
 * cuadre / HABER Activo fijo por el MOI. Solo si la póliza de ALTA existe (sin ella, abonar el activo
 * desbalancearía la cuenta). El cuadre contable usa el MOI (puede diferir de la ganancia/pérdida "fiscal"
 * cuando hay valor de rescate o tope de MOI). Idempotente.
 */
async function postDisposalEntry(
  venueId: string,
  scope: { organizationId: string; rfc: string },
  asset: { id: string; description: string; assetType: string; moiCents: number },
  accumulatedCents: number,
  proceedsCents: number,
  disposalDateStr: string,
  staffId: string | null,
): Promise<LedgerPostResult> {
  try {
    const alta = await prisma.journalEntry.findUnique({
      where: { organizationId_rfc_idempotencyKey: { organizationId: scope.organizationId, rfc: scope.rfc, idempotencyKey: acqKey(asset.id) } },
      select: { id: true },
    })
    if (!alta) return { posted: false, reason: 'noAcquisitionEntry' }

    const plug = asset.moiCents - accumulatedCents - proceedsCents // >0 pérdida · <0 ganancia · 0 sin resultado
    const activo = await accountIdByCode(scope, assetLeafCode(asset.assetType))
    const acum = accumulatedCents > 0 ? await accountIdByCode(scope, ACUM_CODE) : 'unused'
    const deudores = proceedsCents > 0 ? await accountIdByCode(scope, DEBTORS_CODE) : 'unused'
    const resultado = plug !== 0 ? await accountIdByCode(scope, plug > 0 ? LOSS_CODE : GAIN_CODE) : 'unused'
    if (!activo || !acum || !deudores || !resultado) return { posted: false, reason: 'missingAccounts' }

    const lines = [
      ...(accumulatedCents > 0 ? [{ ledgerAccountId: acum, debitCents: accumulatedCents, creditCents: 0 }] : []),
      ...(proceedsCents > 0 ? [{ ledgerAccountId: deudores, debitCents: proceedsCents, creditCents: 0 }] : []),
      ...(plug > 0 ? [{ ledgerAccountId: resultado, debitCents: plug, creditCents: 0 }] : []),
      { ledgerAccountId: activo, debitCents: 0, creditCents: asset.moiCents },
      ...(plug < 0 ? [{ ledgerAccountId: resultado, debitCents: 0, creditCents: -plug }] : []),
    ]
    const entry = await postJournalEntry(
      venueId,
      {
        date: disposalDateStr,
        type: JournalEntryType.DIARIO,
        source: JournalEntrySource.DEPRECIATION,
        idempotencyKey: disposalKey(asset.id),
        concept: `Baja de activo fijo — ${asset.description}`,
        lines,
      },
      { staffId },
    )
    return { posted: true, journalEntryId: entry.id }
  } catch {
    return { posted: false, reason: 'error' }
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
): Promise<FixedAssetView & { ledgerPosted: boolean; ledgerReason?: string }> {
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
  if (input.inpcFactor != null && (!Number.isFinite(input.inpcFactor) || input.inpcFactor <= 0 || input.inpcFactor > 10))
    throw new BadRequestError('El factor INPC debe ser mayor a 0 y razonable (≤ 10).')

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
      inpcFactor: input.inpcFactor != null ? new Prisma.Decimal(input.inpcFactor) : null,
      sourceExpenseId: input.sourceExpenseId ?? null,
      createdById: actorStaffId,
    },
  })

  // Póliza de ALTA al libro (best-effort — no bloquea el registro si faltan cuentas).
  const alta = await postAcquisitionEntry(venueId, scope, asset, actorStaffId)

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FIXED_ASSET_REGISTERED',
    entity: 'FixedAsset',
    entityId: asset.id,
    data: { assetType: asset.assetType, moiCents: asset.moiCents, annualRate: rate, ledgerPosted: alta.posted },
  })

  return { ...toView(asset), ledgerPosted: alta.posted, ...(alta.reason ? { ledgerReason: alta.reason } : {}) }
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
    if (!Number.isFinite(input.moiCents) || input.moiCents <= 0)
      throw new BadRequestError('El monto de la inversión (MOI) debe ser mayor a cero.')
    data.moiCents = Math.round(input.moiCents)
  }
  if (input.annualRate !== undefined) {
    if (!Number.isFinite(input.annualRate) || input.annualRate <= 0 || input.annualRate > 1)
      throw new BadRequestError('La tasa anual de depreciación debe estar entre 0 y 1 (ej. 0.30 = 30%).')
    data.annualRate = new Prisma.Decimal(input.annualRate)
  }
  if (input.salvageValueCents !== undefined) {
    if (!Number.isFinite(input.salvageValueCents) || input.salvageValueCents < 0)
      throw new BadRequestError('El valor de rescate no puede ser negativo.')
    data.salvageValueCents = Math.round(input.salvageValueCents)
  }
  if (input.inpcFactor !== undefined) {
    if (input.inpcFactor === null) data.inpcFactor = null
    else if (!Number.isFinite(input.inpcFactor) || input.inpcFactor <= 0 || input.inpcFactor > 10)
      throw new BadRequestError('El factor INPC debe ser mayor a 0 y razonable (≤ 10).')
    else data.inpcFactor = new Prisma.Decimal(input.inpcFactor)
  }
  if (input.acquisitionDate !== undefined) data.acquisitionDate = parseDay(input.acquisitionDate, 'adquisición')
  if (input.inServiceDate !== undefined) data.inServiceDate = parseDay(input.inServiceDate, 'inicio de uso')

  const updated = await prisma.fixedAsset.update({ where: { id: assetId }, data })
  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FIXED_ASSET_UPDATED',
    entity: 'FixedAsset',
    entityId: assetId,
    data: { fields: Object.keys(data) },
  })
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
  /** Si la póliza de baja se llevó al libro (requiere que exista la póliza de alta y las cuentas). */
  ledgerPosted: boolean
  ledgerReason?: string
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
  // Póliza de BAJA al libro (best-effort; solo si la ALTA existe — si no, se salta sin bloquear).
  const baja = await postDisposalEntry(venueId, scope, asset, accumulated, proceeds ?? 0, input.disposalDate, actorStaffId)

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FIXED_ASSET_DISPOSED',
    entity: 'FixedAsset',
    entityId: assetId,
    data: { proceedsCents: proceeds, bookValueCents: bookValue, gainLossCents: gainLoss, ledgerPosted: baja.posted },
  })
  return {
    asset: toView(updated),
    accumulatedDepreciationCents: accumulated,
    bookValueCents: bookValue,
    proceedsCents: proceeds ?? 0,
    gainLossCents: gainLoss,
    ledgerPosted: baja.posted,
    ...(baja.reason ? { ledgerReason: baja.reason } : {}),
  }
}
