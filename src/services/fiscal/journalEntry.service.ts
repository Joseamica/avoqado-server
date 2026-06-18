import { JournalEntrySource, JournalEntryStatus, JournalEntryType, Prisma } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { resolveScopeOrNull, type CatalogScope } from './chartOfAccounts.service'

/**
 * Libro diario · Pólizas — motor de doble partida (Capa B).
 *
 * El primitivo `postJournalEntry` es el corazón: persiste una póliza SOLO si está BALANCEADA
 * (Σdebe == Σhaber, invariante duro), cada línea afecta una cuenta AFECTABLE del propio
 * contribuyente, y es idempotente por `idempotencyKey` (el motor automático no duplica al
 * reintentar). Money en CENTAVOS enteros, MXN. Scope = (org, rfc); venueId = centro de costos.
 * Gated PREMIUM (CFDI). Slice 1: pólizas MANUALES + lectura del diario. El posteo automático
 * desde pagos/CFDI (slice 2) reusará este mismo primitivo.
 */

export interface JournalLineInput {
  ledgerAccountId: string
  debitCents: number
  creditCents: number
  description?: string | null
}

export interface PostEntryInput {
  /** Fecha del asiento en formato 'YYYY-MM-DD'. */
  date: string
  type?: JournalEntryType
  source: JournalEntrySource
  sourceId?: string | null
  /** Clave de idempotencia (motor automático). Manual = undefined. */
  idempotencyKey?: string | null
  concept: string
  /** Centro de costos (local de origen). Informativo. */
  venueId?: string | null
  lines: JournalLineInput[]
}

export interface JournalLineDTO {
  id: string
  ledgerAccountId: string
  accountCode: string
  accountName: string
  debitCents: number
  creditCents: number
  description: string | null
}

export interface JournalEntryDTO {
  id: string
  date: string
  period: string
  folio: number
  type: JournalEntryType
  source: JournalEntrySource
  status: string
  concept: string
  totalDebitCents: number
  totalCreditCents: number
  lines: JournalLineDTO[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

async function requireScope(venueId: string): Promise<CatalogScope> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    throw new BadRequestError('Este local aún no tiene un RFC/emisor fiscal configurado. Configura la facturación (CFDI) primero.')
  }
  return scope
}

const isInt = (n: number) => Number.isInteger(n)

/** Si el error es P2002 (unique), devuelve los campos/constraint en colisión como string; si no, null. */
function uniqueViolationTarget(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const t = (e.meta as { target?: unknown } | undefined)?.target
    return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : ''
  }
  return null
}

/** P2034 = la transacción falló por conflicto de escritura / deadlock (serialización). */
function isSerializationFailure(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034'
}

/**
 * Valida las líneas de una póliza y devuelve los totales. Reglas:
 *  - ≥ 2 líneas; cada línea tiene EXACTAMENTE uno de debe/haber > 0 (el otro 0), entero ≥ 0.
 *  - Σdebe == Σhaber y > 0 (el invariante de la doble partida).
 */
function validateAndTotal(lines: JournalLineInput[]): { totalDebitCents: number; totalCreditCents: number } {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new BadRequestError('Una póliza necesita al menos dos líneas (un cargo y un abono).')
  }
  let totalDebit = 0
  let totalCredit = 0
  for (const [i, l] of lines.entries()) {
    const d = l.debitCents ?? 0
    const c = l.creditCents ?? 0
    if (!isInt(d) || !isInt(c) || d < 0 || c < 0) {
      throw new BadRequestError(`Línea ${i + 1}: los montos deben ser centavos enteros no negativos.`)
    }
    if (d > 0 === c > 0) {
      throw new BadRequestError(`Línea ${i + 1}: debe tener cargo O abono (uno mayor a cero, el otro en cero).`)
    }
    totalDebit += d
    totalCredit += c
  }
  if (totalDebit !== totalCredit) {
    throw new BadRequestError(`La póliza no cuadra: cargos ${totalDebit} ≠ abonos ${totalCredit} (centavos). Σdebe debe igualar Σhaber.`)
  }
  if (totalDebit === 0) {
    throw new BadRequestError('La póliza no puede ser por cero.')
  }
  return { totalDebitCents: totalDebit, totalCreditCents: totalCredit }
}

async function loadEntryDTO(entryId: string): Promise<JournalEntryDTO> {
  const e = await prisma.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: { include: { ledgerAccount: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' } } },
  })
  return {
    id: e.id,
    date: e.date.toISOString().slice(0, 10),
    period: e.period,
    folio: e.folio,
    type: e.type,
    source: e.source,
    status: e.status,
    concept: e.concept,
    totalDebitCents: e.totalDebitCents,
    totalCreditCents: e.totalCreditCents,
    lines: e.lines.map(l => ({
      id: l.id,
      ledgerAccountId: l.ledgerAccountId,
      accountCode: l.ledgerAccount.code,
      accountName: l.ledgerAccount.name,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description,
    })),
  }
}

/**
 * Primitivo de posteo. Postea UNA póliza balanceada de forma idempotente. Lanza si no cuadra,
 * si una cuenta no pertenece al contribuyente o no es afectable, o si la fecha es inválida.
 */
export async function postJournalEntry(
  venueId: string,
  input: PostEntryInput,
  actor: { staffId?: string | null },
): Promise<JournalEntryDTO> {
  const scope = await requireScope(venueId)

  if (!DATE_RE.test(input.date)) throw new BadRequestError('La fecha debe tener formato AAAA-MM-DD.')
  const date = new Date(`${input.date}T12:00:00.000Z`) // mediodía UTC: el día no se corre por zona horaria
  if (Number.isNaN(date.getTime())) throw new BadRequestError(`La fecha '${input.date}' no es válida.`)
  const period = input.date.slice(0, 7)
  if (!input.concept || !input.concept.trim()) throw new BadRequestError('El concepto de la póliza es requerido.')

  const { totalDebitCents, totalCreditCents } = validateAndTotal(input.lines)

  // Idempotencia: si ya existe una póliza con esta clave, devolverla (no duplicar).
  if (input.idempotencyKey) {
    const existing = await prisma.journalEntry.findUnique({
      where: {
        organizationId_rfc_idempotencyKey: { organizationId: scope.organizationId, rfc: scope.rfc, idempotencyKey: input.idempotencyKey },
      },
      select: { id: true },
    })
    if (existing) return loadEntryDTO(existing.id)
  }

  // Toda cuenta referenciada debe ser del contribuyente Y afectable (hoja) Y activa.
  const ids = [...new Set(input.lines.map(l => l.ledgerAccountId))]
  const accounts = await prisma.ledgerAccount.findMany({
    where: { id: { in: ids }, organizationId: scope.organizationId, rfc: scope.rfc },
    select: { id: true, isPostable: true, isActive: true },
  })
  const byId = new Map(accounts.map(a => [a.id, a]))
  for (const id of ids) {
    const a = byId.get(id)
    if (!a) throw new BadRequestError('Una de las cuentas no pertenece al catálogo de este contribuyente.')
    if (!a.isPostable) throw new BadRequestError('Solo puedes postear a cuentas afectables (hojas), no a cuentas acumulativas.')
    if (!a.isActive) throw new BadRequestError('No puedes postear a una cuenta inactiva.')
  }

  // Posteo bajo SERIALIZABLE + reintento. Garantiza:
  //  - folio consecutivo ÚNICO por contribuyente (hay @@unique([org,rfc,folio]) que lo blinda a nivel DB);
  //  - idempotencia a prueba de carreras: dos posteos con la misma clave CONVERGEN en una sola póliza.
  const MAX_RETRIES = 5
  let entryId: string | null = null
  let isNew = false
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await prisma.$transaction(
        async tx => {
          // Re-chequeo de idempotencia DENTRO de la tx (consistente bajo Serializable).
          if (input.idempotencyKey) {
            const ex = await tx.journalEntry.findUnique({
              where: {
                organizationId_rfc_idempotencyKey: {
                  organizationId: scope.organizationId,
                  rfc: scope.rfc,
                  idempotencyKey: input.idempotencyKey,
                },
              },
              select: { id: true },
            })
            if (ex) return { id: ex.id, isNew: false }
          }
          // Folio consecutivo por (org, rfc); si colisiona (carrera), el @@unique lanza P2002 y reintentamos.
          const max = await tx.journalEntry.aggregate({
            where: { organizationId: scope.organizationId, rfc: scope.rfc },
            _max: { folio: true },
          })
          const folio = (max._max.folio ?? 0) + 1
          const created = await tx.journalEntry.create({
            data: {
              organizationId: scope.organizationId,
              rfc: scope.rfc,
              venueId: input.venueId ?? venueId,
              date,
              period,
              folio,
              type: input.type ?? JournalEntryType.DIARIO,
              source: input.source,
              sourceId: input.sourceId ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              concept: input.concept.trim(),
              totalDebitCents,
              totalCreditCents,
              createdById: actor.staffId ?? null,
              lines: {
                create: input.lines.map(l => ({
                  ledgerAccountId: l.ledgerAccountId,
                  debitCents: l.debitCents ?? 0,
                  creditCents: l.creditCents ?? 0,
                  description: l.description?.trim() || null,
                })),
              },
            },
            select: { id: true },
          })
          return { id: created.id, isNew: true }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      entryId = r.id
      isNew = r.isNew
      break
    } catch (e) {
      const target = uniqueViolationTarget(e)
      // Carrera de idempotencia: otra tx ya insertó esta clave → devolvemos la suya (idempotente, no 500).
      if (target?.includes('idempotencyKey') && input.idempotencyKey) {
        const ex = await prisma.journalEntry.findUnique({
          where: {
            organizationId_rfc_idempotencyKey: {
              organizationId: scope.organizationId,
              rfc: scope.rfc,
              idempotencyKey: input.idempotencyKey,
            },
          },
          select: { id: true },
        })
        if (ex) {
          entryId = ex.id
          isNew = false
          break
        }
      }
      // Colisión de folio o fallo de serialización → reintentar (re-lee el max y recalcula).
      if ((target?.includes('folio') || isSerializationFailure(e)) && attempt < MAX_RETRIES) continue
      throw e
    }
  }

  if (isNew) {
    await logAction({
      staffId: actor.staffId ?? null,
      venueId,
      action: 'JOURNAL_ENTRY_POSTED',
      entity: 'JournalEntry',
      entityId: entryId!,
      data: {
        organizationId: scope.organizationId,
        rfc: scope.rfc,
        source: input.source,
        totalCents: totalDebitCents,
        lines: input.lines.length,
      },
    })
  }

  return loadEntryDTO(entryId!)
}

export interface ManualEntryInput {
  date: string
  concept: string
  lines: JournalLineInput[]
}

/** Crea una póliza MANUAL (source=MANUAL, tipo DIARIO). Reusa el primitivo. */
export function createManualEntry(venueId: string, input: ManualEntryInput, actor: { staffId?: string | null }): Promise<JournalEntryDTO> {
  return postJournalEntry(
    venueId,
    {
      date: input.date,
      concept: input.concept,
      source: JournalEntrySource.MANUAL,
      type: JournalEntryType.DIARIO,
      lines: input.lines,
      venueId,
    },
    actor,
  )
}

export interface ListFilters {
  /** YYYY-MM. */
  period?: string
  limit?: number
}

export interface JournalResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  entries: JournalEntryDTO[]
}

/** Libro diario: pólizas del contribuyente (más recientes primero), opcionalmente por periodo. */
export async function listEntries(venueId: string, filters: ListFilters = {}): Promise<JournalResult> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return { needsFiscalSetup: true, organizationId: null, rfc: null, entries: [] }

  const where: Prisma.JournalEntryWhereInput = { organizationId: scope.organizationId, rfc: scope.rfc }
  if (filters.period && /^\d{4}-\d{2}$/.test(filters.period)) where.period = filters.period

  const rows = await prisma.journalEntry.findMany({
    where,
    include: { lines: { include: { ledgerAccount: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' } } },
    orderBy: [{ date: 'desc' }, { folio: 'desc' }],
    take: Math.min(filters.limit ?? 100, 500),
  })

  const entries: JournalEntryDTO[] = rows.map(e => ({
    id: e.id,
    date: e.date.toISOString().slice(0, 10),
    period: e.period,
    folio: e.folio,
    type: e.type,
    source: e.source,
    status: e.status,
    concept: e.concept,
    totalDebitCents: e.totalDebitCents,
    totalCreditCents: e.totalCreditCents,
    lines: e.lines.map(l => ({
      id: l.id,
      ledgerAccountId: l.ledgerAccountId,
      accountCode: l.ledgerAccount.code,
      accountName: l.ledgerAccount.name,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description,
    })),
  }))

  return { needsFiscalSetup: false, organizationId: scope.organizationId, rfc: scope.rfc, entries }
}

/**
 * TODAS las pólizas POSTED de un periodo en orden CRONOLÓGICO (fecha/folio asc) — para la
 * contabilidad electrónica (PLZ del Anexo 24). Sin el tope de 500 de `listEntries` y solo POSTED,
 * para que el conjunto coincida exactamente con la balanza. Devuelve [] si el local no tiene RFC.
 */
export async function listPeriodEntries(venueId: string, period: string): Promise<JournalEntryDTO[]> {
  const scope = await resolveScopeOrNull(venueId)
  if (!scope || !/^\d{4}-\d{2}$/.test(period)) return []

  const rows = await prisma.journalEntry.findMany({
    where: { organizationId: scope.organizationId, rfc: scope.rfc, status: JournalEntryStatus.POSTED, period },
    include: { lines: { include: { ledgerAccount: { select: { code: true, name: true } } }, orderBy: { createdAt: 'asc' } } },
    orderBy: [{ date: 'asc' }, { folio: 'asc' }],
  })

  return rows.map(e => ({
    id: e.id,
    date: e.date.toISOString().slice(0, 10),
    period: e.period,
    folio: e.folio,
    type: e.type,
    source: e.source,
    status: e.status,
    concept: e.concept,
    totalDebitCents: e.totalDebitCents,
    totalCreditCents: e.totalCreditCents,
    lines: e.lines.map(l => ({
      id: l.id,
      ledgerAccountId: l.ledgerAccountId,
      accountCode: l.ledgerAccount.code,
      accountName: l.ledgerAccount.name,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      description: l.description,
    })),
  }))
}
