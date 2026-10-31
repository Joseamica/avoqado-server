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
const TEAM_ORG = 'corgteam00000000000000001'
const EMAIL = 'ana@cafe.mx'
const MINUTE = 60_000

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
  prismaMock.staff.findUnique.mockReset()
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
    if (existing) seedAccount({ organizationId: ORG })
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

  it('never links the sales team’s own organization, nor one another account already holds', async () => {
    prismaMock.crmTeam.findUnique.mockResolvedValue({ organizationId: TEAM_ORG })
    const team = seedEntry({ signupOutcome: { organizationId: TEAM_ORG, alreadyExisted: true, yaEsCliente: true } })
    await applyEntry(team.id)
    expect(db.accounts[0].organizationId).toBeNull()

    // ORG is already some other account's (a won WhatsApp prospect): this one is created unlinked.
    db.accounts.push({ id: 'cacctwhats000000000000001', source: 'WHATSAPP', externalKey: '+525500000000', organizationId: ORG })
    const held = seedEntry({ externalKey: 'otro@cafe.mx', payload: { ...FORM, email: 'otro@cafe.mx' } })
    await applyEntry(held.id)
    const landing = db.accounts.find(account => account.externalKey === 'otro@cafe.mx')
    expect(landing).toMatchObject({ organizationId: null })
    expect(db.entries.find(entry => entry.id === held.id)).toMatchObject({ appliedAt: expect.any(Date), accountId: landing?.id })
  })

  it('sin_desenlace_y_reciente_no_aplica', async () => {
    const entry = seedEntry({ signupOutcome: null, signupResolvedAt: null, receivedAt: new Date(Date.now() - MINUTE) })

    await applyEntry(entry.id)

    // The signup is still running: nothing is guessed, nothing is written; the sweep applies it later.
    expect(prismaMock.staff.findUnique).not.toHaveBeenCalled()
    expect(db.accounts).toHaveLength(0)
    expect(db.events).toHaveLength(0)
    expect(db.entries[0].appliedAt).toBeNull()
  })

  it('sin_desenlace_viejo_resuelve_por_correo', async () => {
    // An active OWNER with that exact email: the account it has is the outcome (alreadyExisted, with its Organization).
    prismaMock.staff.findUnique.mockResolvedValue({ active: true, password: null, organizations: [{ organizationId: ORG }] })
    const owned = seedEntry({ signupOutcome: null, signupResolvedAt: null, receivedAt: new Date(Date.now() - 6 * MINUTE) })

    await applyEntry(owned.id)

    expect(prismaMock.staff.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { email: EMAIL } }))
    expect(db.accounts[0]).toMatchObject({ externalKey: EMAIL, organizationId: ORG })
    expect(eventsOf('ENTRY_APPLIED')[0].data).toMatchObject({ signup: 'EXISTING_ACCOUNT' })

    // Nobody with that email owns an Organization: the signup failed, and the account is created without one.
    prismaMock.staff.findUnique.mockResolvedValue(null)
    const orphan = seedEntry({
      externalKey: 'nadie@cafe.mx',
      payload: { ...FORM, email: 'nadie@cafe.mx' },
      signupOutcome: null,
      signupResolvedAt: null,
      receivedAt: new Date(Date.now() - 6 * MINUTE),
    })

    await applyEntry(orphan.id)

    expect(db.accounts.find(account => account.externalKey === 'nadie@cafe.mx')).toMatchObject({ organizationId: null })
    expect(eventsOf('ENTRY_APPLIED')[1].data).toMatchObject({ signup: 'SIGNUP_FAILED' })
  })

  it.each([
    { branch: 'cuenta que ya existía', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: false }, kind: 'FIELD_CHANGE' },
    // The note is what would repeat: unlike the qualification, adding it again is not a no-op.
    { branch: 'ya es cliente', outcome: { organizationId: ORG, alreadyExisted: true, yaEsCliente: true }, kind: 'NOTE' },
  ])('aplicar_dos_veces_misma_entrada_un_evento: $branch', async ({ outcome, kind }) => {
    seedAccount({ organizationId: ORG })
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
