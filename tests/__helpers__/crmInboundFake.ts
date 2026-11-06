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
  const db = {
    entries: [] as Row[],
    accounts: [] as Row[],
    contacts: [] as Row[],
    events: [] as Row[],
    consents: [] as Row[],
    erased: [] as Row[],
    logs: [] as Row[],
  }
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
  /** A scalar filter as Postgres reads it: equality, `null` = IS NULL, and `in`. */
  const fieldMatches = (value: unknown, filter: unknown): boolean => {
    if (filter === null) return (value ?? null) === null
    if (filter && typeof filter === 'object' && !(filter instanceof Date)) {
      const operators = filter as Row
      if ('in' in operators) return operators.in.includes(value)
      if ('gte' in operators) return value instanceof Date && value >= operators.gte
      if ('lt' in operators) return value instanceof Date && value < operators.lt
      throw new Error(`The CRM inbound fake does not know the filter ${JSON.stringify(filter)}`)
    }
    return value === filter
  }
  const contactMatches = (contact: Row, where: Row): boolean =>
    Object.entries(where).every(([field, filter]) => fieldMatches(contact[field] ?? null, filter))
  /** An account filter: its fields, `OR`, `AND`, `contacts.some` and its stage's kind. */
  const accountMatches = (account: Row, where: Row): boolean =>
    Object.entries(where).every(([field, filter]) => {
      if (field === 'OR') return (filter as Row[]).some(branch => accountMatches(account, branch))
      if (field === 'AND') return (filter as Row[]).every(branch => accountMatches(account, branch))
      if (field === 'contacts') return db.contacts.some(contact => contact.accountId === account.id && contactMatches(contact, filter.some))
      if (field === 'stage') return (STAGE_KINDS[account.stageId] ?? 'ABIERTA') === filter.kind
      return fieldMatches(account[field] ?? null, filter)
    })
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
    prismaMock.crmAccount.findFirst,
    prismaMock.crmAccount.update,
    prismaMock.crmContact.create,
    prismaMock.crmContact.update,
    prismaMock.crmContact.findFirst,
    prismaMock.crmTimelineEvent.createMany,
    prismaMock.crmTimelineEvent.findUnique,
    prismaMock.crmEmailConsent.upsert,
    prismaMock.crmEmailConsent.createMany,
    prismaMock.crmEmailConsent.findUnique,
    prismaMock.crmAccount.delete,
    prismaMock.crmContact.findMany,
    prismaMock.crmInboundEntry.deleteMany,
    prismaMock.crmErased.createMany,
    prismaMock.crmErased.updateMany,
    prismaMock.crmErased.findFirst,
    prismaMock.crmErased.findMany,
    prismaMock.activityLog.create,
    prismaMock.staff.findUnique,
    prismaMock.crmTeam.findUnique,
    prismaMock.organization.findUnique,
    prismaMock.crmStage.count,
    prismaMock.crmStage.findFirst,
    prismaMock.crmLostReason.count,
    prismaMock.$queryRaw,
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
  // With `select.contacts`, its people too (id, email, phone), oldest first — only as many as it asks for.
  prismaMock.crmAccount.findUniqueOrThrow.mockImplementation(async ({ where, select }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)
    if (!row) throw new Error('No CrmAccount found')
    if (select?._count) {
      const counts = {
        contacts: db.contacts.filter(contact => contact.accountId === row.id).length,
        activities: 0,
        timelineEvents: db.events.filter(event => event.accountId === row.id).length,
      }
      return { ...withStage(row), _count: counts }
    }
    if (!select?.contacts) return withStage(row)
    const contacts = db.contacts
      .filter(contact => contact.accountId === row.id)
      .slice(0, select.contacts.take ?? Infinity)
      .map(contact => ({ id: contact.id, email: contact.email ?? null, phoneE164: contact.phoneE164 ?? null }))
    return { ...withStage(row), contacts }
  })
  /**
   * The resolver's lookup by person (rulings 48 and 65): the first account matching the filter it builds — a contact with
   * one of these emails or phones, compatible with an Organization (`OR`), open or not — in its order, newest touch then
   * id. A filter this fake does not know fails loudly instead of passing.
   */
  prismaMock.crmAccount.findFirst.mockImplementation(async ({ where, orderBy }: Row) => {
    if (JSON.stringify(orderBy) !== JSON.stringify([{ lastTouchAt: 'desc' }, { id: 'desc' }])) throw new Error('Unexpected order')
    const found = db.accounts
      .filter(account => accountMatches(account, where))
      .sort((a, b) => (b.lastTouchAt?.getTime() ?? 0) - (a.lastTouchAt?.getTime() ?? 0) || (a.id < b.id ? 1 : -1))[0]
    return found ? { id: found.id } : null
  })
  // An entry's own lock, and an account's row lock with what it holds now (what the resolver checks again under it).
  prismaMock.$queryRaw.mockImplementation(async (first: TemplateStringsArray | { sql: string }, ...values: unknown[]) => {
    const sql = Array.isArray(first) ? first.join('?') : (first as { sql: string }).sql
    if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }]
    if (!sql.includes('"CrmAccount"') || !sql.includes('FOR UPDATE')) throw new Error(`The CRM inbound fake does not know: ${sql}`)
    const account = db.accounts.find(row => row.id === values[0])
    return account ? [{ id: account.id, organizationId: account.organizationId ?? null }] : []
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
  /** The first person of an account matching exact values — `null` meaning «has none» — oldest first, as Postgres does. */
  prismaMock.crmContact.findFirst.mockImplementation(async ({ where }: Row) => {
    const found = db.contacts.find(contact => Object.entries(where).every(([field, value]) => (contact[field] ?? null) === value))
    return found ? { id: found.id } : null
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

  // The landing's consent box: one row per email (unique), created or brought up to date — never deleted.
  prismaMock.crmEmailConsent.upsert.mockImplementation(async ({ where, create, update }: Row) => {
    const row = db.consents.find(consent => consent.email === where.email)
    if (row) Object.assign(row, update)
    else db.consents.push({ id: nextId('cons'), createdAt: new Date(), ...create })
    return { ...(row ?? db.consents[db.consents.length - 1]) }
  })

  // The team's consent (the box): ON CONFLICT (email) DO NOTHING, so it never overwrites an existing row.
  prismaMock.crmEmailConsent.createMany.mockImplementation(async ({ data }: Row) => {
    let count = 0
    for (const row of data) {
      if (db.consents.some(consent => consent.email === row.email)) continue
      db.consents.push({ id: nextId('cons'), createdAt: new Date(), ...row })
      count++
    }
    return { count }
  })
  prismaMock.crmEmailConsent.findUnique.mockImplementation(
    async ({ where }: Row) => db.consents.find(consent => consent.email === where.email) ?? null,
  )

  // «Eliminar» (D7): the account goes with its people and its timeline (onDelete: Cascade), and its entries are deleted by
  // `accountId` or by `id`.
  prismaMock.crmAccount.delete.mockImplementation(async ({ where }: Row) => {
    const index = db.accounts.findIndex(account => account.id === where.id)
    if (index < 0) throw new Error('Record to delete does not exist')
    const [row] = db.accounts.splice(index, 1)
    db.contacts = db.contacts.filter(contact => contact.accountId !== row.id)
    db.events = db.events.filter(event => event.accountId !== row.id)
    // Its consent rows too: `CrmEmailConsent.accountId` is onDelete: Cascade in the schema.
    db.consents = db.consents.filter(consent => consent.accountId !== row.id)
    for (const entry of db.entries) if (entry.accountId === row.id) entry.accountId = null
    return { ...row }
  })
  prismaMock.crmContact.findMany.mockImplementation(async ({ where, take }: Row) =>
    db.contacts.filter(contact => contactMatches(contact, where)).slice(0, take ?? Infinity),
  )
  prismaMock.crmInboundEntry.deleteMany.mockImplementation(async ({ where }: Row) => {
    const doomed = db.entries.filter(entry => Object.entries(where).every(([field, value]) => (entry[field] ?? null) === value))
    db.entries = db.entries.filter(entry => !doomed.includes(entry))
    return { count: doomed.length }
  })
  /** The tombstone: unique (keyHash, scope), ON CONFLICT DO NOTHING; `OR` of `keyHash`/`scope` filters and `erasedAt.gte`. */
  prismaMock.crmErased.createMany.mockImplementation(async ({ data }: Row) => {
    let count = 0
    for (const row of data) {
      const scope = row.scope ?? ''
      if (db.erased.some(existing => existing.keyHash === row.keyHash && existing.scope === scope)) continue
      db.erased.push({ ...row, scope })
      count++
    }
    return { count }
  })
  const erasedMatches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([field, filter]) =>
      field === 'OR' ? (filter as Row[]).some(branch => erasedMatches(row, branch)) : fieldMatches(row[field], filter),
    )
  prismaMock.crmErased.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const rows = db.erased.filter(row => erasedMatches(row, where))
    rows.forEach(row => patch(row, data))
    return { count: rows.length }
  })
  prismaMock.crmErased.findFirst.mockImplementation(async ({ where }: Row) => {
    const found = db.erased.filter(row => erasedMatches(row, where)).sort((a, b) => b.erasedAt.getTime() - a.erasedAt.getTime())[0]
    return found ? { erasedAt: found.erasedAt } : null
  })
  prismaMock.crmErased.findMany.mockImplementation(async ({ where, take, distinct }: Row) =>
    db.erased
      .filter(row => erasedMatches(row, where))
      .filter((row, i, rows) => !distinct || rows.findIndex(other => other.keyHash === row.keyHash) === i)
      .slice(0, take ?? Infinity)
      .map(row => ({ keyHash: row.keyHash })),
  )
  prismaMock.activityLog.create.mockImplementation(async ({ data }: Row) => {
    db.logs.push(data)
    return { id: nextId('log') }
  })

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
