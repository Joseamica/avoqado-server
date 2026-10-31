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
import { getInitialStage } from '@/services/crm/accounts.service'
import { applyEntry, recordSignupOutcome, saveLandingEntry } from '@/services/crm/inbound.service'
import prisma from '@/utils/prismaClient'

const suffix = `crml${Date.now()}`
const RACE_EMAIL = `ana-${suffix}@test.mx`
const CRASH_EMAIL = `beto-${suffix}@test.mx`
const HOLDER_EMAIL = `carla-${suffix}@test.mx`
const EMAILS = [RACE_EMAIL, CRASH_EMAIL, HOLDER_EMAIL]
/** Accounts this file creates under another source (not found by `source: LANDING`). */
const otherAccountIds: string[] = []

const form = (email: string, over: Record<string, unknown> = {}) => ({
  firstName: 'Ana',
  lastName: 'Captura',
  phone: '5512345678',
  email,
  companyName: `Café ${suffix}`,
  businessType: 'Cafetería',
  employees: '2',
  revenue: '500k-1m',
  modules: 'mesas,cocina',
  source: 'landing_restaurantes',
  ...over,
})

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
    // Their OnboardingProgress goes with them (cascade).
    if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
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
    // Now as a customer: one note — the event a second run would really repeat («una sola nota por entrada», spec §7).
    await crashThenSweep({ businessType: 'Bar' }, { organizationId: null, alreadyExisted: true, yaEsCliente: true })

    expect(await prisma.crmAccount.count({ where: { source: 'LANDING', externalKey: CRASH_EMAIL } })).toBe(1)
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ giro: 'Restaurante', sucursales: 4 })
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'FIELD_CHANGE' } })).toBe(1)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'NOTE' } })).toBe(1)
    expect(await prisma.crmTimelineEvent.count({ where: { accountId: account.id, kind: 'ENTRY_APPLIED' } })).toBe(3)
  })

  it('an Organization with a CRM account of another source gets its owner’s entry on THAT account (ruling 25)', async () => {
    // A customer won through WhatsApp: their Organization already holds its one CRM account.
    const staff = await prisma.staff.create({
      data: { email: HOLDER_EMAIL, firstName: 'Carla', lastName: 'Cliente', password: 'hash', active: true, emailVerified: true },
    })
    const organization = await prisma.organization.create({ data: { name: `Cliente ${suffix}`, email: HOLDER_EMAIL, phone: '5500000000' } })
    await prisma.staffOrganization.create({
      data: { staffId: staff.id, organizationId: organization.id, role: OrgRole.OWNER, isPrimary: true, isActive: true },
    })
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
})
