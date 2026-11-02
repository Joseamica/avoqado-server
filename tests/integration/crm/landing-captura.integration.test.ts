/**
 * Landing → CRM against a real Postgres (spec 2026-10-30 §5.3, plan task 5). The unit tests' Prisma mock cannot prove
 * these: the unique (source, externalKey) of an account and the unique `sourceKey` of its events live in the database,
 * and so does the race between two real signups with the same email.
 *
 * Run with:
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/landing-captura.integration.test.ts --ci
 */
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmail: jest.fn().mockResolvedValue(true),
    sendEmailWithResult: jest.fn().mockResolvedValue({ ok: true, transient: false }),
  },
}))
// The landing mirrors every lead to HubSpot when the environment has its keys: never from a test.
jest.mock('@/services/integrations/hubspot.client', () => ({
  sendLeadToHubspot: jest.fn().mockResolvedValue(false),
  isHubspotEnabled: () => false,
}))

import { OrgRole } from '@prisma/client'
import type { NextFunction, Request, Response } from 'express'
import { submitContact } from '@/controllers/public/landing.public.controller'
import type { CrmAccess } from '@/services/crm/access.service'
import { getInitialStage, win } from '@/services/crm/accounts.service'
import { applyEntry, recordSignupOutcome, saveLandingEntry, upsertAccountBySource } from '@/services/crm/inbound.service'
import { linkLandingAccounts, resetSweepCursors } from '@/services/crm/sweep.service'
import { canonicalPhoneE164 } from '@/utils/phone'
import prisma from '@/utils/prismaClient'

const suffix = `crml${Date.now()}`
const RACE_EMAIL = `ana-${suffix}@test.mx`
const CRASH_EMAIL = `beto-${suffix}@test.mx`
const HOLDER_EMAIL = `carla-${suffix}@test.mx`
const WHATSAPP_EMAIL = `dani-${suffix}@test.mx`
const LATE_EMAIL = `eva-${suffix}@test.mx`
const LINK_EMAIL = `fer-${suffix}@test.mx`
/** The person whose LANDING account the backfill created without an entry (Codex exhaustiva #3). */
const KEY_EMAIL = `gil-${suffix}@test.mx`
/** The emails of six forms on one account; only the first one (the oldest) ever owns a business (Codex r3, R3-1). */
const RESENT_EMAILS = [1, 2, 3, 4, 5, 6].map(n => `reenvio${n}-${suffix}@test.mx`)
/** Ruling 65: the resolver every writer shares (Codex exhaustiva #4, #5 and #6). */
const ORG_FIRST_EMAIL = `hugo-${suffix}@test.mx`
const RANK_EMAIL = `iris-${suffix}@test.mx`
const CLASH_EMAIL = `juan-${suffix}@test.mx`
const WIN_RACE_EMAIL = `karla-${suffix}@test.mx`
const KEY_TAKEN_EMAIL = `luis-${suffix}@test.mx`
/** A customer of business X who opens business Y through the landing (ruling 71). */
const SECOND_BUSINESS_EMAIL = `mara-${suffix}@test.mx`
const EMAILS = [
  RACE_EMAIL,
  CRASH_EMAIL,
  HOLDER_EMAIL,
  WHATSAPP_EMAIL,
  LATE_EMAIL,
  LINK_EMAIL,
  KEY_EMAIL,
  ...RESENT_EMAILS,
  ORG_FIRST_EMAIL,
  RANK_EMAIL,
  CLASH_EMAIL,
  WIN_RACE_EMAIL,
  KEY_TAKEN_EMAIL,
  SECOND_BUSINESS_EMAIL,
]
/** Organizations this file creates that no person of it owns. */
const otherOrganizationIds: string[] = []
/** Accounts this file creates under another source (not found by `source: LANDING`). */
const otherAccountIds: string[] = []

/**
 * Each person of this file has a phone of their own, new on every run: the same phone is the same person for the CRM
 * (ruling 48), so a shared one would land one test's form on another test's account.
 */
const PHONE_BASE = String(Date.now()).slice(-7)
const phoneOf = (email: string) => `55${PHONE_BASE}${EMAILS.indexOf(email)}`

const form = (email: string, over: Record<string, unknown> = {}) => ({
  firstName: 'Ana',
  lastName: 'Captura',
  phone: phoneOf(email),
  email,
  companyName: `Café ${suffix}`,
  businessType: 'Cafetería',
  employees: '2',
  revenue: '500k-1m',
  modules: 'mesas,cocina',
  source: 'landing_restaurantes',
  ...over,
})

/** A person with a password who owns an Organization: a customer for the CRM (ruling 27). */
async function ownerOfAnOrganization(email: string) {
  const staff = await prisma.staff.create({
    data: { email, firstName: 'Ana', lastName: 'Dueña', password: 'hash', active: true, emailVerified: true },
  })
  const organization = await prisma.organization.create({ data: { name: `Negocio ${suffix}`, email, phone: '5500000000' } })
  await prisma.staffOrganization.create({
    data: { staffId: staff.id, organizationId: organization.id, role: OrgRole.OWNER, isPrimary: true, isActive: true },
  })
  return { staff, organization }
}

async function submit(email: string) {
  const req = { body: form(email) } as Request
  const res = { statusCode: 200 } as Response & { body?: unknown }
  res.status = ((statusCode: number) => {
    res.statusCode = statusCode
    return res
  }) as Response['status']
  res.json = ((body: unknown) => {
    res.body = body
    return res
  }) as Response['json']
  const next = jest.fn() as NextFunction
  await submitContact(req, res, next)
  expect(next).not.toHaveBeenCalled()
  return res
}

describe('landing → CRM against Postgres', () => {
  afterAll(async () => {
    // Every delete is keyed by the emails this file made up: never a `where` that could be undefined. Deleting the
    // accounts cascades to their people and their timeline.
    await prisma.crmAccount.deleteMany({ where: { source: 'LANDING', externalKey: { in: EMAILS } } })
    if (otherAccountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: otherAccountIds } } })
    await prisma.crmInboundEntry.deleteMany({ where: { externalKey: { in: EMAILS } } })
    const people = await prisma.staff.findMany({
      where: { email: { in: EMAILS } },
      select: { id: true, organizations: { select: { organizationId: true }, take: 5 } },
      take: EMAILS.length,
    })
    const staffIds = people.map(person => person.id)
    const organizationIds = people.flatMap(person => person.organizations.map(membership => membership.organizationId))
    if (staffIds.length) {
      await prisma.activityLog.deleteMany({ where: { staffId: { in: staffIds } } })
      await prisma.staffOrganization.deleteMany({ where: { staffId: { in: staffIds } } })
      await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
    }
    // The accounts of a person's second business (ruling 71) are keyed `<email>|<organization>`: deleted by that business.
    if (organizationIds.length) await prisma.crmAccount.deleteMany({ where: { organizationId: { in: organizationIds } } })
    // Their OnboardingProgress goes with them (cascade).
    if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
    if (otherOrganizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: otherOrganizationIds } } })
  })

  it('dos_formularios_mismo_correo_una_ficha_ligada', async () => {
    // The real signup, twice at once with the same new email: one creates the account; the other loses the race (or
    // finds it already there). Neither answer changes.
    const answers = await Promise.all([submit(RACE_EMAIL), submit(RACE_EMAIL)])
    answers.forEach(answer => expect(answer.statusCode).toBe(200))

    const owner = await prisma.staff.findUniqueOrThrow({
      where: { email: RACE_EMAIL },
      select: { organizations: { where: { role: OrgRole.OWNER }, select: { organizationId: true }, take: 5 } },
    })
    expect(owner.organizations).toHaveLength(1)

    const accounts = await prisma.crmAccount.findMany({ where: { source: 'LANDING', externalKey: RACE_EMAIL }, take: 5 })
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ organizationId: owner.organizations[0].organizationId, giro: 'Cafetería', sucursales: 2 })

    const entries = await prisma.crmInboundEntry.findMany({ where: { externalKey: RACE_EMAIL }, take: 5 })
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry).toMatchObject({ appliedAt: expect.any(Date), accountId: accounts[0].id })
      expect(await prisma.crmTimelineEvent.count({ where: { sourceKey: `entry:${entry.id}` } })).toBe(1)
    }
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: accounts[0].id, kind: 'ENTRY_APPLIED' } })).toBe(2)
    expect(await prisma.crmContact.count({ where: { accountId: accounts[0].id } })).toBe(1)
  })

  it('caida_entre_aplicar_y_marcar_no_duplica', async () => {
    // An account the CRM already has: the first form, applied as usual (its signup failed, so no Organization).
    const first = await saveLandingEntry(form(CRASH_EMAIL, { businessType: 'Cafetería', employees: '1' }))
    expect(first).not.toBeNull()
    await recordSignupOutcome(first!.entryId, null)
    await applyEntry(first!.entryId)
    const account = await prisma.crmAccount.findUniqueOrThrow({
      where: { source_externalKey: { source: 'LANDING', externalKey: CRASH_EMAIL } },
    })

    /**
     * The same person comes back. The account and its events are written; then the process «dies» before the entry is
     * marked applied, and the sweep applies it again — with the same function (ruling 20).
     */
    async function crashThenSweep(
      over: Record<string, unknown>,
      outcome: { organizationId: null; alreadyExisted: true; yaEsCliente: boolean },
    ) {
      const saved = await saveLandingEntry(form(CRASH_EMAIL, over))
      expect(saved).not.toBeNull()
      await recordSignupOutcome(saved!.entryId, outcome)
      const crash = jest.spyOn(prisma.crmInboundEntry, 'update').mockRejectedValueOnce(new Error('the process died before marking'))
      await applyEntry(saved!.entryId)
      crash.mockRestore()
      const stuck = await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: saved!.entryId } })
      expect(stuck).toMatchObject({ appliedAt: null, lastError: expect.stringContaining('died') })

      await applyEntry(saved!.entryId)

      expect(await prisma.crmTimelineEvent.count({ where: { sourceKey: `entry:${saved!.entryId}` } })).toBe(1)
      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: saved!.entryId } })).toMatchObject({
        appliedAt: expect.any(Date),
        accountId: account.id,
        lastError: null,
      })
    }

    // New data on an account that already existed: its qualification changes once.
    await crashThenSweep(
      { businessType: 'Restaurante', employees: '4' },
      { organizationId: null, alreadyExisted: true, yaEsCliente: false },
    )
    // Now as a customer — who, for the CRM, owns an Organization (ruling 27): one note, the event a second run would
    // really repeat («una sola nota por entrada», spec §7).
    await ownerOfAnOrganization(CRASH_EMAIL)
    await crashThenSweep({ businessType: 'Bar' }, { organizationId: null, alreadyExisted: true, yaEsCliente: true })

    expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: CRASH_EMAIL } })).toBe(1)
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ giro: 'Restaurante', sucursales: 4 })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'FIELD_CHANGE' } })).toBe(1)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'NOTE' } })).toBe(1)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'ENTRY_APPLIED' } })).toBe(3)
  })

  it('an Organization with a CRM account of another source gets its owner’s entry on THAT account (ruling 25)', async () => {
    // A customer won through WhatsApp: their Organization already holds its one CRM account.
    const { organization } = await ownerOfAnOrganization(HOLDER_EMAIL)
    const whatsapp = await prisma.crmAccount.create({
      data: {
        name: `Cliente ${suffix}`,
        source: 'WHATSAPP',
        externalKey: `+52${String(Date.now()).slice(-10)}`,
        stageId: (await getInitialStage()).id,
        organizationId: organization.id,
      },
    })
    otherAccountIds.push(whatsapp.id)

    // The customer fills the landing form.
    const entry = await saveLandingEntry(form(HOLDER_EMAIL))
    expect(entry).not.toBeNull()
    await recordSignupOutcome(entry!.entryId, { organizationId: organization.id, alreadyExisted: true, yaEsCliente: true })
    await applyEntry(entry!.entryId)

    // No second account: one note and the entry's ENTRY_APPLIED on the WhatsApp one.
    expect(await prisma.crmAccount.count({ where: { OR: [{ externalKey: HOLDER_EMAIL }, { organizationId: organization.id }] } })).toBe(1)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: whatsapp.id, kind: 'NOTE' } })).toBe(1)
    expect(await prisma.crmTimelineEvent.findUniqueOrThrow({ where: { sourceKey: `entry:${entry!.entryId}` } })).toMatchObject({
      accountId: whatsapp.id,
    })
    expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({
      appliedAt: expect.any(Date),
      accountId: whatsapp.id,
    })
  })

  it('whatsapp_luego_landing_mismo_telefono_una_ficha: the real signup lands on the WhatsApp account and links it (ruling 48)', async () => {
    // The routine created the prospect from the chat, by phone, with no email.
    const phone = canonicalPhoneE164(phoneOf(WHATSAPP_EMAIL))
    expect(phone).toMatch(/^\+52\d{10}$/)
    const whatsapp = await prisma.crmAccount.create({
      data: {
        name: `WhatsApp ${suffix}`,
        source: 'WHATSAPP',
        externalKey: phone,
        stageId: (await getInitialStage()).id,
        lastTouchAt: new Date(Date.now() - 3 * 86_400_000),
        contacts: { create: [{ name: 'Dani', phoneE164: phone, isPrimary: true }] },
      },
    })
    otherAccountIds.push(whatsapp.id)

    // Now the person signs up through the landing, with the same phone and an email the CRM has never seen.
    expect((await submit(WHATSAPP_EMAIL)).statusCode).toBe(200)

    const owner = await prisma.staff.findUniqueOrThrow({
      where: { email: WHATSAPP_EMAIL },
      select: { organizations: { where: { role: OrgRole.OWNER }, select: { organizationId: true }, take: 5 } },
    })
    expect(owner.organizations).toHaveLength(1)
    // ONE account: no landing account of that email, and the WhatsApp one now holds the new Organization.
    expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: WHATSAPP_EMAIL } })).toBe(0)
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: whatsapp.id } })).toMatchObject({
      organizationId: owner.organizations[0].organizationId,
      giro: 'Cafetería',
    })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: whatsapp.id, kind: 'LINKED' } })).toBe(1)
    const entries = await prisma.crmInboundEntry.findMany({ where: { externalKey: WHATSAPP_EMAIL }, take: 5 })
    expect(entries).toEqual([expect.objectContaining({ appliedAt: expect.any(Date), accountId: whatsapp.id })])
    expect(await prisma.crmTimelineEvent.findUniqueOrThrow({ where: { sourceKey: `entry:${entries[0].id}` } })).toMatchObject({
      accountId: whatsapp.id,
    })
  })

  it('whatsapp_alta_fallida_y_negocio_despues_el_barrido_la_liga (ruling 57, Codex r2 R2-1)', async () => {
    // WhatsApp met the person first: phone, no email.
    const phone = canonicalPhoneE164(phoneOf(LINK_EMAIL))
    const whatsapp = await prisma.crmAccount.create({
      data: {
        name: `WhatsApp ${suffix} 2`,
        source: 'WHATSAPP',
        externalKey: phone,
        stageId: (await getInitialStage()).id,
        contacts: { create: [{ name: 'Fer', phoneE164: phone, isPrimary: true }] },
      },
    })
    otherAccountIds.push(whatsapp.id)

    // The landing, same phone and a new email; the signup FAILS, so there is nothing to link yet.
    const entry = await saveLandingEntry(form(LINK_EMAIL))
    expect(entry).not.toBeNull()
    await recordSignupOutcome(entry!.entryId, null)
    await applyEntry(entry!.entryId)

    expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: LINK_EMAIL } })).toBe(0)
    // The email stays with the person — on the same contact, not a second one.
    expect(await prisma.crmContact.findMany({ where: { accountId: whatsapp.id }, take: 5 })).toEqual([
      expect.objectContaining({ phoneE164: phone, email: LINK_EMAIL }),
    ])

    // Days later the person opens their business through the dashboard.
    const { organization } = await ownerOfAnOrganization(LINK_EMAIL)

    // The sweep's late link starts from the applied entry, whatever the account's source. It walks pages of 200 over the
    // shared database: a few passes reach this account wherever it sits.
    resetSweepCursors()
    for (let pass = 0; pass < 10; pass++) {
      await linkLandingAccounts()
      if ((await prisma.crmAccount.findUniqueOrThrow({ where: { id: whatsapp.id } })).organizationId) break
    }

    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: whatsapp.id } })).toMatchObject({ organizationId: organization.id })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: whatsapp.id, kind: 'LINKED' } })).toBe(1)
  })

  it('enlace_tardio_lee_todos_los_correos_y_la_llave (Codex r3 R3-1 y exhaustiva #3): the SQL of the evidence, against Postgres', async () => {
    const stageId = (await getInitialStage()).id
    // A LANDING account the backfill created: its key is the email, and no entry ever reached it.
    const byKey = await prisma.crmAccount.create({
      data: { name: `Llave ${suffix}`, source: 'LANDING', externalKey: KEY_EMAIL, stageId },
    })
    // A WhatsApp account that took six forms of six emails, the oldest first.
    const resent = await prisma.crmAccount.create({
      data: { name: `Reenvíos ${suffix}`, source: 'WHATSAPP', externalKey: `+52${String(Date.now()).slice(-10)}`, stageId },
    })
    otherAccountIds.push(resent.id)
    for (const [n, email] of RESENT_EMAILS.entries()) {
      const at = new Date(Date.now() - (10 - n) * 3_600_000)
      await prisma.crmInboundEntry.create({
        data: { source: 'LANDING', externalKey: email, payload: { email }, receivedAt: at, appliedAt: at, accountId: resent.id },
      })
    }
    // Only the key's person and the oldest form's person open a business.
    const { organization: keyOrganization } = await ownerOfAnOrganization(KEY_EMAIL)
    const { organization: resentOrganization } = await ownerOfAnOrganization(RESENT_EMAILS[0])
    await prisma.staff.create({ data: { email: RESENT_EMAILS[5], firstName: 'Seis', lastName: 'Sin negocio' } })

    resetSweepCursors()
    for (let pass = 0; pass < 10; pass++) {
      await linkLandingAccounts()
      const [a, b] = await Promise.all([
        prisma.crmAccount.findUniqueOrThrow({ where: { id: byKey.id } }),
        prisma.crmAccount.findUniqueOrThrow({ where: { id: resent.id } }),
      ])
      if (a.organizationId && b.organizationId) break
    }

    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: byKey.id } })).toMatchObject({ organizationId: keyOrganization.id })
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: resent.id } })).toMatchObject({
      organizationId: resentOrganization.id,
    })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: { in: [byKey.id, resent.id] }, kind: 'LINKED' } })).toBe(2)
  })

  it('una_entrada_vieja_reparada_tarde_no_pisa_la_mas_nueva ni mueve el toque a «ahora» (ruling 50)', async () => {
    const older = await saveLandingEntry(form(LATE_EMAIL, { revenue: 'menos de 100k', businessType: 'Bar' }))
    const newer = await saveLandingEntry(form(LATE_EMAIL, { revenue: '500k-1m', businessType: 'Cafetería' }))
    expect(older).not.toBeNull()
    expect(newer).not.toBeNull()
    const T1 = new Date(Date.now() - 2 * 3_600_000)
    const T2 = new Date(Date.now() - 3_600_000)
    await prisma.crmInboundEntry.update({ where: { id: older!.entryId }, data: { receivedAt: T1 } })
    await prisma.crmInboundEntry.update({ where: { id: newer!.entryId }, data: { receivedAt: T2 } })

    // The older form failed to apply; the newer one applied. Then the sweep repairs the older one.
    await recordSignupOutcome(newer!.entryId, null)
    await applyEntry(newer!.entryId)
    await recordSignupOutcome(older!.entryId, null)
    await applyEntry(older!.entryId)

    const account = await prisma.crmAccount.findUniqueOrThrow({
      where: { source_externalKey: { source: 'LANDING', externalKey: LATE_EMAIL } },
    })
    expect(account).toMatchObject({ ventasRango: '500k-1m', giro: 'Cafetería', qualifiedAt: T2, lastTouchAt: T2 })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'FIELD_CHANGE' } })).toBe(0)
    // Its story is in the timeline: applied, without overwriting.
    const proof = await prisma.crmTimelineEvent.findUniqueOrThrow({ where: { sourceKey: `entry:${older!.entryId}` } })
    expect(proof).toMatchObject({ accountId: account.id, data: expect.objectContaining({ qualificationSkipped: true }) })
    expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: older!.entryId } })).toMatchObject({
      appliedAt: expect.any(Date),
      accountId: account.id,
    })
  })

  describe('ruling 65: one identity resolver for every writer', () => {
    it('la_organizacion_gana_a_la_llave_landing (Codex exhaustiva #5): the business a seller linked takes the entry', async () => {
      const stageId = (await getInitialStage()).id
      // The person's old landing account, never linked; then a seller won their business through WhatsApp.
      const landing = await prisma.crmAccount.create({
        data: { name: `Vieja ${suffix}`, source: 'LANDING', externalKey: ORG_FIRST_EMAIL, stageId },
      })
      const { organization } = await ownerOfAnOrganization(ORG_FIRST_EMAIL)
      const won = await prisma.crmAccount.create({
        data: {
          name: `Ganada ${suffix}`,
          source: 'WHATSAPP',
          externalKey: `wa-${suffix}-ganada`,
          stageId,
          organizationId: organization.id,
        },
      })
      otherAccountIds.push(won.id)

      const entry = await saveLandingEntry(form(ORG_FIRST_EMAIL))
      await recordSignupOutcome(entry!.entryId, { organizationId: organization.id, alreadyExisted: true, yaEsCliente: false })
      await applyEntry(entry!.entryId)

      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({
        appliedAt: expect.any(Date),
        accountId: won.id,
      })
      // The landing account is left as it was: nothing merged, nothing written.
      expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({ organizationId: null, giro: null })
      expect(await prisma.crmTimelineEvent.count({ where: { accountId: landing.id } })).toBe(0)
    })

    it('el_correo_gana_aunque_veinte_cuentas_compartan_el_telefono (Codex exhaustiva #4): ranked in the query, not after a cut', async () => {
      const stageId = (await getInitialStage()).id
      const phone = canonicalPhoneE164(phoneOf(RANK_EMAIL))!
      // Twenty accounts with the person's phone, all touched more recently than the one with their exact email.
      for (let n = 0; n < 20; n++) {
        const shared = await prisma.crmAccount.create({
          data: {
            name: `Teléfono ${suffix} ${n}`,
            source: 'WHATSAPP',
            externalKey: `wa-${suffix}-rank-${n}`,
            stageId,
            lastTouchAt: new Date(Date.now() - n * 60_000),
            contacts: { create: [{ name: 'Iris', phoneE164: phone }] },
          },
        })
        otherAccountIds.push(shared.id)
      }
      const byEmail = await prisma.crmAccount.create({
        data: {
          name: `Correo ${suffix}`,
          source: 'MANUAL',
          stageId,
          lastTouchAt: new Date(Date.now() - 30 * 86_400_000),
          contacts: { create: [{ name: 'Iris', email: RANK_EMAIL }] },
        },
      })
      otherAccountIds.push(byEmail.id)

      const entry = await saveLandingEntry(form(RANK_EMAIL))
      await recordSignupOutcome(entry!.entryId, null)
      await applyEntry(entry!.entryId)

      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({ accountId: byEmail.id })
      expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: RANK_EMAIL } })).toBe(0)
    })

    it('la_llave_que_un_ganar_liga_a_otro_negocio_no_recibe_la_entrada (H1, ruling 71): checked under the lock', async () => {
      const stageId = (await getInitialStage()).id
      const landing = await prisma.crmAccount.create({
        data: { name: `Llave tomada ${suffix}`, source: 'LANDING', externalKey: KEY_TAKEN_EMAIL, stageId },
      })
      const { organization } = await ownerOfAnOrganization(KEY_TAKEN_EMAIL)
      const other = await prisma.organization.create({
        data: { name: `Otro negocio ${suffix}`, email: `otro-${suffix}@test.mx`, phone: '5500000001' },
      })
      otherOrganizationIds.push(other.id)
      const entry = await saveLandingEntry(form(KEY_TAKEN_EMAIL))
      await recordSignupOutcome(entry!.entryId, { organizationId: organization.id, alreadyExisted: true, yaEsCliente: false })

      // A seller wins that landing account for another business, holding its row while the form waits for the lock.
      let release!: () => void
      const released = new Promise<void>(resolve => (release = resolve))
      let locked!: () => void
      const isLocked = new Promise<void>(resolve => (locked = resolve))
      const seller = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${landing.id} FOR UPDATE`
        await tx.crmAccount.update({ where: { id: landing.id }, data: { organizationId: other.id } })
        locked()
        await released
      })
      await isLocked
      const applying = applyEntry(entry!.entryId)
      await new Promise(resolve => setTimeout(resolve, 300))
      release()
      await seller
      await applying

      // Nothing of the person or the form lands on the other business: the person's own business gets its own account.
      const mine = await prisma.crmAccount.findUniqueOrThrow({
        where: { source_externalKey: { source: 'LANDING', externalKey: `${KEY_TAKEN_EMAIL}|${organization.id}` } },
      })
      expect(mine).toMatchObject({ organizationId: organization.id, giro: 'Cafetería' })
      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({
        appliedAt: expect.any(Date),
        accountId: mine.id,
        lastError: null,
      })
      expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: landing.id } })).toMatchObject({
        organizationId: other.id,
        giro: null,
      })
      expect(await prisma.crmContact.count({ where: { accountId: landing.id } })).toBe(0)
      expect(await prisma.crmTimelineEvent.count({ where: { accountId: landing.id } })).toBe(0)
    })

    it('segundo_negocio_tiene_su_propia_ficha (ruling 71): applied once, linked to the new business, never retried', async () => {
      const stageId = (await getInitialStage()).id
      // The customer's landing account belongs to business X; now they own business Y and fill the landing for it.
      const x = await prisma.organization.create({
        data: { name: `Negocio X ${suffix}`, email: `x-${suffix}@test.mx`, phone: '5500000002' },
      })
      otherOrganizationIds.push(x.id)
      const first = await prisma.crmAccount.create({
        data: { name: `Primer negocio ${suffix}`, source: 'LANDING', externalKey: SECOND_BUSINESS_EMAIL, stageId, organizationId: x.id },
      })
      const { organization: y } = await ownerOfAnOrganization(SECOND_BUSINESS_EMAIL)

      const entry = await saveLandingEntry(form(SECOND_BUSINESS_EMAIL))
      await recordSignupOutcome(entry!.entryId, { organizationId: y.id, alreadyExisted: true, yaEsCliente: false })
      await applyEntry(entry!.entryId)

      const second = await prisma.crmAccount.findUniqueOrThrow({
        where: { source_externalKey: { source: 'LANDING', externalKey: `${SECOND_BUSINESS_EMAIL}|${y.id}` } },
      })
      expect(second).toMatchObject({ organizationId: y.id, giro: 'Cafetería' })
      expect(await prisma.crmContact.findMany({ where: { accountId: second.id }, take: 5 })).toEqual([
        expect.objectContaining({ email: SECOND_BUSINESS_EMAIL, isPrimary: true }),
      ])
      // Applied: the sweep never takes it again.
      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({
        appliedAt: expect.any(Date),
        accountId: second.id,
        lastError: null,
      })
      // Business X's account is left as it was.
      expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ organizationId: x.id, giro: null })
      expect(await prisma.crmTimelineEvent.count({ where: { accountId: first.id } })).toBe(0)

      // The same entry again, and another form for Y: still the same two accounts.
      await applyEntry(entry!.entryId)
      const again = await saveLandingEntry(form(SECOND_BUSINESS_EMAIL))
      await recordSignupOutcome(again!.entryId, { organizationId: y.id, alreadyExisted: true, yaEsCliente: false })
      await applyEntry(again!.entryId)
      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: again!.entryId } })).toMatchObject({ accountId: second.id })
      expect(await prisma.crmAccount.count({ where: { OR: [{ id: first.id }, { organizationId: y.id }] } })).toBe(2)
      expect(await prisma.crmTimelineEvent.count({ where: { sourceKey: `entry:${entry!.entryId}` } })).toBe(1)
    })

    it('crear_con_una_organizacion_ocupada_devuelve_al_titular (Codex exhaustiva #6): never a second, unlinked account', async () => {
      const stageId = (await getInitialStage()).id
      const { organization } = await ownerOfAnOrganization(CLASH_EMAIL)
      const holder = await prisma.crmAccount.create({
        data: { name: `Titular ${suffix}`, source: 'MANUAL', stageId, organizationId: organization.id },
      })
      otherAccountIds.push(holder.id)

      const result = await prisma.$transaction(tx =>
        upsertAccountBySource(tx, {
          source: 'LANDING',
          externalKey: CLASH_EMAIL,
          data: { name: `Nueva ${suffix}`, stageId, organizationId: organization.id },
          contact: { name: 'Juan', email: CLASH_EMAIL, isPrimary: true },
        }),
      )

      expect(result).toEqual({ account: { id: holder.id, organizationId: organization.id }, created: false })
      expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: CLASH_EMAIL } })).toBe(0)
      expect(await prisma.crmContact.count({ where: { accountId: holder.id } })).toBe(0)
    })

    it('ganar_y_la_landing_a_la_vez_no_dejan_ficha_huerfana (Codex exhaustiva #5 y #6): one account holds the business', async () => {
      const stageId = (await getInitialStage()).id
      const { staff, organization } = await ownerOfAnOrganization(WIN_RACE_EMAIL)
      // A seller's prospect for that business, still unlinked; the owner fills the form while the seller wins it.
      const prospect = await prisma.crmAccount.create({ data: { name: `Prospecto ${suffix}`, source: 'MANUAL', stageId } })
      otherAccountIds.push(prospect.id)
      const entry = await saveLandingEntry(form(WIN_RACE_EMAIL))
      await recordSignupOutcome(entry!.entryId, { organizationId: organization.id, alreadyExisted: true, yaEsCliente: false })
      const seller: CrmAccess = {
        staffId: staff.id,
        isSuperadmin: false,
        ver: 'todos',
        editar: 'todos',
        contactar: true,
        campanas: false,
        exportar: false,
        ventas: false,
        admin: false,
      }

      await Promise.allSettled([win(seller, prospect.id, { organizationId: organization.id }), applyEntry(entry!.entryId)])
      // The sweep retries an entry that lost the race.
      await applyEntry(entry!.entryId)

      // Whoever won, ONE account holds the business, the entry is on it, and no landing account of the person is left
      // without it.
      const holders = await prisma.crmAccount.findMany({ where: { organizationId: organization.id }, take: 5 })
      expect(holders).toHaveLength(1)
      expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entry!.entryId } })).toMatchObject({
        appliedAt: expect.any(Date),
        accountId: holders[0].id,
      })
      expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: WIN_RACE_EMAIL, organizationId: null } })).toBe(0)
    })
  })
})
