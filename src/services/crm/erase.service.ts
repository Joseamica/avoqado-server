/**
 * «Eliminar» a CRM account (D7, founder 2-nov: «al instante, pero solo superadmin, o sea yo») and the tombstone that keeps
 * it from coming back by itself. «Archivar» stays the reversible step; this one is forever.
 *
 * 🔴 The tombstone (`CrmErased`) is what makes «forever» true. The four writers that create accounts on their own — a
 * landing entry, the sweep's backfill of old signups (it re-reads every signup after each restart), the WhatsApp routine
 * (it re-reads 4 days of chats) and the HubSpot import — all go through `accountForTx`, which asks `assertNotErasedTx`
 * right before creating. What was said BEFORE the account was deleted never creates it again; what the person says AFTER
 * (a new form, a new message) does. A person creating it by hand is never stopped.
 *
 * The tombstone keeps `sha256("<KIND>:<value>")`, never the value: the person's email or phone is not kept to remember
 * that it was deleted. Promesa y Codex: Avoqado/docs/audit/2026-11-02-crm-eliminar-prospecto/.
 */
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { ForbiddenError, NotFoundError, ValidationError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import type { CrmAccess } from './access.service'

/** More people than any account has; past it the deletion refuses instead of leaving some of them out of the tombstone. */
const CONTACTS_CAP = 2000

type ErasedKind = 'KEY' | 'ORG' | 'EMAIL' | 'PHONE'
const hashOf = (kind: ErasedKind, value: string) => crypto.createHash('sha256').update(`${kind}:${value}`).digest('hex')
const normalEmail = (email: string) => email.trim().toLowerCase()

/** Who a writer is about to create, in the same terms as the resolver's `Identity`. */
export interface ErasedIdentity {
  keys: Array<{ source: string; externalKey: string }>
  emails: string[]
  phones: string[]
  organizationId: string | null
}

/** The tombstone hashes of an identity: its Organization apart, because it always stops a writer. */
export function erasedHashes(who: ErasedIdentity): { organization: string | null; person: string[] } {
  const person = [
    ...who.keys.map(key => hashOf('KEY', `${key.source}:${key.externalKey}`)),
    ...who.emails.filter(Boolean).map(email => hashOf('EMAIL', normalEmail(email))),
    ...who.phones.filter(Boolean).map(phone => hashOf('PHONE', phone)),
  ]
  return { organization: who.organizationId ? hashOf('ORG', who.organizationId) : null, person: [...new Set(person)] }
}

/** The person was deleted from the CRM, and what the writer read is from before: nothing is created. */
export class ErasedIdentityError extends Error {
  constructor(readonly erasedAt: Date) {
    super(`This person's CRM account was deleted on ${erasedAt.toISOString()}; nothing said before that creates it again`)
    this.name = 'ErasedIdentityError'
  }
}

/**
 * Throws `ErasedIdentityError` when this identity belongs to a deleted account and what the writer read was said at or
 * before the deletion — or when it cannot tell when (`seenAt` undefined: a HubSpot file, a chat without its date, an old
 * signup). Its Organization always counts; its key, email or phone only with a tombstone compatible with it — without an
 * Organization, or the same — the resolver's rule (`candidateTx`): another business that shares a phone is not this
 * person. Called by `accountForTx` only when it found nobody and is about to create, inside the writer's transaction.
 */
export async function assertNotErasedTx(tx: Prisma.TransactionClient, who: ErasedIdentity, seenAt?: Date): Promise<void> {
  const { organization, person } = erasedHashes(who)
  const scoped = who.organizationId ? { scope: { in: ['', who.organizationId] } } : {}
  const which: Prisma.CrmErasedWhereInput[] = [
    ...(organization ? [{ keyHash: organization }] : []),
    ...(person.length ? [{ keyHash: { in: person }, ...scoped }] : []),
  ]
  if (!which.length) return
  const hit = await tx.crmErased.findFirst({
    where: { OR: which, ...(seenAt ? { erasedAt: { gte: seenAt } } : {}) },
    select: { erasedAt: true },
    orderBy: { erasedAt: 'desc' },
  })
  if (hit) throw new ErasedIdentityError(hit.erasedAt)
}

/** «Ana  López» and «ana lópez» are the same name; an accent is not. */
export const sameName = (typed: string, name: string) => {
  const clean = (value: string) => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-MX')
  return clean(typed) === clean(name)
}

/**
 * Deletes an account for good: its people, activities and timeline go with it (cascade), and its landing entries too.
 * Only the real superadmin (founder, 2-nov), who types its name. The account's row lock first — the one the resolver
 * takes — so a writer that found it waits, finds it gone, resolves again and meets the tombstone; and its keys are read
 * after the lock, so whatever a writer added before is in the tombstone too. Deleting it again after somebody created it
 * by hand renews the tombstone. The ActivityLog, in the same transaction, says who and when, never the person's name,
 * email or phone.
 */
export async function deleteAccount(access: CrmAccess, id: string, confirmName: string) {
  if (!access.isSuperadmin) throw new ForbiddenError('Sólo el superadmin puede eliminar un negocio del CRM', 'CRM_SOLO_SUPERADMIN')
  await prisma.$transaction(async tx => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CrmAccount" WHERE "id" = ${id} FOR UPDATE`
    if (!locked) throw new NotFoundError('Ese negocio ya no está en el CRM', 'CRM_NEGOCIO_NO_EXISTE')
    // After the lock: a deletion that waited for it never stamps an earlier moment than one that went first.
    const now = new Date()
    const account = await tx.crmAccount.findUniqueOrThrow({
      where: { id },
      select: {
        name: true,
        source: true,
        externalKey: true,
        organizationId: true,
        stage: { select: { kind: true } },
        _count: { select: { activities: true, timelineEvents: true } },
      },
    })
    if (!sameName(confirmName, account.name)) {
      throw new ValidationError('Escribe el nombre del negocio tal como aparece para eliminarlo', 'CRM_CONFIRMA_EL_NOMBRE')
    }
    const contacts = await tx.crmContact.findMany({
      where: { accountId: id },
      select: { email: true, phoneE164: true },
      take: CONTACTS_CAP + 1,
    })
    if (contacts.length > CONTACTS_CAP)
      throw new ValidationError('Este negocio tiene demasiados contactos para eliminarlo de una vez', 'CRM_DEMASIADOS_CONTACTOS')
    const { organization, person } = erasedHashes({
      keys: account.externalKey ? [{ source: account.source, externalKey: account.externalKey }] : [],
      emails: contacts.flatMap(contact => (contact.email ? [contact.email] : [])),
      phones: contacts.flatMap(contact => (contact.phoneE164 ? [contact.phoneE164] : [])),
      organizationId: account.organizationId,
    })
    const hashes = organization ? [organization, ...person] : person
    const scope = account.organizationId ?? ''
    // A key already in the tombstone (deleted before, created again by hand, or shared with another deleted business)
    // counts from now — never back: only an earlier date moves (Codex r2 H1).
    await tx.crmErased.createMany({ data: hashes.map(keyHash => ({ keyHash, scope, erasedAt: now })), skipDuplicates: true })
    await tx.crmErased.updateMany({ where: { keyHash: { in: hashes }, scope, erasedAt: { lt: now } }, data: { erasedAt: now } })
    await tx.crmInboundEntry.deleteMany({ where: { accountId: id } })
    await tx.crmAccount.delete({ where: { id } })
    // In the same transaction, not `logAction` (best effort, outside it): an account is never gone without who deleted it
    // (Codex r1 H8). Its counts and kind, never its name, email or phone.
    await tx.activityLog.create({
      data: {
        staffId: access.staffId,
        venueId: null,
        action: 'CRM_ACCOUNT_DELETED',
        entity: 'CrmAccount',
        entityId: id,
        data: {
          source: account.source,
          stageKind: account.stage.kind,
          organizationLinked: account.organizationId !== null,
          contactos: contacts.length,
          actividades: account._count.activities,
          eventos: account._count.timelineEvents,
        },
      },
    })
  })
  return { id, eliminado: true }
}
