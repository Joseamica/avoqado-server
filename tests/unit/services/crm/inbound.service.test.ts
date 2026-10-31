/**
 * Landing → CRM (spec 2026-10-30 §5.3, plan task 5): the raw entry is cleaned and saved before anything else, and
 * applying it is ONE upsert by (LANDING, email) that a second run — the sweep after a crash — cannot repeat.
 *
 * What these pin beyond the happy path: PostgreSQL never sees a NUL byte; a failed save retries once and never throws;
 * the four signup outcomes each touch the account the way the spec says; an entry whose signup is still running waits;
 * and an entry applied twice leaves one set of events.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import logger from '@/config/logger'
import { notifyNewProspect } from '@/services/crm/digest.service'
import { applyEntry, recordSignupOutcome, sanitizeEntry, saveLandingEntry, type SignupOutcome } from '@/services/crm/inbound.service'

jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn() }))

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

describe('saveLandingEntry', () => {
  it('guardar_reintenta_una_vez_y_no_lanza', async () => {
    const create = prismaMock.crmInboundEntry.create
    create.mockReset()
    create.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce({ id: 'centrylnd0000000000000001' })

    await expect(saveLandingEntry({ ...FORM, email: ' Ana@Cafe.MX', businessType: 'Cafe\u0000tería' })).resolves.toEqual({
      entryId: 'centrylnd0000000000000001',
    })
    expect(create).toHaveBeenCalledTimes(2)
    // The key is the signup's own normalization of the email; the payload is the CLEAN form.
    expect(create.mock.calls[1][0].data).toEqual({
      source: 'LANDING',
      externalKey: EMAIL,
      payload: expect.objectContaining({ businessType: 'Cafetería', companyName: 'Café Ana' }),
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
          { accountId: db.accounts[0].id, name: 'Ana López', phoneE164: '+525512345678', email: EMAIL, isPrimary: true },
        ])
        expect(db.events.map(event => event.kind)).toEqual(['ENTRY_APPLIED'])
        expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id)
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
        expect(db.contacts).toHaveLength(0)
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
        expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id)
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
      expect.objectContaining({ sourceKey: `link:${db.accounts[0].id}`, data: { organizationId: ORG, organizationName: 'Café Ana S.A.' } }),
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
    const employee = seedEntry({
      externalKey: 'empleado@cafe.mx',
      payload: { ...FORM, email: 'empleado@cafe.mx' },
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
      expect(db.contacts).toHaveLength(0)
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

    // A brand-new account is nobody else's yet: no lock needed.
    prismaMock.$queryRaw.mockClear()
    const fresh = seedEntry({ externalKey: 'nueva@cafe.mx', payload: { ...FORM, email: 'nueva@cafe.mx' }, signupOutcome: null })
    await applyEntry(fresh.id)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
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
      if (announcements) expect(notifyNewProspect).toHaveBeenLastCalledWith(db.accounts[0].id)
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
    expect(db.contacts).toHaveLength(0)
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
      expect(notifyNewProspect).toHaveBeenCalledWith(db.accounts[0].id)
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
