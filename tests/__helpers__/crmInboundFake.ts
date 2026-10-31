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

export function installCrmInboundFake(prismaMock: any) {
  const db = { entries: [] as Row[], accounts: [] as Row[], contacts: [] as Row[], events: [] as Row[] }
  let sequence = 0
  /** cuid v1 shape: 25 characters, starting with «c». */
  const nextId = (prefix: string) => `c${prefix}${String(++sequence).padStart(24 - prefix.length, '0')}`
  /** Prisma returns `null` for a JSON column written as `DbNull`. */
  const patch = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) row[key] = value === Prisma.DbNull || value === Prisma.JsonNull ? null : value
  }

  const delegates = [
    prismaMock.crmInboundEntry.create,
    prismaMock.crmInboundEntry.findUnique,
    prismaMock.crmInboundEntry.update,
    prismaMock.crmInboundEntry.updateMany,
    prismaMock.crmAccount.createMany,
    prismaMock.crmAccount.findUnique,
    prismaMock.crmAccount.update,
    prismaMock.crmContact.create,
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
    const rows = db.entries.filter(entry => entry.id === where.id)
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
    db.accounts.push({ id: nextId('acct'), organizationId: null, lastTouchAt: new Date(), ...row })
    return { count: 1 }
  })
  prismaMock.crmAccount.findUnique.mockImplementation(async ({ where }: Row) => {
    const key = where.source_externalKey
    const found = key
      ? db.accounts.find(account => account.source === key.source && account.externalKey === key.externalKey)
      : db.accounts.find(account => Object.entries(where).every(([field, value]) => account[field] === value))
    return found ? { ...found } : null
  })
  prismaMock.crmAccount.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)
    if (!row) throw new Error('Record to update not found')
    patch(row, data)
    return { ...row }
  })
  prismaMock.crmContact.create.mockImplementation(async ({ data }: Row) => {
    db.contacts.push(data)
    return { id: nextId('cont') }
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
