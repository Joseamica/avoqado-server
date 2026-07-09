// src/services/fiscal/cogs.service.ts
//
// Costo de ventas (COGS) → póliza contable. El contador pidió que el sistema "empiece a registrar el
// costo de ventas": sin él, el estado de resultados muestra INGRESOS, no utilidad bruta.
//
// Modelo v1: UNA póliza agregada por (contribuyente, periodo) que traspasa el costo del inventario
// consumido a la cuenta de costo de ventas:  DEBE Costo de ventas (501.01) · HABER Inventario (115.01).
// El costo sale de los movimientos de inventario que YA registran el costo real (FIFO):
//   · Recetas       → `RawMaterialMovement type=USAGE`  (costImpact NEGATIVO al deducir → se niega).
//   · Productos QTY → `InventoryMovement  type=SALE`     (|quantity| × unitCost).
// Se excluyen SPOILAGE / ADJUSTMENT / mermas (no son costo de VENTA).
//
// Limitación conocida: es agregado por consumo físico, no ligado al alcance fiscal por pago (efectivo/
// merchant excluido). El inventario salió de todas formas, así que la cuenta de inventario queda exacta.
// Idempotente por periodo: conviene generarlo al cierre para que refleje todo el mes.

import prisma from '../../utils/prismaClient'
import { JournalEntrySource, JournalEntryType } from '@prisma/client'
import { postJournalEntry } from './journalEntry.service'
import { getMappings } from './accountMapping.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { parseDbDateRange } from '../../utils/datetime'

const DEFAULT_TZ = 'America/Mexico_City'
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface CogsResult {
  posted: boolean
  cogsCents: number
  /** Motivo si NO se posteó: needsFiscalSetup | missingMappings | noCogs | alreadyPosted. */
  reason?: string
}

/**
 * Costo de ventas del periodo, en centavos enteros. Suma el costo del inventario consumido por ventas:
 * recetas (USAGE, costImpact negativo → negado) + productos QUANTITY (SALE, |qty| × unitCost).
 */
export async function computePeriodCogsCents(venueId: string, from: Date, to: Date): Promise<number> {
  const [rm, inv] = await Promise.all([
    prisma.rawMaterialMovement.aggregate({
      where: { venueId, type: 'USAGE', createdAt: { gte: from, lte: to } },
      _sum: { costImpact: true },
    }),
    prisma.inventoryMovement.findMany({
      where: { type: 'SALE', createdAt: { gte: from, lte: to }, inventory: { venueId } },
      select: { quantity: true, unitCost: true },
    }),
  ])
  // costImpact de USAGE es negativo (salida) → lo negamos para obtener el costo positivo.
  const recipeCents = Math.round(-Number(rm._sum.costImpact ?? 0) * 100)
  const quantityCents = inv.reduce((s, m) => s + Math.round(Math.abs(Number(m.quantity)) * Number(m.unitCost ?? 0) * 100), 0)
  return Math.max(0, recipeCents + quantityCents)
}

/**
 * COGS del periodo para un rango en formato STRING (YYYY-MM-DD), parseado en la zona horaria del local
 * (tz-safe — evita el trap de `new Date('YYYY-MM-DD')` que resuelve a medianoche del host, no del local).
 * Envuelve a `computePeriodCogsCents`. Devuelve 0 si el local no existe. Lo usa el ISR general para restar
 * el costo de ventas acumulado del ejercicio a la utilidad fiscal estimada.
 */
export async function computePeriodCogsCentsRange(venueId: string, fromStr: string, toStr: string): Promise<number> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) return 0
  const tz = venue.timezone || DEFAULT_TZ
  const { from, to } = parseDbDateRange(fromStr, toStr, tz)
  return computePeriodCogsCents(venueId, from, to)
}

/**
 * Genera (idempotente) la póliza de costo de ventas del periodo. Best-effort: si falta el mapeo de
 * `COST_OF_GOODS_SOLD` o `INVENTORY`, o si no hubo consumo, no postea y lo reporta (no bloquea al resto).
 */
export async function generateCogsPolicyForVenue(venueId: string, period: string, actorStaffId: string | null = null): Promise<CogsResult> {
  if (!PERIOD_RE.test(period)) throw new Error('Periodo inválido (AAAA-MM)')
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { posted: false, cogsCents: 0, reason: 'needsFiscalSetup' }

  const mapResult = await getMappings(venueId)
  const byMovement = new Map<string, string>()
  for (const m of mapResult.mappings) if (m.account) byMovement.set(m.movementType, m.account.id)
  const cogsAcct = byMovement.get('COST_OF_GOODS_SOLD')
  const invAcct = byMovement.get('INVENTORY')
  if (!cogsAcct || !invAcct) return { posted: false, cogsCents: 0, reason: 'missingMappings' }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const tz = venue?.timezone || DEFAULT_TZ
  const [y, m] = period.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const toStr = `${period}-${String(lastDay).padStart(2, '0')}`
  const { from, to } = parseDbDateRange(`${period}-01`, toStr, tz)

  const totalCogsCents = await computePeriodCogsCents(venueId, from, to)
  if (totalCogsCents <= 0) return { posted: false, cogsCents: 0, reason: 'noCogs' }

  // Clave por TARGET acumulado del periodo: si ya se posteó COGS hasta este total exacto, no re-postea
  // (idempotente). Si el consumo del mes CRECIÓ desde la última generación, la clave es nueva y se postea
  // solo el DELTA — así el COGS no se "congela" al generarlo a mitad de mes.
  const idempotencyKey = `cogs:${venueId}:${period}:t${totalCogsCents}`
  const already = await prisma.journalEntry.findUnique({
    where: { organizationId_rfc_idempotencyKey: { organizationId: scope.organizationId, rfc: scope.rfc, idempotencyKey } },
    select: { id: true },
  })
  if (already) return { posted: false, cogsCents: totalCogsCents, reason: 'upToDate' }

  // COGS ya posteado del periodo (neto de reversas): cargos − abonos en la cuenta de costo de ventas
  // de las pólizas COGS de este periodo. El delta es lo que falta por reconocer.
  const prior = await prisma.journalLine.aggregate({
    where: {
      ledgerAccountId: cogsAcct,
      journalEntry: { source: JournalEntrySource.COGS, period, organizationId: scope.organizationId, rfc: scope.rfc },
    },
    _sum: { debitCents: true, creditCents: true },
  })
  const priorCents = (prior._sum.debitCents ?? 0) - (prior._sum.creditCents ?? 0)
  const deltaCents = totalCogsCents - priorCents
  // deltaCents === 0 no debería ocurrir (el mismo total ya tendría su clave), pero es seguro; < 0 (el
  // consumo bajó por una reversa rara) se deja al ajuste manual del contador — no revertimos automático.
  if (deltaCents <= 0) return { posted: false, cogsCents: totalCogsCents, reason: deltaCents === 0 ? 'upToDate' : 'cogsDecreased' }

  await postJournalEntry(
    venueId,
    {
      date: toStr, // último día del periodo
      type: JournalEntryType.DIARIO,
      source: JournalEntrySource.COGS,
      idempotencyKey,
      concept: `Costo de ventas ${period}`,
      lines: [
        { ledgerAccountId: cogsAcct, debitCents: deltaCents, creditCents: 0 },
        { ledgerAccountId: invAcct, debitCents: 0, creditCents: deltaCents },
      ],
    },
    { staffId: actorStaffId },
  )
  return { posted: true, cogsCents: totalCogsCents }
}
