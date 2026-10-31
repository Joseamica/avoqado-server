/**
 * An in-memory stand-in for the CRM tables the landing capture writes (plan task 5), installed on the global Prisma mock.
 *
 * It keeps OUTCOMES, so a test asserts «one account» instead of «createMany was called once»: the unique
 * (source, externalKey) and `organizationId` of accounts and the unique `sourceKey` of timeline events, all with the
 * `skipDuplicates` semantics (ON CONFLICT DO NOTHING) the services rely on. The interactive transaction of the global
 * mock runs the callback on the same mock, so a transaction sees what it wrote.
 */
import { Prisma } from '@prisma/client'

type Row = Record<string, any>

export const FAKE_STAGE_ID = 'cstageprs0000000000000001'
/** «Perdido»: a lost account stays lost when its person comes back (ruling 24). */
export const FAKE_LOST_STAGE_ID = 'cstageprd0000000000000001'
const STAGE_KINDS: Record<string, string> = { [FAKE_STAGE_ID]: 'ABIERTA', [FAKE_LOST_STAGE_ID]: 'PERDIDA' }

export function installCrmInboundFake(prismaMock: any) {
  const db = { entries: [] as Row[], accounts: [] as Row[], contacts: [] as Row[], events: [] as Row[] }
  let sequence = 0
  /** cuid v1 shape: 25 characters, starting with «c». */
  const nextId = (prefix: string) => `c${prefix}${String(++sequence).padStart(24 - prefix.length, '0')}`
  /** Prisma returns `null` for a JSON column written as `DbNull`; `{ increment }` adds to the number already there. */
  const patch = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment
      else row[key] = value === Prisma.DbNull || value === Prisma.JsonNull ? null : value
    }
  }
  /** An account with its stage's kind, as `select: { stage: { select: { kind } } }` returns it. */
  const withStage = (row: Row) => ({ ...row, archivedAt: row.archivedAt ?? null, stage: { kind: STAGE_KINDS[row.stageId] ?? 'ABIERTA' } })

  const delegates = [
    prismaMock.crmInboundEntry.create,
    prismaMock.crmInboundEntry.findUnique,
    prismaMock.crmInboundEntry.update,
    prismaMock.crmInboundEntry.updateMany,
    prismaMock.crmAccount.createMany,
    prismaMock.crmAccount.findUnique,
    prismaMock.crmAccount.findUniqueOrThrow,
    prismaMock.crmAccount.findMany,
    prismaMock.crmAccount.update,
    prismaMock.crmContact.create,
    prismaMock.crmContact.update,
    prismaMock.crmTimelineEvent.createMany,
    prismaMock.crmTimelineEvent.findUnique,
    prismaMock.staff.findUnique,
    prismaMock.crmTeam.findUnique,
    prismaMock.organization.findUnique,
    prismaMock.crmStage.count,
    prismaMock.crmStage.findFirst,
    prismaMock.crmLostReason.count,
  ]
  delegates.forEach(fn => fn.mockReset())

  prismaMock.crmInboundEntry.create.mockImplementation(async ({ data }: Row) => {
    const row = {
      id: nextId('entry'),
      receivedAt: new Date(),
      signupOutcome: null,
      signupResolvedAt: null,
      appliedAt: null,
      accountId: null,
      lastError: null,
      noticeSentAt: null,
      noticeAttempts: 0,
      ...data,
    }
    db.entries.push(row)
    return { id: row.id }
  })
  prismaMock.crmInboundEntry.findUnique.mockImplementation(
    async ({ where }: Row) => db.entries.find(entry => entry.id === where.id) ?? null,
  )
  prismaMock.crmInboundEntry.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.entries.find(entry => entry.id === where.id)
    if (!row) throw new Error('Record to update not found')
    patch(row, data)
    return { ...row }
  })
  prismaMock.crmInboundEntry.updateMany.mockImplementation(async ({ where, data }: Row) => {
    // `noticeSentAt: null` in the filter: a notice already marked sent is never counted again.
    const rows = db.entries.filter(entry => entry.id === where.id && (!('noticeSentAt' in where) || (entry.noticeSentAt ?? null) === null))
    rows.forEach(row => patch(row, data))
    return { count: rows.length }
  })

  prismaMock.crmAccount.createMany.mockImplementation(async ({ data: [row] }: Row) => {
    const clash = db.accounts.some(
      account =>
        (account.source === row.source && account.externalKey === row.externalKey) ||
        (row.organizationId && account.organizationId === row.organizationId),
    )
    if (clash) return { count: 0 }
    db.accounts.push({ id: nextId('acct'), organizationId: null, lastTouchAt: new Date(), createdAt: new Date(), ...row })
    return { count: 1 }
  })
  prismaMock.crmAccount.findUnique.mockImplementation(async ({ where }: Row) => {
    const key = where.source_externalKey
    const found = key
      ? db.accounts.find(account => account.source === key.source && account.externalKey === key.externalKey)
      : db.accounts.find(account => Object.entries(where).every(([field, value]) => account[field] === value))
    return found ? { ...found } : null
  })
  // With `select.contacts`, its people too (id, email, phone), oldest first.
  prismaMock.crmAccount.findUniqueOrThrow.mockImplementation(async ({ where, select }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)
    if (!row) throw new Error('No CrmAccount found')
    if (!select?.contacts) return withStage(row)
    const contacts = db.contacts
      .filter(contact => contact.accountId === row.id)
      .map(contact => ({ id: contact.id, email: contact.email ?? null, phoneE164: contact.phoneE164 ?? null }))
    return { ...withStage(row), contacts }
  })
  /**
   * The landing's lookup by person (ruling 48): accounts with a contact of that exact email or phone, newest touch first,
   * each with the contacts that matched by EMAIL (`select.contacts.where.email`). Any other `findMany` fails loudly.
   */
  prismaMock.crmAccount.findMany.mockImplementation(async ({ where, select, orderBy, take }: Row) => {
    const anyOf: Row[] = where?.contacts?.some?.OR
    if (!anyOf) throw new Error(`The CRM inbound fake does not know this crmAccount.findMany: ${JSON.stringify(where)}`)
    const hit = (contact: Row, clause: Row) => Object.entries(clause).every(([field, value]) => (contact[field] ?? null) === value)
    const byEmail = select?.contacts?.where?.email
    const found = db.accounts.filter(account =>
      db.contacts.some(contact => contact.accountId === account.id && anyOf.some(clause => hit(contact, clause))),
    )
    if (JSON.stringify(orderBy) !== JSON.stringify([{ lastTouchAt: 'desc' }, { id: 'desc' }])) throw new Error('Unexpected order')
    return found
      .sort((a, b) => (b.lastTouchAt?.getTime() ?? 0) - (a.lastTouchAt?.getTime() ?? 0) || (a.id < b.id ? 1 : -1))
      .slice(0, take)
      .map(account => ({
        ...withStage(account),
        lastTouchAt: account.lastTouchAt ?? null,
        contacts: db.contacts
          .filter(contact => contact.accountId === account.id && byEmail && contact.email === byEmail)
          .map(() => ({ id: 'c' })),
      }))
  })
  prismaMock.crmAccount.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)
    if (!row) throw new Error('Record to update not found')
    patch(row, data)
    return { ...row }
  })
  prismaMock.crmContact.create.mockImplementation(async ({ data }: Row) => {
    const id = nextId('cont')
    db.contacts.push({ id, ...data })
    return { id }
  })
  prismaMock.crmContact.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.contacts.find(contact => contact.id === where.id)
    if (!row) throw new Error('Record to update not found')
    Object.assign(row, data)
    return { ...row }
  })
  prismaMock.crmTimelineEvent.createMany.mockImplementation(async ({ data: [event] }: Row) => {
    if (event.sourceKey && db.events.some(existing => existing.sourceKey === event.sourceKey)) return { count: 0 }
    db.events.push(event)
    return { count: 1 }
  })
  prismaMock.crmTimelineEvent.findUnique.mockImplementation(
    async ({ where }: Row) => db.events.find(event => event.sourceKey === where.sourceKey) ?? null,
  )

  // Nobody with the entry's email owns an Organization, no sales-team organization, an Organization with a name, and
  // the pipeline already seeded.
  prismaMock.staff.findUnique.mockResolvedValue(null)
  prismaMock.crmTeam.findUnique.mockResolvedValue(null)
  prismaMock.organization.findUnique.mockResolvedValue({ name: 'Café Ana S.A.' })
  prismaMock.crmStage.count.mockResolvedValue(7)
  prismaMock.crmLostReason.count.mockResolvedValue(5)
  prismaMock.crmStage.findFirst.mockResolvedValue({ id: FAKE_STAGE_ID, name: 'Prospecto' })

  return db
}
