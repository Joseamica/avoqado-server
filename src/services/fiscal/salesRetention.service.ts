// src/services/fiscal/salesRetention.service.ts
//
// Retención en VENTAS que los clientes (personas morales) le retienen al contribuyente. En un POS casi
// todo es venta a consumidor final (sin retención), pero un contribuyente RESICO que factura a morales
// SÍ recibe retención de ISR (1.25%) — sin capturarla, la declaración de IVA en flujo y el pago
// provisional de ISR quedan INFLADOS. Captura MANUAL por (org, rfc, periodo): el contador anota el mes.

import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export interface SalesRetention {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  isrRetenidoCents: number
  ivaRetenidoCents: number
  note: string | null
  /** Si el contador ya capturó el renglón del periodo (aunque sea en ceros). */
  hasEntry: boolean
}

/**
 * Lectura directa por contribuyente (la usan ivaFlujo/isr, que ya resolvieron el scope). Devuelve null
 * si el contador NO ha capturado el periodo → los cálculos lo tratan como "desconocido" (no restan),
 * para no asumir 0 en silencio.
 */
export async function getSalesRetentionCents(
  organizationId: string,
  rfc: string,
  period: string,
): Promise<{ isrRetenidoCents: number; ivaRetenidoCents: number } | null> {
  const row = await prisma.salesRetention.findUnique({
    where: { organizationId_rfc_period: { organizationId, rfc, period } },
    select: { isrRetenidoCents: true, ivaRetenidoCents: true },
  })
  return row
}

/** Lectura por venue (API/MCP): resuelve el contribuyente y devuelve el renglón (o ceros si no hay). */
export async function getSalesRetention(venueId: string, period: string): Promise<SalesRetention> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const scope = await resolveScopeOrNull(venueId)
  const empty: SalesRetention = {
    needsFiscalSetup: scope === null,
    organizationId: scope?.organizationId ?? null,
    rfc: scope?.rfc ?? null,
    period,
    isrRetenidoCents: 0,
    ivaRetenidoCents: 0,
    note: null,
    hasEntry: false,
  }
  if (!scope) return empty
  const row = await prisma.salesRetention.findUnique({
    where: { organizationId_rfc_period: { organizationId: scope.organizationId, rfc: scope.rfc, period } },
  })
  if (!row) return empty
  return {
    ...empty,
    isrRetenidoCents: row.isrRetenidoCents,
    ivaRetenidoCents: row.ivaRetenidoCents,
    note: row.note,
    hasEntry: true,
  }
}

/** Alta/actualización (upsert) del renglón de retención en ventas del periodo. Audita. */
export async function setSalesRetention(
  venueId: string,
  period: string,
  input: { isrRetenidoCents?: number; ivaRetenidoCents?: number; note?: string | null },
  actorStaffId: string | null = null,
): Promise<SalesRetention> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')
  const isr = Math.round(input.isrRetenidoCents ?? 0)
  const iva = Math.round(input.ivaRetenidoCents ?? 0)
  if (isr < 0 || iva < 0) throw new BadRequestError('Los montos de retención no pueden ser negativos.')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) throw new BadRequestError('El local no tiene RFC/emisor configurado.')

  const row = await prisma.salesRetention.upsert({
    where: { organizationId_rfc_period: { organizationId: scope.organizationId, rfc: scope.rfc, period } },
    create: { organizationId: scope.organizationId, rfc: scope.rfc, period, isrRetenidoCents: isr, ivaRetenidoCents: iva, note: input.note ?? null },
    update: { isrRetenidoCents: isr, ivaRetenidoCents: iva, note: input.note ?? null },
  })

  void logAction({
    staffId: actorStaffId,
    venueId,
    action: 'SALES_RETENTION_SET',
    entity: 'SalesRetention',
    entityId: row.id,
    data: { period, isrRetenidoCents: isr, ivaRetenidoCents: iva },
  })

  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    isrRetenidoCents: row.isrRetenidoCents,
    ivaRetenidoCents: row.ivaRetenidoCents,
    note: row.note,
    hasEntry: true,
  }
}
