/**
 * An account's timeline (spec 2026-10-30 §5.2): who did what and when. It is only ever appended to — nothing edits or
 * deletes an event — and it is the CRM's own audit trail.
 */
import { Prisma } from '@prisma/client'

export const TIMELINE_KINDS = [
  'NOTE',
  'STAGE_CHANGE',
  'OWNER_CHANGE',
  'FIELD_CHANGE',
  'ACTIVITY_DONE',
  'LINKED',
  'WON',
  'LOST',
  'ARCHIVED',
  'REACTIVATED',
  'ENTRY_APPLIED',
  'SYSTEM',
  // «✋ a mano» en Usa (C1): `data`: `{ valor: AMBOS|TERMINAL|POS|null, porque?: string }`; null = «Leerlo solo».
  'USA_CHANGE',
  // «¿Por qué se quedó?» (C1): `data`: `{ motivo: MotivoDelAlta|null, texto?: string, perdido: boolean }`.
  'ALTA_MOTIVO',
  // Correo uno a uno (fase 2): `data` sólo lleva ids; el asunto, el extracto y el estado se leen de `CrmEmailMessage`.
  'EMAIL_SENT',
  'EMAIL_RECEIVED',
  // Ficha editable (C2). Nunca datos de personas: el nombre de la persona se lee en vivo al pintar la Historia.
  // `data`: `{ campo, de?, a? }`, uno por campo; sin valores para name y referidoPor (pueden ser nombres de personas).
  'ACCOUNT_EDIT',
  // `data`: `{ contactId, principal, casilla, consentimiento }`; `sourceKey` `contacto:<cuenta>:<llave UUID>`.
  'CONTACT_ADDED',
  // `data`: `{ contactId, campos[], consentimiento? }`.
  'CONTACT_EDITED',
  // `data`: `{ contactId, eraPrincipal }`.
  'CONTACT_REMOVED',
] as const

export type TimelineKind = (typeof TIMELINE_KINDS)[number]

export interface TimelineEventInput {
  accountId: string
  kind: TimelineKind
  /** null = the system. */
  actorStaffId: string | null
  data: Prisma.InputJsonObject
  /** Writers that may run twice for the same fact (a sweep, a retried entry) pass one, and the second write adds nothing. */
  sourceKey?: string
}

/**
 * Appends one event inside the caller's transaction. Returns false when an event with the same `sourceKey` already
 * exists. `ON CONFLICT DO NOTHING` instead of catching P2002: a unique violation aborts the whole Postgres transaction,
 * and with it the change the event describes.
 */
export async function addEvent(tx: Prisma.TransactionClient, event: TimelineEventInput): Promise<boolean> {
  const { count } = await tx.crmTimelineEvent.createMany({ data: [event], skipDuplicates: true })
  return count === 1
}
