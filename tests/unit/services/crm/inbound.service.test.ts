/**
 * Landing → CRM (spec 2026-10-30 §5.3, plan task 5): the raw entry is cleaned and saved before anything else, and
 * applying it is ONE upsert by (LANDING, email) that a second run — the sweep after a crash — cannot repeat.
 *
 * What these pin beyond the happy path: PostgreSQL never sees a NUL byte; a failed save retries once and never throws;
 * the four signup outcomes each touch the account the way the spec says; an entry whose signup is still running waits;
 * and an entry applied twice leaves one set of events.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_LOST_STAGE_ID, FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { notifyNewProspect, notifyReturningProspect } from '@/services/crm/digest.service'
import { erasedHashes } from '@/services/crm/erase.service'
import { applyEntry, recordSignupOutcome, sanitizeEntry, saveLandingEntry, type SignupOutcome } from '@/services/crm/inbound.service'
import { esCorreoDePrueba } from '@/services/crm/internalEmail'

jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn(), notifyReturningProspect: jest.fn() }))

const ORG = 'corglandn0000000000000001'
/** Where an invited manager works: their PRIMARY membership, of any role — never what their own form links to. */
const PATRON_ORG = 'corgpatron000000000000001'
const TEAM_ORG = 'corgteam00000000000000001'
const EMAIL = 'ana@cafe.mx'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** What `prisma.staff.findUnique` returns for the entry's email: an active OWNER of `organizationId` (ruling 25). */
function owner(organizationId: string, over: { createdAt?: Date; password?: string | null; organizationCreatedAt?: Date } = {}) {
  return {
    active: true,
    password: over.password ?? null,
    createdAt: over.createdAt ?? new Date(Date.now() - 30 * DAY),
    organizations: [{ organization: { id: organizationId, createdAt: over.organizationCreatedAt ?? new Date(Date.now() - 30 * DAY) } }],
  }
}

/** The landing form as `contactSchema` leaves it. */
const FORM = {
  firstName: 'Ana',
  lastName: 'López',
  phone: '55 1234 5678',
  email: EMAIL,
  companyName: 'Café Ana',
  employees: '3',
  revenue: '500k-1m',
  businessType: 'Cafetería',
  modules: 'mesas,cocina, qr',
  source: 'landing_restaurantes',
  utm: { utm_source: 'meta', utm_campaign: 'pos22' },
}

const NEW_SIGNUP: SignupOutcome = { organizationId: ORG, alreadyExisted: false, yaEsCliente: false }

let db: ReturnType<typeof installCrmInboundFake>

/** A saved entry, as `saveLandingEntry` + `recordSignupOutcome` leave it. */
function seedEntry(over: Record<string, unknown> = {}) {
  const entry = {
    id: `centrylnd00000000000000${String(db.entries.length + 1).padStart(2, '0')}`,
    source: 'LANDING',
    externalKey: EMAIL,
    payload: FORM,
    receivedAt: new Date(Date.now() - MINUTE),
    signupOutcome: NEW_SIGNUP,
    signupResolvedAt: new Date(),
    appliedAt: null,
    accountId: null,
    lastError: null,
    noticeSentAt: null,
    noticeAttempts: 0,
    ...over,
  }
  db.entries.push(entry)
  return entry
}

/** An account the CRM already has for this email. */
function seedAccount(over: Record<string, unknown> = {}) {
  const account = {
    id: 'caccountl0000000000000001',
    name: 'Café Ana',
    source: 'LANDING',
    externalKey: EMAIL,
    stageId: FAKE_STAGE_ID,
    giro: 'Restaurante',
    ventasRango: null,
    sucursales: 1,
    modulos: ['mesas'],
    organizationId: null,
    qualificationAvailable: true,
    ...over,
  }
  db.accounts.push(account)
  return account
}

const eventsOf = (kind: string) => db.events.filter(event => event.kind === kind)

beforeEach(() => {
  db = installCrmInboundFake(prismaMock)
  ;(notifyNewProspect as jest.Mock).mockResolvedValue(undefined)
  ;(notifyReturningProspect as jest.Mock).mockResolvedValue(undefined)
})

describe('sanitizeEntry', () => {
  it('limpia_nulo_control_y_largo', () => {
    const clean = sanitizeEntry({
      companyName: 'Café\u0000 Ana\u0007',
      businessType: 'x'.repeat(10_000),
      firstName: 'Ana\uD800', // a lone surrogate: PostgreSQL rejects it in JSONB too
      lastName: '😀 López',
      // Cutting at 500 would split the last emoji in two: the half it leaves goes too.
      revenue: `a${'😀'.repeat(300)}`,
      modules: Array.from({ length: 30 }, (_, i) => `m${i}\u0000`),
      utm: { utm_source: 'meta\u0000', utm_campaign: 'c'.repeat(600) },
      employees: 3,
      empty: null,
      missing: undefined,
    })

    expect(clean.companyName).toBe('Café Ana')
    expect(clean.businessType).toBe('x'.repeat(500))
    expect(clean.firstName).toBe('Ana')
    expect(clean.lastName).toBe('😀 López')
    expect(clean.revenue).toBe(`a${'😀'.repeat(249)}`)
    expect(clean.modules).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`))
    expect(clean.utm).toEqual({ utm_source: 'meta', utm_campaign: 'c'.repeat(500) })
    expect(clean.employees).toBe('3')
    expect(clean).not.toHaveProperty('empty')
    expect(clean).not.toHaveProperty('missing')
    expect(JSON.stringify(clean)).not.toMatch(/\\u0000|\\ud800/i)
  })
})

describe('sanitizeEntry: booleans', () => {
  it('conserva_los_booleanos_como_booleanos (Codex plan r1 #2): la casilla de novedades nunca se vuelve el texto «true»', () => {
    expect(sanitizeEntry({ a: true, b: false })).toEqual({ a: true, b: false })
    // Next to the texts, which are cleaned as always.
    expect(sanitizeEntry({ marketingConsent: true, companyName: 'Café\u0000 Ana', employees: 3 })).toEqual({
      marketingConsent: true,
      companyName: 'Café Ana',
      employees: '3',
    })
  })
})

describe('saveLandingEntry', () => {
  it('guardar_reintenta_una_vez_y_no_lanza', async () => {
    const create = prismaMock.crmInboundEntry.create
    create.mockReset()
    create.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce({ id: 'centrylnd0000000000000001' })

    const formAt = new Date(Date.now() - 2_000)
    await expect(saveLandingEntry({ ...FORM, email: ' Ana@Cafe.MX', businessType: 'Cafe\u0000tería' }, formAt)).resolves.toEqual({
      entryId: 'centrylnd0000000000000001',
    })
    expect(create).toHaveBeenCalledTimes(2)
    // The key is the signup's own normalization of the email; the payload is the CLEAN form. The retry keeps the FORM's
    // moment, not its own (D7, Codex r4 H1).
    expect(create.mock.calls[1][0].data).toEqual({
      source: 'LANDING',
      externalKey: EMAIL,
      payload: expect.objectContaining({ businessType: 'Cafetería', companyName: 'Café Ana' }),
      receivedAt: formAt,
    })

    // Twice down: no entry, no throw, and the clean form goes to the log (the internal email is the other copy).
    create.mockReset()
    create.mockRejectedValue(new Error('database is down'))
    await expect(saveLandingEntry({ ...FORM, businessType: 'Cafe\u0000tería' })).resolves.toBeNull()
    expect(create).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[CRM]'),
      expect.objectContaining({ payload: expect.objectContaining({ businessType: 'Cafetería' }) }),
    )
  })

  it('recordSignupOutcome writes the real outcome (null = the signup failed) and never throws', async () => {
    const entry = seedEntry({ signupOutcome: null, signupResolvedAt: null })

    await recordSignupOutcome(entry.id, null)
    expect(db.entries[0]).toMatchObject({ signupOutcome: null, signupResolvedAt: expect.any(Date) })

    await recordSignupOutcome(entry.id, NEW_SIGNUP)
    expect(db.entries[0].signupOutcome).toEqual(NEW_SIGNUP)

    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('database is down'))
    await expect(recordSignupOutcome(entry.id, NEW_SIGNUP)).resolves.toBeUndefined()
  })
})

describe('applyEntry', () => {
  it.each([
    {
      branch: 'alta nueva',
      outcome: NEW_SIGNUP as SignupOutcome | null,
      existing: false,
      check: () => {
        expect(db.accounts).toHaveLength(1)
        expect(db.accounts[0]).toMatchObject({
          name: 'Café Ana',
          source: 'LANDING',
          externalKey: EMAIL,
          stageId: FAKE_STAGE_ID,
          giro: 'Cafetería',
          ventasRango: '500k-1m',
          sucursales: 3,
          modulos: ['mesas', 'cocina', 'qr'],
          organizationId: ORG,
          sourceDetail: { page: 'landing_restaurantes', utm: { utm_source: 'meta', utm_campaign: 'pos22' } },
        })
        expect(db.accounts[0]).not.toHaveProperty('ownerStaffId') // «Sin dueño»
        expect(db.contacts).toEqual([
          {
            id: expect.any(String),
            accountId: db.accounts[0].id,
            name: 'Ana López',
            phoneE164: '+525512345678',
            email: EMAIL,
            isPrimary: true,
          },
        ])
        expect(db.events.map(event => event.kind)).toEqual(['ENTRY_APPLIED'])
        expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id, expect.objectContaining({ name: 'Café Ana' }))
      },
    },
    {
      branch: 'cuenta incompleta que ya existía',
      outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false },
      existing: true,
      check: () => {
        expect(db.accounts).toHaveLength(1)
        expect(db.accounts[0]).toMatchObject({
          giro: 'Cafetería',
          ventasRango: '500k-1m',
          sucursales: 3,
          modulos: ['mesas', 'cocina', 'qr'],
        })
        expect(eventsOf('FIELD_CHANGE')).toHaveLength(1)
        expect(eventsOf('FIELD_CHANGE')[0]).toMatchObject({
          actorStaffId: null,
          data: {
            changes: [
              { field: 'giro', from: 'Restaurante', to: 'Cafetería' },
              { field: 'ventasRango', from: null, to: '500k-1m' },
              { field: 'sucursales', from: 1, to: 3 },
              { field: 'modulos', from: ['mesas'], to: ['mesas', 'cocina', 'qr'] },
            ],
          },
        })
        expect(eventsOf('NOTE')).toHaveLength(0)
        // Seeded without any person: the entry's email and phone become its contact (ruling 57).
        expect(db.contacts).toEqual([expect.objectContaining({ accountId: db.accounts[0].id, email: EMAIL, phoneE164: '+525512345678' })])
        expect(notifyNewProspect).not.toHaveBeenCalled()
      },
    },
    {
      branch: 'yaEsCliente',
      outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true },
      existing: true,
      check: () => {
        // Only a note: what a customer types in the form does not overwrite their account.
        expect(db.accounts[0]).toMatchObject({ giro: 'Restaurante', sucursales: 1, modulos: ['mesas'] })
        expect(eventsOf('NOTE')).toHaveLength(1)
        expect(eventsOf('NOTE')[0].data.text).toMatch(/ya es cliente/i)
        expect(eventsOf('FIELD_CHANGE')).toHaveLength(0)
        expect(notifyNewProspect).not.toHaveBeenCalled()
      },
    },
    {
      branch: 'null (el alta falló)',
      outcome: null,
      existing: false,
      check: () => {
        expect(db.accounts).toHaveLength(1)
        expect(db.accounts[0]).toMatchObject({ giro: 'Cafetería', organizationId: null })
        expect(db.events.map(event => event.kind)).toEqual(['ENTRY_APPLIED'])
        expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id, expect.objectContaining({ name: 'Café Ana' }))
      },
    },
  ])('aplicar_cuatro_ramas: $branch', async ({ outcome, existing, check }) => {
    if (existing) {
      // An account already linked to ORG, whose person owns it.
      seedAccount({ organizationId: ORG })
      prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    }
    const entry = seedEntry({ signupOutcome: outcome })

    await applyEntry(entry.id)

    check()
    // Every branch: one ENTRY_APPLIED keyed by the entry, and the entry marked applied on that account.
    expect(eventsOf('ENTRY_APPLIED')).toEqual([expect.objectContaining({ sourceKey: `entry:${entry.id}`, actorStaffId: null })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id, lastError: null })
  })

  it('an alta nueva over an account that already existed without an Organization links it (the second of two forms)', async () => {
    seedAccount({ giro: 'Cafetería', ventasRango: '500k-1m', sucursales: 3, modulos: ['mesas', 'cocina', 'qr'] })
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0].organizationId).toBe(ORG)
    expect(eventsOf('LINKED')).toEqual([
      expect.objectContaining({
        sourceKey: `link:${db.accounts[0].id}:${ORG}`,
        data: { organizationId: ORG, organizationName: 'Café Ana S.A.' },
      }),
    ])
    // Same data as the account already had: nothing to record as changed.
    expect(eventsOf('FIELD_CHANGE')).toHaveLength(0)
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('never links the sales team’s own organization', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
    prismaMock.staff.findUnique.mockResolvedValue(owner(TEAM_ORG))
    const team = seedEntry({ signupOutcome: { organizationId: TEAM_ORG, alreadyExisted: true, yaEsCliente: true } })

    await applyEntry(team.id)

    expect(db.accounts[0].organizationId).toBeNull()
  })

  it('a person who already had an account links only to the Organization they OWN, never to the primary one the signup returned (ruling 25)', async () => {
    // An invited manager with a password fills the form for their own business: the signup says «customer» with their
    // boss's Organization (their primary membership). The account links to the one they own.
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const manager = seedEntry({ signupOutcome: { organizationId: PATRON_ORG, alreadyExisted: true, yaEsCliente: true } })

    await applyEntry(manager.id)

    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: EMAIL } }))
    expect(db.accounts[0].organizationId).toBe(ORG)

    // Owning nothing: no Organization at all, never the boss's.
    prismaMock.staff.findUnique.mockResolvedValue(null)
    // Another phone too: the same phone would be the same person (ruling 48).
    const employee = seedEntry({
      externalKey: 'empleado@cafe.mx',
      payload: { ...FORM, email: 'empleado@cafe.mx', phone: '55 8888 0000' },
      signupOutcome: { organizationId: PATRON_ORG, alreadyExisted: true, yaEsCliente: false },
    })

    await applyEntry(employee.id)

    expect(db.accounts.find(account => account.externalKey === 'empleado@cafe.mx')).toMatchObject({ organizationId: null })
  })

  it.each([
    { branch: 'cliente', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true }, kind: 'NOTE' },
    { branch: 'cuenta que ya existía', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false }, kind: 'FIELD_CHANGE' },
  ])(
    'an Organization that already has a CRM account gets the entry on THAT account, whatever its source (ruling 25): $branch',
    async ({ outcome, kind }) => {
      // A won WhatsApp prospect holds ORG; its owner now fills the landing form.
      const whatsapp = seedAccount({
        id: 'cacctwhats000000000000001',
        source: 'WHATSAPP',
        externalKey: '+525500000000',
        organizationId: ORG,
      })
      prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
      const entry = seedEntry({ signupOutcome: outcome })

      await applyEntry(entry.id)

      expect(db.accounts).toHaveLength(1)
      expect(eventsOf(kind)).toEqual([expect.objectContaining({ accountId: whatsapp.id })])
      expect(eventsOf('ENTRY_APPLIED')).toEqual([expect.objectContaining({ accountId: whatsapp.id, sourceKey: `entry:${entry.id}` })])
      expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: whatsapp.id })
      // No second account — and the person's email and phone stay with the one that took the entry (ruling 57).
      expect(db.contacts).toEqual([expect.objectContaining({ accountId: whatsapp.id, email: EMAIL, phoneE164: '+525512345678' })])
      expect(notifyNewProspect).not.toHaveBeenCalled()
    },
  )

  it('a customer new to the CRM gets the «ya es cliente» note, and no «Nuevo prospecto» (ruling 23)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG, { password: 'hash' }))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true } })

    await applyEntry(entry.id)

    expect(db.accounts).toEqual([expect.objectContaining({ externalKey: EMAIL, organizationId: ORG })])
    expect(eventsOf('NOTE')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ text: expect.stringMatching(/ya es cliente/i) }) }),
    ])
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ signup: 'CUSTOMER', created: true })
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('an unnormalizable phone leaves the person without a phone, and the entry still applies', async () => {
    const entry = seedEntry({ payload: { ...FORM, phone: 'llámame' } })

    await applyEntry(entry.id)

    expect(db.contacts).toEqual([expect.objectContaining({ phoneE164: null, email: EMAIL })])
    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
  })

  it('locks an account that already existed before writing its ENTRY_APPLIED, so two entries queue instead of deadlocking (ruling 26)', async () => {
    const account = seedAccount({ organizationId: ORG })
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })

    await applyEntry(entry.id)

    const calls = prismaMock.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>
    const lock = calls.findIndex(([sql]) => sql.join('?').includes('FOR UPDATE'))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(calls[lock].slice(1)).toEqual([account.id])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[lock]).toBeLessThan(
      prismaMock.crmTimelineEvent.createMany.mock.invocationCallOrder[0],
    )

    // A brand-new account is nobody else's yet: no row lock needed (only the entry's own lock, ruling 48).
    prismaMock.$queryRaw.mockClear()
    const fresh = seedEntry({
      externalKey: 'nueva@cafe.mx',
      payload: { ...FORM, email: 'nueva@cafe.mx', phone: '55 7777 0000' },
      signupOutcome: null,
    })
    await applyEntry(fresh.id)
    const freshCalls = prismaMock.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>
    expect(freshCalls.some(([sql]) => sql.join('?').includes('FOR UPDATE'))).toBe(false)
  })

  it.each([
    { branch: 'alta nueva', outcome: NEW_SIGNUP, announcements: 2 },
    { branch: 'cliente', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true }, announcements: 0 },
  ])(
    'a re-run announces again an account its first run created — the email key keeps it from repeating — unless it is a customer (ruling 26): $branch',
    async ({ outcome, announcements }) => {
      prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
      const entry = seedEntry({ signupOutcome: outcome })
      prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))

      await applyEntry(entry.id)
      await applyEntry(entry.id)

      expect(db.accounts).toHaveLength(1)
      expect(notifyNewProspect).toHaveBeenCalledTimes(announcements)
      if (announcements)
        expect(notifyNewProspect).toHaveBeenLastCalledWith(db.accounts[0].id, expect.objectContaining({ name: 'Café Ana' }))
      expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
    },
  )

  it('a re-run goes to the account its first run used, even when the lookup no longer leads there: no orphan account', async () => {
    // The first run applies to the WhatsApp account that holds ORG (its owner filled the form), then dies before
    // `appliedAt`.
    const whatsapp = seedAccount({ id: 'cacctwhats000000000000001', source: 'WHATSAPP', externalKey: '+525500000000', organizationId: ORG })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))
    await applyEntry(entry.id)

    // Before the sweep, the person stops owning ORG (membership deactivated): a fresh lookup would find no account.
    prismaMock.staff.findUnique.mockResolvedValue({ ...owner(ORG), organizations: [] })
    prismaMock.crmAccount.createMany.mockClear()
    await applyEntry(entry.id)

    expect(prismaMock.crmAccount.createMany).not.toHaveBeenCalled()
    expect(db.accounts).toEqual([expect.objectContaining({ id: whatsapp.id })])
    // The person the first run added (ruling 57), once.
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: whatsapp.id, email: EMAIL })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: whatsapp.id })
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it.each([
    {
      path: 'desenlace registrado del alta',
      entry: { signupOutcome: { organizationId: PATRON_ORG, alreadyExisted: true, yaEsCliente: true } },
    },
    {
      path: 'por el correo, sin desenlace',
      entry: { signupOutcome: null, signupResolvedAt: null, receivedAt: new Date(Date.now() - 6 * MINUTE) },
    },
  ])(
    'an invited employee with a password who owns no Organization is a prospect, and both paths say so (ruling 27): $path',
    async ({ entry }) => {
      // The signup calls them a customer (they have a password); for the CRM, a customer also owns an Organization.
      prismaMock.staff.findUnique.mockResolvedValue({ ...owner(PATRON_ORG, { password: 'hash' }), organizations: [] })
      const saved = seedEntry(entry)

      await applyEntry(saved.id)

      expect(db.accounts).toEqual([expect.objectContaining({ externalKey: EMAIL, organizationId: null })])
      expect(eventsOf('NOTE')).toHaveLength(0)
      expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ signup: 'EXISTING_ACCOUNT', created: true })
      expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id, expect.objectContaining({ name: 'Café Ana' }))
    },
  )

  it('sin_desenlace_y_reciente_no_aplica', async () => {
    const entry = seedEntry({ signupOutcome: null, signupResolvedAt: null, receivedAt: new Date(Date.now() - MINUTE) })

    await applyEntry(entry.id)

    // The signup is still running: nothing is guessed, nothing is written; the sweep applies it later.
    expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
    expect(db.accounts).toHaveLength(0)
    expect(db.events).toHaveLength(0)
    expect(db.entries[0].appliedAt).toBeNull()
  })

  describe('sin_desenlace_viejo_resuelve_por_correo', () => {
    const SENT = new Date(Date.now() - 6 * MINUTE)
    const BEFORE = new Date(SENT.getTime() - DAY)
    const AFTER = new Date(SENT.getTime() + 30_000)
    /** An entry whose signup never wrote its outcome, old enough for the email to answer. */
    const unresolved = (email: string) =>
      seedEntry({ externalKey: email, payload: { ...FORM, email }, signupOutcome: null, signupResolvedAt: null, receivedAt: SENT })

    it.each([
      {
        case: 'an OWNER from before the form, without a password: an account that already existed',
        staff: owner(ORG, { createdAt: BEFORE, organizationCreatedAt: BEFORE }),
        signup: 'EXISTING_ACCOUNT',
        organizationId: ORG,
        announced: true,
      },
      {
        // M-5: the signup's own rule — a password means the business already operates.
        case: 'an OWNER from before the form, with a password and an Organization from before: a customer',
        staff: owner(ORG, { createdAt: BEFORE, organizationCreatedAt: BEFORE, password: 'hash' }),
        signup: 'CUSTOMER',
        organizationId: ORG,
        announced: false,
      },
      {
        // M-1: this very signup created the person and confirmed its code within the 5 minutes — still a new prospect.
        case: 'a person this form created, password already set by the code: a new signup, never a customer',
        staff: owner(ORG, { createdAt: AFTER, organizationCreatedAt: AFTER, password: 'hash' }),
        signup: 'NEW_SIGNUP',
        organizationId: ORG,
        announced: true,
      },
      {
        case: 'nobody with that email owns an Organization: the signup failed',
        staff: null,
        signup: 'SIGNUP_FAILED',
        organizationId: null,
        announced: true,
      },
    ])('$case', async ({ staff, signup, organizationId, announced }) => {
      prismaMock.staff.findUnique.mockResolvedValue(staff)
      const entry = unresolved(EMAIL)

      await applyEntry(entry.id)

      expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: EMAIL } }))
      expect(db.accounts).toEqual([expect.objectContaining({ externalKey: EMAIL, organizationId })])
      expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ signup })
      expect(eventsOf('NOTE')).toHaveLength(signup === 'CUSTOMER' ? 1 : 0)
      expect(notifyNewProspect).toHaveBeenCalledTimes(announced ? 1 : 0)
    })
  })

  it.each([
    { branch: 'cuenta que ya existía', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false }, kind: 'FIELD_CHANGE' },
    // The note is what would repeat: unlike the qualification, adding it again is not a no-op.
    { branch: 'ya es cliente', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true }, kind: 'NOTE' },
  ])('aplicar_dos_veces_misma_entrada_un_evento: $branch', async ({ outcome, kind }) => {
    seedAccount({ organizationId: ORG })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = seedEntry({ signupOutcome: outcome })
    // The account and its events are written, then the process «dies» before `appliedAt`.
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))

    await expect(applyEntry(entry.id)).resolves.toBeUndefined()
    expect(db.entries[0]).toMatchObject({ appliedAt: null, lastError: expect.stringContaining('died') })

    // The sweep applies it again (ruling 20: the same `applyEntry`). The entry's ENTRY_APPLIED is already there
    // (`sourceKey`), so it stops before touching the account.
    prismaMock.crmAccount.update.mockClear()
    await applyEntry(entry.id)

    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(eventsOf('ENTRY_APPLIED')).toHaveLength(1)
    expect(eventsOf(kind)).toHaveLength(1)
    expect(db.accounts).toHaveLength(1)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id, lastError: null })

    // Once applied, a third run reads the entry and stops.
    prismaMock.crmAccount.createMany.mockClear()
    await applyEntry(entry.id)
    expect(prismaMock.crmAccount.createMany).not.toHaveBeenCalled()
  })
})

describe('ruling 31: an entry that lands on an ARCHIVED account brings it back', () => {
  const ARCHIVED_AT = new Date(Date.now() - 20 * DAY)
  /** The backfill archived this person's old signup (ruling 30); now they fill the form again. */
  const returning = (over: Record<string, unknown> = {}) => {
    const account = seedAccount({ organizationId: ORG, archivedAt: ARCHIVED_AT, ...over })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })
    return { account, entry }
  }

  it('archivada_vuelve_por_la_landing_se_reactiva_y_se_anuncia_con_su_llave', async () => {
    const { account, entry } = returning()

    await applyEntry(entry.id)

    // Back in the pipeline: no owner, so it is in «Sin dueño».
    expect(db.accounts[0]).toMatchObject({ id: account.id, archivedAt: null })
    expect(eventsOf('REACTIVATED')).toEqual([
      expect.objectContaining({ accountId: account.id, actorStaffId: null, data: { entryId: entry.id, via: 'LANDING' } }),
    ])
    // What a re-run needs to announce it again is in the entry's proof.
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ entryId: entry.id, created: false, reactivated: true })
    // Its own notice (its own email key per person), never «Nuevo prospecto», whose key may already be used.
    expect(notifyReturningProspect).toHaveBeenCalledTimes(1)
    expect(notifyReturningProspect).toHaveBeenCalledWith(account.id, entry.id, expect.objectContaining({ name: 'Café Ana' }))
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('a re-run repeats nothing, and re-sends the same notice only because the first send may have been lost (M-3)', async () => {
    const { account, entry } = returning()
    // The process dies after the commit, before `appliedAt` (and maybe before the email).
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))
    await applyEntry(entry.id)
    const before = db.events.map(event => ({ ...event }))

    await applyEntry(entry.id)

    // Not one event more: the entry's ENTRY_APPLIED key stops the second run before it touches the account.
    expect(db.events).toEqual(before)
    expect(db.accounts[0]).toMatchObject({ id: account.id, archivedAt: null })
    // The same notice with the same arguments — the same email keys and the content the first run fixed: Resend sends it
    // at most once.
    const calls = (notifyReturningProspect as jest.Mock).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual([account.id, entry.id, expect.objectContaining({ name: 'Café Ana' })])
    expect(calls[1]).toEqual(calls[0])
    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))

    // Applied: a third run reads the entry and stops.
    await applyEntry(entry.id)
    expect(notifyReturningProspect).toHaveBeenCalledTimes(2)
  })

  it('a customer comes back too, with the «ya es cliente» note and no notice (rulings 23 and 27)', async () => {
    const account = seedAccount({ organizationId: ORG, archivedAt: ARCHIVED_AT })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG, { password: 'hash' }))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true } })
    // It dies before `appliedAt`, so the sweep runs it again: neither run announces.
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))

    await applyEntry(entry.id)
    await applyEntry(entry.id)

    expect(db.accounts[0]).toMatchObject({ id: account.id, archivedAt: null })
    expect(eventsOf('REACTIVATED')).toHaveLength(1)
    expect(eventsOf('NOTE')).toHaveLength(1)
    expect(eventsOf('NOTE')[0].data.text).toMatch(/ya es cliente/i)
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ signup: 'CUSTOMER', reactivated: true })
    expect(notifyReturningProspect).not.toHaveBeenCalled()
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('a LOST account stays lost and archived (ruling 24)', async () => {
    const { account, entry } = returning({ stageId: FAKE_LOST_STAGE_ID })

    await applyEntry(entry.id)

    expect(db.accounts[0]).toMatchObject({ id: account.id, stageId: FAKE_LOST_STAGE_ID, archivedAt: ARCHIVED_AT })
    expect(eventsOf('REACTIVATED')).toHaveLength(0)
    expect(eventsOf('ENTRY_APPLIED')[0].data).not.toHaveProperty('reactivated')
    expect(notifyReturningProspect).not.toHaveBeenCalled()
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })
})

// Founder, 2-nov («Sí, las dos»): las pruebas internas del embudo en producción (correo @avoqado.io o el buzón de pruebas
// @resend.dev) llenaban el embudo de «QA …». Entran archivadas y sin «Nuevo prospecto»; se encuentran al buscar.
describe('pruebas internas: un correo @avoqado.io o @resend.dev entra archivado y sin aviso', () => {
  const PRUEBA = 'jose+e2e10-0941@Avoqado.io'
  const prueba = (over: Record<string, unknown> = {}) =>
    seedEntry({ externalKey: PRUEBA.toLowerCase(), payload: { ...FORM, email: PRUEBA }, ...over })

  it('alta_de_prueba_entra_archivada_y_sin_aviso', async () => {
    const entry = prueba()

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0].archivedAt).toEqual(expect.any(Date))
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ entryId: entry.id, created: true, prueba: true })
    expect(eventsOf('ENTRY_APPLIED')[0].data).not.toHaveProperty('noticeContent')
    expect(notifyNewProspect).not.toHaveBeenCalled()
    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
  })

  it('una_segunda_vuelta_de_la_prueba_tampoco_avisa (M-3)', async () => {
    const entry = prueba()
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))
    await applyEntry(entry.id)

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(notifyNewProspect).not.toHaveBeenCalled()
    expect(notifyReturningProspect).not.toHaveBeenCalled()
  })

  it('prueba_archivada_que_vuelve_por_la_landing_sigue_archivada', async () => {
    const archivedAt = new Date(Date.now() - 2 * DAY)
    const account = seedAccount({ externalKey: PRUEBA.toLowerCase(), organizationId: ORG, archivedAt })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = prueba({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })

    await applyEntry(entry.id)

    expect(db.accounts[0]).toMatchObject({ id: account.id, archivedAt })
    expect(eventsOf('REACTIVATED')).toHaveLength(0)
    expect(notifyReturningProspect).not.toHaveBeenCalled()
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('un_dominio_parecido_no_es_prueba: ana@noavoqado.io sí es un prospecto', async () => {
    const entry = seedEntry({ externalKey: 'ana@noavoqado.io', payload: { ...FORM, email: 'ana@noavoqado.io' } })

    await applyEntry(entry.id)

    expect(db.accounts[0].archivedAt ?? null).toBeNull()
    expect(eventsOf('ENTRY_APPLIED')[0].data).not.toHaveProperty('prueba')
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
  })
})

describe('esCorreoDePrueba', () => {
  it.each([
    ['jose+e2e@avoqado.io', true],
    ['  JOSE@AVOQADO.IO ', true],
    ['delivered+alta-codigo-081250@resend.dev', true],
    ['ana@cafe.mx', false],
    ['ana@noavoqado.io', false],
    ['ana@ventas.avoqado.io.mx', false],
    ['avoqado.io', false],
    ['', false],
    [null, false],
  ])('%s → %s', (email, esperado) => {
    expect(esCorreoDePrueba(email)).toBe(esperado)
  })
})

describe('ruling 48: one account per PERSON, whatever source found them first', () => {
  const PHONE = '+525512345678'
  const SELLER = 'cstaffsel0000000000000001'
  /** An account of another source with its person, as WhatsApp, HubSpot or a seller left it. */
  function seedPerson(account: Record<string, unknown>, contact: { email?: string | null; phoneE164?: string | null }) {
    const row = seedAccount({ giro: null, ventasRango: null, sucursales: null, modulos: [], ...account })
    db.contacts.push({
      accountId: row.id,
      name: 'Ana',
      email: contact.email ?? null,
      phoneE164: contact.phoneE164 ?? null,
      isPrimary: true,
    })
    return row
  }

  it('whatsapp_luego_landing_mismo_telefono_una_ficha: the landing lands on the WhatsApp account and links it, no «Nuevo prospecto»', async () => {
    // The routine created it from the chat; a seller took it. Now the person signs up through the landing, new email.
    const whatsapp = seedPerson(
      {
        id: 'cacctwhats000000000000001',
        source: 'WHATSAPP',
        externalKey: PHONE,
        ownerStaffId: SELLER,
        lastTouchAt: new Date(Date.now() - 3 * DAY),
      },
      { phoneE164: PHONE },
    )
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0]).toMatchObject({ id: whatsapp.id, organizationId: ORG, ownerStaffId: SELLER, giro: 'Cafetería' })
    expect(eventsOf('LINKED')).toEqual([expect.objectContaining({ accountId: whatsapp.id, sourceKey: `link:${whatsapp.id}:${ORG}` })])
    expect(eventsOf('ENTRY_APPLIED')).toEqual([
      expect.objectContaining({ accountId: whatsapp.id, data: expect.objectContaining({ created: false }) }),
    ])
    expect(eventsOf('FIELD_CHANGE')).toHaveLength(1)
    // A touch: the person came back, at the moment they sent the form.
    expect(db.accounts[0].lastTouchAt).toEqual(entry.receivedAt)
    // Ruling 57: the WhatsApp person (phone, no email) now carries the landing's email — the same contact, not a second one.
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: whatsapp.id, phoneE164: PHONE, email: EMAIL })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: whatsapp.id })
    expect(notifyNewProspect).not.toHaveBeenCalled()
    expect(notifyReturningProspect).not.toHaveBeenCalled()
  })

  it('archivada_de_hubspot_vuelve_por_la_landing: an archived HubSpot contact found by email comes back, with «Volvió»', async () => {
    const hubspot = seedPerson(
      {
        id: 'caccthubsp000000000000001',
        source: 'IMPORTACION',
        externalKey: 'hubspot:contact:7',
        archivedAt: new Date(Date.now() - 40 * DAY),
      },
      { email: EMAIL },
    )
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(db.accounts[0]).toMatchObject({ id: hubspot.id, archivedAt: null })
    expect(eventsOf('REACTIVATED')).toEqual([
      expect.objectContaining({ accountId: hubspot.id, data: { entryId: entry.id, via: 'LANDING' } }),
    ])
    expect(notifyReturningProspect).toHaveBeenCalledWith(hubspot.id, entry.id, expect.any(Object))
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it.each([
    {
      case: 'the email beats the phone, even an archived one over a fresh open one',
      people: [
        { id: 'cacctphone000000000000001', touched: 1, archived: false, lost: false, by: 'phone' },
        { id: 'cacctemail000000000000001', touched: 30, archived: true, lost: false, by: 'email' },
      ],
      winner: 'cacctemail000000000000001',
    },
    {
      case: 'among phones, the open one touched most recently (a lost or archived one never wins over it)',
      people: [
        { id: 'cacctold00000000000000001', touched: 5, archived: false, lost: false, by: 'phone' },
        { id: 'cacctnew00000000000000001', touched: 1, archived: false, lost: false, by: 'phone' },
        { id: 'cacctlost0000000000000001', touched: 0, archived: false, lost: true, by: 'phone' },
        { id: 'cacctarch0000000000000001', touched: 0, archived: true, lost: false, by: 'phone' },
      ],
      winner: 'cacctnew00000000000000001',
    },
    {
      case: 'with none open, the one touched most recently',
      people: [
        { id: 'cacctarch0000000000000002', touched: 9, archived: true, lost: false, by: 'phone' },
        { id: 'cacctlost0000000000000002', touched: 2, archived: false, lost: true, by: 'phone' },
      ],
      winner: 'cacctlost0000000000000002',
    },
  ])('varias_coincidencias_eleccion_determinista: $case', async ({ people, winner }) => {
    for (const person of people) {
      seedPerson(
        {
          id: person.id,
          source: 'WHATSAPP',
          externalKey: `+52550000${person.id.slice(-4)}`,
          lastTouchAt: new Date(Date.now() - person.touched * DAY - MINUTE),
          ...(person.archived ? { archivedAt: new Date(Date.now() - 50 * DAY) } : {}),
          ...(person.lost ? { stageId: FAKE_LOST_STAGE_ID } : {}),
        },
        person.by === 'email' ? { email: EMAIL } : { phoneE164: PHONE },
      )
    }
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(people.length)
    expect(eventsOf('ENTRY_APPLIED')).toEqual([expect.objectContaining({ accountId: winner })])
    expect(db.entries[0].accountId).toBe(winner)
  })

  it('a phone match linked to ANOTHER Organization is not the person who just signed up: their new business gets its own account', async () => {
    seedPerson(
      { id: 'cacctother000000000000001', source: 'WHATSAPP', externalKey: PHONE, organizationId: 'corgother0000000000000001' },
      { phoneE164: PHONE },
    )
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(2)
    expect(db.accounts[1]).toMatchObject({ source: 'LANDING', externalKey: EMAIL, organizationId: ORG })
    expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[1].id, expect.any(Object))
  })

  it('takes the entry’s own lock first, so two runs of the same entry queue (T5-r2(a))', async () => {
    const entry = seedEntry()

    await applyEntry(entry.id)

    const calls = prismaMock.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>
    expect(calls[0][0].join('?')).toContain('pg_advisory_xact_lock(hashtext(')
    expect(calls[0].slice(1)).toEqual([`crm:entry:${entry.id}`])
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.crmTimelineEvent.findUnique.mock.invocationCallOrder[0],
    )
  })
})

describe('ruling 50: an old entry never overwrites a newer one', () => {
  const T1 = new Date(Date.now() - 3 * DAY)
  const T2 = new Date(Date.now() - DAY)

  it('una_entrada_vieja_reparada_tarde_no_pisa_lo_nuevo_ni_mueve_el_toque_a_ahora', async () => {
    // The newer form (T2) already set the qualification; the older one (T1) failed and the sweep repairs it now.
    seedAccount({ ventasRango: '500k-1m', giro: 'Cafetería', sucursales: 3, modulos: ['mesas'], qualifiedAt: T2, lastTouchAt: T2 })
    const old = seedEntry({ receivedAt: T1, signupOutcome: null, payload: { ...FORM, revenue: 'menos de 100k', businessType: 'Bar' } })

    await applyEntry(old.id)

    expect(db.accounts[0]).toMatchObject({ ventasRango: '500k-1m', giro: 'Cafetería', qualifiedAt: T2, lastTouchAt: T2 })
    expect(eventsOf('FIELD_CHANGE')).toHaveLength(0)
    // Its story stays in the timeline: applied, and that it did not overwrite.
    expect(eventsOf('ENTRY_APPLIED')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ entryId: old.id, qualificationSkipped: true }) }),
    ])
    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
  })

  it('a newer entry does apply, and moves qualifiedAt and the touch to when it was sent', async () => {
    seedAccount({ ventasRango: 'menos de 100k', qualifiedAt: T1, lastTouchAt: T1 })
    const newer = seedEntry({ receivedAt: T2, signupOutcome: null })

    await applyEntry(newer.id)

    expect(db.accounts[0]).toMatchObject({ ventasRango: '500k-1m', qualifiedAt: T2, lastTouchAt: T2 })
    expect(eventsOf('FIELD_CHANGE')).toHaveLength(1)
  })

  it('an account created from an entry carries its qualifiedAt and its touch at the moment it was sent, never «now»', async () => {
    const late = seedEntry({ receivedAt: T1, signupOutcome: null })

    await applyEntry(late.id)

    expect(db.accounts[0]).toMatchObject({ qualifiedAt: T1, lastTouchAt: T1 })
  })
})

describe('ruling 49: the notice is marked only once it reached everyone', () => {
  it('aviso_que_sale_a_todos_marca_noticeSentAt', async () => {
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(true)
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), noticeSentAt: expect.any(Date), noticeAttempts: 0 })
  })

  it('aviso_que_falla_sube_el_contador_y_queda_pendiente', async () => {
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(false)
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), noticeSentAt: null, noticeAttempts: 1 })
  })

  it('the notice carries the content fixed at apply time, saved in ENTRY_APPLIED, so a retry repeats it word for word', async () => {
    ;(notifyNewProspect as jest.Mock).mockResolvedValue(true)
    const entry = seedEntry()

    await applyEntry(entry.id)

    const content = {
      name: 'Café Ana',
      giro: 'Cafetería',
      ventasRango: '500k-1m',
      sucursales: 3,
      modulos: ['mesas', 'cocina', 'qr'],
      qualificationAvailable: true,
    }
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ noticeContent: content })
    expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id, content)
  })

  it('an entry with nothing to announce marks nothing (a customer)', async () => {
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG, { password: 'hash' }))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true } })

    await applyEntry(entry.id)

    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), noticeSentAt: null, noticeAttempts: 0 })
    expect(eventsOf('ENTRY_APPLIED')[0].data).not.toHaveProperty('noticeContent')
  })
})

describe('ruling 57 (a): the account that takes the entry keeps the person’s email and phone', () => {
  const PHONE = '+525512345678'
  const contactOf = (accountId: string, contact: Record<string, unknown>) => {
    const row = { id: `ccontact${String(db.contacts.length + 1).padStart(17, '0')}`, accountId, name: 'Ana', isPrimary: true, ...contact }
    db.contacts.push(row)
    return row
  }

  it('whatsapp_con_telefono_sin_correo_recibe_el_correo_en_su_mismo_contacto (Codex r2, R2-1)', async () => {
    // The signup failed: nothing to link yet. The email must stay, or nothing finds the account by it later.
    const whatsapp = seedAccount({
      id: 'cacctwhats000000000000001',
      source: 'WHATSAPP',
      externalKey: PHONE,
      giro: null,
      ventasRango: null,
      sucursales: null,
      modulos: [],
    })
    const phoneOnly = contactOf(whatsapp.id, { email: null, phoneE164: PHONE })
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)

    expect(db.contacts).toEqual([{ ...phoneOnly, email: EMAIL }])
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ created: false, contactAdded: true })
  })

  it('nothing is duplicated: an account that already has both keeps its contacts as they are', async () => {
    const whatsapp = seedAccount({ id: 'cacctwhats000000000000002', source: 'WHATSAPP', externalKey: PHONE })
    contactOf(whatsapp.id, { email: null, phoneE164: PHONE })
    contactOf(whatsapp.id, { email: EMAIL, phoneE164: null, isPrimary: false })
    const before = db.contacts.map(contact => ({ ...contact }))
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)

    expect(db.contacts).toEqual(before)
    expect(prismaMock.crmContact.create).not.toHaveBeenCalled()
    expect(prismaMock.crmContact.update).not.toHaveBeenCalled()
    expect(eventsOf('ENTRY_APPLIED')[0].data).not.toHaveProperty('contactAdded')
  })

  it('contacto_51_no_se_duplica (Codex r3 R3-2): a person who is the 51st contact of an imported account is not added again', async () => {
    const imported = seedAccount({ id: 'caccthubsp000000000000051', source: 'IMPORTACION', externalKey: 'hubspot:deal:51' })
    for (let n = 1; n <= 50; n++)
      contactOf(imported.id, { name: `Persona ${n}`, email: `p${n}@cafe.mx`, phoneE164: null, isPrimary: n === 1 })
    contactOf(imported.id, { name: 'Ana', email: EMAIL, phoneE164: PHONE, isPrimary: false })
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)
    await applyEntry(seedEntry({ signupOutcome: null }).id)

    expect(db.accounts).toHaveLength(1)
    expect(db.entries.map(row => row.accountId)).toEqual([imported.id, imported.id])
    expect(db.contacts).toHaveLength(51)
    expect(prismaMock.crmContact.create).not.toHaveBeenCalled()
    expect(eventsOf('ENTRY_APPLIED').map(event => event.data.contactAdded)).toEqual([undefined, undefined])
  })

  it('a person found by another way (its Organization) with neither gets a new contact with both, not the primary one', async () => {
    const holder = seedAccount({ id: 'cacctholdr000000000000001', source: 'MANUAL', externalKey: null, organizationId: ORG })
    contactOf(holder.id, { name: 'Socio', email: 'socio@cafe.mx', phoneE164: '+525599990000' })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })

    await applyEntry(entry.id)

    expect(db.contacts).toHaveLength(2)
    expect(db.contacts[1]).toMatchObject({ accountId: holder.id, name: 'Ana López', email: EMAIL, phoneE164: PHONE, isPrimary: false })
  })
})

describe('ruling 65: one identity resolver for every writer (Codex exhaustiva #4, #5 and #6)', () => {
  const PHONE = '+525512345678'
  let afterThis: (() => void) | null = null
  afterEach(() => {
    afterThis?.()
    afterThis = null
  })
  const OTHER_ORG = 'corgother0000000000000001'
  const id = (prefix: string, n: number) => `c${prefix}${String(n).padStart(24 - prefix.length, '0')}`
  /** An account of another source with one person, as WhatsApp, HubSpot or a seller left it. */
  function seedPerson(account: Record<string, unknown>, contact: { email?: string | null; phoneE164?: string | null }) {
    const row = seedAccount({ source: 'WHATSAPP', giro: null, ventasRango: null, sucursales: null, modulos: [], ...account })
    db.contacts.push({
      id: id('cont', db.contacts.length + 1),
      accountId: row.id,
      name: 'Ana',
      email: contact.email ?? null,
      phoneE164: contact.phoneE164 ?? null,
      isPrimary: true,
    })
    return row
  }
  /** Runs `then` the first time the code locks this account's row: what another writer commits in that instant. */
  function onLock(accountId: string, then: () => void) {
    const answer = prismaMock.$queryRaw.getMockImplementation()
    let done = false
    prismaMock.$queryRaw.mockImplementation(async (first: TemplateStringsArray, ...values: unknown[]) => {
      if (!done && Array.isArray(first) && first.join('?').includes('FOR UPDATE') && values[0] === accountId) {
        done = true
        then()
      }
      return answer ? answer(first, ...values) : []
    })
  }

  it.each([
    { case: 'veinte por teléfono más recientes y el correo exacto en el puesto 21', linked: null },
    { case: 'veinte por teléfono ligadas a otros negocios y la correcta en el puesto 21', linked: OTHER_ORG },
  ])('la_coincidencia_correcta_no_se_pierde_por_el_limite (#4): $case', async ({ linked }) => {
    for (let n = 1; n <= 20; n++) {
      seedPerson(
        {
          id: id('acctphone', n),
          externalKey: `+5255000000${String(n).padStart(2, '0')}`,
          organizationId: linked ? id('orgother', n) : null,
          lastTouchAt: new Date(Date.now() - n * MINUTE),
        },
        { phoneE164: PHONE },
      )
    }
    // The 21st: the oldest touch. By email in the first case; by phone and still unlinked in the second.
    const right = seedPerson(
      { id: id('acctright', 1), externalKey: '+525500009999', lastTouchAt: new Date(Date.now() - 30 * DAY) },
      linked ? { phoneE164: PHONE } : { email: EMAIL },
    )
    const entry = seedEntry({ signupOutcome: linked ? NEW_SIGNUP : null })

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(21)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: right.id })
    expect(notifyNewProspect).not.toHaveBeenCalled()
  })

  it('la_organizacion_gana_a_la_llave_landing (#5): the business a seller linked takes the entry, not the unlinked landing account', async () => {
    const landing = seedAccount({ id: id('acctland', 1), organizationId: null, lastTouchAt: new Date(Date.now() - DAY) })
    const won = seedPerson({ id: id('acctwon', 1), externalKey: '+525599990000', organizationId: ORG }, { phoneE164: '+525599990000' })
    prismaMock.staff.findUnique.mockResolvedValue(owner(ORG))
    const entry = seedEntry({ signupOutcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false } })

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(2)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: won.id })
    expect(eventsOf('ENTRY_APPLIED')).toEqual([expect.objectContaining({ accountId: won.id })])
    // The landing account is left as it was: nothing merged, nothing written.
    expect(db.accounts.find(account => account.id === landing.id)).toMatchObject({ organizationId: null, giro: 'Restaurante' })
    expect(db.events.filter(event => event.accountId === landing.id)).toHaveLength(0)
  })

  it('linked_elsewhere_before_the_lock (#5): a candidate a «Ganar» links to another business meanwhile is resolved again', async () => {
    const shared = seedPerson({ id: id('acctshare', 1), externalKey: PHONE }, { phoneE164: PHONE })
    onLock(shared.id, () => Object.assign(db.accounts.find(account => account.id === shared.id)!, { organizationId: OTHER_ORG }))
    const entry = seedEntry()

    await applyEntry(entry.id)

    // Nothing of the person or the form lands on somebody else's business: their new one gets its own account.
    expect(db.accounts).toHaveLength(2)
    const mine = db.accounts.find(account => account.id !== shared.id)!
    expect(mine).toMatchObject({ source: 'LANDING', externalKey: EMAIL, organizationId: ORG })
    expect(db.entries[0].accountId).toBe(mine.id)
    expect(db.contacts.filter(contact => contact.accountId === shared.id)).toEqual([expect.objectContaining({ email: null })])
    expect(db.accounts.find(account => account.id === shared.id)).toMatchObject({ giro: null })
  })

  it('a_holder_that_appears_before_the_link_is_not_a_resolved_entry (#5): the entry fails, and its retry lands on the holder', async () => {
    const phoneOnly = seedPerson({ id: id('acctphone', 1), externalKey: PHONE }, { phoneE164: PHONE })
    const holder = { id: id('acctwon', 1), name: 'Café Ana', source: 'MANUAL', externalKey: null, stageId: FAKE_STAGE_ID }
    onLock(phoneOnly.id, () => db.accounts.push({ ...holder, organizationId: ORG }))
    // A transaction that fails leaves nothing behind, like Postgres (only for this test).
    const plain = prismaMock.$transaction.getMockImplementation()
    afterThis = () => prismaMock.$transaction.mockImplementation(plain)
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const before = { contacts: db.contacts.map(contact => ({ ...contact })), events: db.events.length }
      const accounts = db.accounts.map(account => ({ ...account }))
      try {
        return await callback(prismaMock)
      } catch (error) {
        db.contacts.splice(0, db.contacts.length, ...before.contacts)
        db.events.length = before.events
        const holderNow = db.accounts.find(account => account.id === holder.id)
        db.accounts.splice(
          0,
          db.accounts.length,
          ...accounts.filter(account => account.id !== holder.id),
          ...(holderNow ? [holderNow] : []),
        )
        throw error
      }
    })
    const entry = seedEntry()

    await applyEntry(entry.id)
    expect(db.entries[0]).toMatchObject({ appliedAt: null, lastError: expect.stringContaining('meanwhile') })
    expect(db.accounts.find(account => account.id === phoneOnly.id)).toMatchObject({ organizationId: null })

    await applyEntry(entry.id)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: holder.id, lastError: null })
  })

  it.each([
    { case: 'ya estaba ligada a su primer negocio', race: false },
    { case: 'un «Ganar» la liga a otro negocio mientras el formulario espera el candado', race: true },
  ])('segundo_negocio_va_a_una_ficha_propia (ruling 71; Codex autorización H1): $case', async ({ race }) => {
    const landing = seedAccount({ id: id('acctland', 1), organizationId: race ? null : OTHER_ORG })
    if (race)
      onLock(landing.id, () => Object.assign(db.accounts.find(account => account.id === landing.id)!, { organizationId: OTHER_ORG }))
    // The person just created ORG, another business, with this form.
    const entry = seedEntry()

    await applyEntry(entry.id)

    // A new account for ORG — its key is the email with ORG's id — with the person, linked, applied and announced once.
    const mine = db.accounts.find(account => account.id !== landing.id)!
    expect(mine).toMatchObject({ source: 'LANDING', externalKey: `${EMAIL}|${ORG}`, organizationId: ORG, giro: 'Cafetería' })
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: mine.id, email: EMAIL, phoneE164: PHONE, isPrimary: true })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: mine.id, lastError: null })
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
    expect(notifyNewProspect).toHaveBeenCalledWith(mine.id, expect.objectContaining({ name: 'Café Ana' }))
    // Nothing written to the other business.
    expect(db.accounts.find(account => account.id === landing.id)).toMatchObject({ organizationId: OTHER_ORG, giro: 'Restaurante' })
    expect(db.events.filter(event => event.accountId === landing.id)).toEqual([])

    // The same entry again changes nothing; another form of the same person for ORG lands on that same account.
    await applyEntry(entry.id)
    const again = seedEntry()
    await applyEntry(again.id)
    expect(db.accounts).toHaveLength(2)
    expect(db.entries.map(row => row.accountId)).toEqual([mine.id, mine.id])
    expect(notifyNewProspect).toHaveBeenCalledTimes(1)
  })

  it('sin_organizacion_la_llave_recibe_la_entrada_como_siempre (ruling 71)', async () => {
    const landing = seedAccount({ id: id('acctland', 1), organizationId: OTHER_ORG })
    // The signup failed and the person owns nothing: no business of their own to send it to.
    const entry = seedEntry({ signupOutcome: null })

    await applyEntry(entry.id)

    expect(db.accounts).toHaveLength(1)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: landing.id })
  })

  it('conflicto_que_ningun_reintento_resuelve_se_cierra_y_se_dice_una_vez (ruling 71)', async () => {
    // Even the account of ORG's own key belongs to a third business (ORG was deleted and that account won elsewhere).
    seedAccount({ id: id('acctland', 1), organizationId: OTHER_ORG })
    seedAccount({ id: id('acctland', 2), externalKey: `${EMAIL}|${ORG}`, organizationId: 'corgthird0000000000000001' })
    const entry = seedEntry()

    await applyEntry(entry.id)
    await applyEntry(entry.id)

    // Closed without an account: the sweep never takes it again. Nothing written anywhere, and said once.
    expect(db.entries[0]).toMatchObject({
      appliedAt: expect.any(Date),
      accountId: null,
      lastError: expect.stringContaining('another Organization'),
    })
    expect(db.contacts).toEqual([])
    expect(db.events).toEqual([])
    expect((logger.error as jest.Mock).mock.calls.filter(([text]) => String(text).includes('closed without one'))).toHaveLength(1)
  })

  it('choque_de_organizacion_al_crear_devuelve_al_titular (#6): no second, unlinked account', async () => {
    const holder = { id: id('acctwon', 1), name: 'Café Ana', source: 'MANUAL', externalKey: null, stageId: FAKE_STAGE_ID }
    // A «Ganar» links another account to the person's new Organization between the lookup and the insert.
    const insert = prismaMock.crmAccount.createMany.getMockImplementation()!
    prismaMock.crmAccount.createMany.mockImplementationOnce(async (args: unknown) => {
      db.accounts.push({ ...holder, organizationId: ORG })
      return insert(args)
    })
    const entry = seedEntry()

    await applyEntry(entry.id)

    expect(db.accounts).toEqual([expect.objectContaining({ id: holder.id, organizationId: ORG })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: holder.id })
    expect(db.contacts).toEqual([expect.objectContaining({ accountId: holder.id, email: EMAIL, phoneE164: PHONE })])
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('unlinked'), expect.anything())
  })
})

describe('la casilla «Quiero recibir novedades de Avoqado por correo» (CRM fase 2, tarea 6)', () => {
  const BRENDA = 'brenda@cafe.mx'
  const RECEIVED = new Date(Date.now() - 2 * MINUTE)
  const consentEvents = () => eventsOf('FIELD_CHANGE').filter(event => event.data.campo === 'consentimiento')

  /** The real path, as the controller walks it: the raw form is saved, the signup's outcome written, the entry applied. */
  async function landingSubmit(form: Record<string, unknown>, over: { outcome?: SignupOutcome | null; receivedAt?: Date } = {}) {
    const saved = await saveLandingEntry(form)
    const entryId = saved!.entryId
    // The form reached us a couple of minutes ago: the consent dates from then, never from the moment it was applied.
    db.entries.find(entry => entry.id === entryId)!.receivedAt = over.receivedAt ?? RECEIVED
    await recordSignupOutcome(entryId, over.outcome === undefined ? NEW_SIGNUP : over.outcome)
    await applyEntry(entryId)
    return entryId
  }

  it('una_entrada_con_la_casilla_deja_el_consentimiento_de_su_correo_con_la_fecha_de_recepcion', async () => {
    const entryId = await landingSubmit({ ...FORM, email: ' Ana@Cafe.MX', marketingConsent: true, privacyNoticeVersion: '2026-11-01' })

    // The box survived the cleaning as a boolean: the entry keeps `true`, not the text «true».
    expect(db.entries[0].payload).toMatchObject({ marketingConsent: true, privacyNoticeVersion: '2026-11-01' })
    expect(db.consents).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        email: EMAIL,
        accountId: db.accounts[0].id,
        entryId,
        grantedById: null,
        consentAt: RECEIVED,
        source: 'LANDING',
        noticeVersion: '2026-11-01',
      },
    ])
    // Its trace in the account's timeline: what changed, never who (no email in it), once per entry.
    expect(consentEvents()).toEqual([
      expect.objectContaining({
        accountId: db.accounts[0].id,
        actorStaffId: null,
        sourceKey: `consent:${entryId}`,
        data: { campo: 'consentimiento' },
      }),
    ])
    expect(JSON.stringify(consentEvents())).not.toContain('cafe.mx')
  })

  it('sin_version_en_la_entrada_guarda_la_del_aviso_vigente', async () => {
    await landingSubmit({ ...FORM, marketingConsent: true })

    expect(db.consents).toEqual([expect.objectContaining({ email: EMAIL, noticeVersion: '2026-10-02' })])
  })

  it.each([
    { casilla: 'sin marcar (false)', form: { ...FORM, marketingConsent: false } },
    { casilla: 'que el formulario no trae', form: FORM },
  ])('una entrada $casilla no deja consentimiento ni evento', async ({ form }) => {
    await landingSubmit(form)

    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
    expect(db.consents).toEqual([])
    expect(consentEvents()).toEqual([])
    expect(prismaMock.crmEmailConsent.upsert).not.toHaveBeenCalled()
  })

  it('una_segunda_entrada_sin_la_casilla_no_lo_borra: no marcarla no es darse de baja', async () => {
    const first = await landingSubmit({ ...FORM, marketingConsent: true })
    const [before] = db.consents.map(consent => ({ ...consent }))

    await landingSubmit({ ...FORM, firstName: 'Ana María' }, { receivedAt: new Date(RECEIVED.getTime() + MINUTE), outcome: null })

    expect(db.entries).toHaveLength(2)
    expect(db.entries[1].appliedAt).toEqual(expect.any(Date))
    expect(db.consents).toEqual([before])
    expect(before.entryId).toBe(first)
    expect(consentEvents()).toHaveLength(1)
  })

  it('un_segundo_consentimiento_del_mismo_correo_actualiza_la_fecha_y_la_cuenta, sin crear otra fila', async () => {
    // A consent that came before the CRM had an account for this person (`accountId` null), and an older notice.
    db.consents.push({
      id: 'cconsent00000000000000001',
      email: EMAIL,
      accountId: null,
      entryId: 'centryprev000000000000001',
      consentAt: new Date(Date.now() - 40 * DAY),
      source: 'LANDING',
      noticeVersion: '2026-01-01',
      createdAt: new Date(Date.now() - 40 * DAY),
    })

    const entryId = await landingSubmit({ ...FORM, marketingConsent: true })

    expect(db.consents).toEqual([
      expect.objectContaining({
        id: 'cconsent00000000000000001',
        email: EMAIL,
        accountId: db.accounts[0].id,
        entryId,
        consentAt: RECEIVED,
        noticeVersion: '2026-10-02',
      }),
    ])
  })

  it.each(['MANUAL', 'IMPORTACION'])(
    '🔴 una fila %s (grantedById = Rafa) reescrita por la landing queda LANDING con grantedById null, su entryId y su noticeVersion',
    async source => {
      db.consents.push({
        id: 'cconsent00000000000000002',
        email: EMAIL,
        accountId: null,
        entryId: null,
        grantedById: 'cstaffrafa0000000000000001',
        consentAt: new Date(Date.now() - 40 * DAY),
        source,
        noticeVersion: 'casilla-del-equipo-v1',
        createdAt: new Date(Date.now() - 40 * DAY),
      })

      const entryId = await landingSubmit({ ...FORM, marketingConsent: true })

      expect(db.consents).toEqual([
        expect.objectContaining({ email: EMAIL, source: 'LANDING', grantedById: null, entryId, noticeVersion: '2026-10-02' }),
      ])
    },
  )

  it('la landing sigue escribiendo entryId, LANDING y su noticeVersion (vecina)', async () => {
    const entryId = await landingSubmit({ ...FORM, marketingConsent: true })
    expect(db.consents).toEqual([
      expect.objectContaining({ email: EMAIL, source: 'LANDING', entryId, noticeVersion: '2026-10-02', grantedById: null }),
    ])
  })

  it('aplicar_dos_veces_la_misma_entrada_deja_un_solo_evento: el reintento tras una caída no vuelve a escribir', async () => {
    const saved = await saveLandingEntry({ ...FORM, marketingConsent: true })
    const entryId = saved!.entryId
    db.entries[0].receivedAt = RECEIVED
    await recordSignupOutcome(entryId, NEW_SIGNUP)
    // The first run writes everything and dies before marking the entry applied; the sweep runs it again.
    prismaMock.crmInboundEntry.update.mockRejectedValueOnce(new Error('the process died before marking'))
    await applyEntry(entryId)
    expect(db.entries[0].appliedAt).toBeNull()

    await applyEntry(entryId)

    expect(db.entries[0].appliedAt).toEqual(expect.any(Date))
    expect(prismaMock.crmEmailConsent.upsert).toHaveBeenCalledTimes(1)
    expect(db.consents).toHaveLength(1)
    expect(consentEvents()).toHaveLength(1)
    expect(eventsOf('ENTRY_APPLIED')).toHaveLength(1)
  })

  it('la_entrada_de_Brenda_que_se_junta_por_telefono_con_la_cuenta_de_Ana_deja_el_consentimiento_de_Brenda_y_no_el_de_Ana', async () => {
    // Ana's account (and her contact) exist already; Brenda shares her phone, so her entry lands on Ana's account.
    const ana = seedAccount({ id: 'cacctana00000000000000001' })
    db.contacts.push({ accountId: ana.id, name: 'Ana', email: EMAIL, phoneE164: '+525512345678', isPrimary: true })

    const entryId = await landingSubmit({ ...FORM, firstName: 'Brenda', email: BRENDA, marketingConsent: true })

    expect(db.accounts).toHaveLength(1)
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: ana.id })
    expect(db.consents).toEqual([expect.objectContaining({ email: BRENDA, accountId: ana.id, entryId, consentAt: RECEIVED })])
    expect(db.consents.some(consent => consent.email === EMAIL)).toBe(false)
  })

  // D7 «Eliminar» × the box: the tombstone stops a CREATION; an old form that lands on ANOTHER account (a shared phone) is
  // still applied, but the consent of a person deleted after sending it does not come back with it.
  it.each([
    { cuando: 'después de mandar la casilla', erasedAt: new Date(Date.now() - MINUTE), queda: false },
    { cuando: 'antes de mandar la casilla', erasedAt: new Date(Date.now() - 10 * MINUTE), queda: true },
  ])('brenda_eliminada_$cuando: su entrada cae en la cuenta de Ana y su consentimiento queda=$queda', async ({ erasedAt, queda }) => {
    const ana = seedAccount({ id: 'cacctana00000000000000001' })
    db.contacts.push({ accountId: ana.id, name: 'Ana', email: EMAIL, phoneE164: '+525512345678', isPrimary: true })
    const [brendaHash] = erasedHashes({ keys: [], emails: [BRENDA], phones: [], organizationId: null }).person
    db.erased.push({ keyHash: brendaHash, scope: '', erasedAt })

    await landingSubmit({ ...FORM, firstName: 'Brenda', email: BRENDA, marketingConsent: true })

    // D7's path is unchanged: the entry is applied to Ana's account.
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: ana.id })
    expect(db.consents.some(consent => consent.email === BRENDA)).toBe(queda)
    expect(consentEvents()).toHaveLength(queda ? 1 : 0)
  })
})
