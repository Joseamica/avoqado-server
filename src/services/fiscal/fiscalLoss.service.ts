// src/services/fiscal/fiscalLoss.service.ts
//
// Pérdida fiscal de ejercicios anteriores pendiente de amortizar (LISR art. 57/109), Capa B. Captura MANUAL
// del saldo por (org, rfc): sin él, el pago provisional de ISR (régimen general) queda inflado. El pago
// provisional puede aplicar la pérdida pendiente a la utilidad (topada). El detalle por ejercicio, la
// caducidad a 10 años y la actualización por INPC los mantiene el contador en la anual — aquí solo el saldo.

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'

export interface FiscalLoss {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  pendingCents: number
  note: string | null
  /** Si el contador ya capturó el saldo (aunque sea en ceros). */
  hasEntry: boolean
}

/** Saldo pendiente de pérdidas del contribuyente (lo usa el ISR general). 0 si no capturado. */
export async function getPendingLossCents(organizationId: string, rfc: string): Promise<number> {
  const row = await prisma.fiscalLossCarryforward.findUnique({
    where: { organizationId_rfc: { organizationId, rfc } },
    select: { pendingCents: true },
  })
  return row?.pendingCents ?? 0
}

/** Lectura por venue (API/MCP): resuelve el contribuyente y devuelve el saldo (o ceros si no hay). */
export async function getFiscalLoss(venueId: string): Promise<FiscalLoss> {
  const scope = await resolveScopeOrNull(venueId)
  const empty: FiscalLoss = {
    needsFiscalSetup: scope === null,
    organizationId: scope?.organizationId ?? null,
    rfc: scope?.rfc ?? null,
    pendingCents: 0,
    note: null,
    hasEntry: false,
  }
  if (!scope) return empty
  const row = await prisma.fiscalLossCarryforward.findUnique({
    where: { organizationId_rfc: { organizationId: scope.organizationId, rfc: scope.rfc } },
  })
  if (!row) return empty
  return { ...empty, pendingCents: row.pendingCents, note: row.note, hasEntry: true }
}

/** Alta/actualización del saldo de pérdidas pendientes de amortizar. Audita. */
export async function setFiscalLoss(
  venueId: string,
  input: { pendingCents?: number; note?: string | null },
  actorStaffId: string | null = null,
): Promise<FiscalLoss> {
  const pending = Math.round(input.pendingCents ?? 0)
  if (pending < 0) throw new BadRequestError('El saldo de pérdidas no puede ser negativo.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) throw new BadRequestError('El local no tiene RFC/emisor configurado.')

  const row = await prisma.fiscalLossCarryforward.upsert({
    where: { organizationId_rfc: { organizationId: scope.organizationId, rfc: scope.rfc } },
    create: { organizationId: scope.organizationId, rfc: scope.rfc, pendingCents: pending, note: input.note ?? null },
    update: { pendingCents: pending, note: input.note ?? null },
  })

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'FISCAL_LOSS_SET',
    entity: 'FiscalLossCarryforward',
    entityId: row.id,
    data: { pendingCents: pending },
  })

  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    pendingCents: row.pendingCents,
    note: row.note,
    hasEntry: true,
  }
}
