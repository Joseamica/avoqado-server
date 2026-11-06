/**
 * C2 · Ficha editable, against a real Postgres (plan 2026-11-06). The unit tests' Prisma mock cannot prove these: the row
 * lock every writer takes, the unique `sourceKey` of an event and the order two transactions really run in live in the
 * database.
 *
 * Run with (a DISPOSABLE database, never av-db-25; in the cloud through avq-verify):
 *   TEST_DATABASE_URL='postgresql://<user>:<password>@localhost:5432/<disposable database>' \
 *     npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/ficha-editable.integration.test.ts --ci
 */
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmail: jest.fn().mockResolvedValue(true),
    sendEmailWithResult: jest.fn().mockResolvedValue({ ok: true, transient: false }),
  },
}))
jest.mock('@/services/integrations/hubspot.client', () => ({
  sendLeadToHubspot: jest.fn().mockResolvedValue(false),
  isHubspotEnabled: () => false,
}))

import { applyEntry, recordSignupOutcome, saveLandingEntry } from '@/services/crm/inbound.service'
import prisma from '@/utils/prismaClient'

const suffix = `crmf${Date.now()}`
const PHONE_BASE = String(Date.now()).slice(-6)
let phoneSeq = 0
/** Each person of this file has a phone of their own: the same phone is the same person for the CRM (ruling 48). */
const nextPhone = () => `55${PHONE_BASE}${String(++phoneSeq).padStart(2, '0')}`

const accountIds: string[] = []
const emails: string[] = []
const stageIds: string[] = []

const form = (email: string) => ({
  firstName: 'Ana',
  lastName: 'Ficha',
  phone: nextPhone(),
  email,
  companyName: `Café ${suffix}`,
  businessType: 'Cafetería',
  employees: '2',
  revenue: '500k-1m',
  modules: 'mesas',
  source: 'landing_restaurantes',
})

async function stage() {
  if (!stageIds.length) {
    stageIds.push((await prisma.crmStage.create({ data: { name: `Prospecto ${suffix}`, order: 1, kind: 'ABIERTA', staleDays: 3 } })).id)
  }
  return stageIds[0]
}

/** An account of another source with one person who has this email, as WhatsApp, HubSpot or a seller left it. */
async function accountWithPerson(email: string, over: Record<string, unknown> = {}) {
  const account = await prisma.crmAccount.create({
    data: {
      name: `Negocio ${suffix}`,
      source: 'MANUAL',
      stageId: await stage(),
      contacts: { create: { name: 'Ana', email, isPrimary: true } },
      ...over,
    },
    select: { id: true, contacts: { select: { id: true } } },
  })
  accountIds.push(account.id)
  return { accountId: account.id, contactId: account.contacts[0].id }
}

async function landingEntry(email: string) {
  emails.push(email)
  const saved = await saveLandingEntry(form(email))
  expect(saved).not.toBeNull()
  await recordSignupOutcome(saved!.entryId, null)
  return saved!.entryId
}

/** Waits until some session is blocked on a row lock of "CrmAccount" (the writer queued behind the seller). */
async function untilSomeoneWaitsForTheRow() {
  for (let i = 0; i < 100; i++) {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE "wait_event_type" = 'Lock' AND "query" LIKE '%"CrmAccount"%FOR UPDATE%'`
    if (Number(row.n) > 0) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Nobody queued behind the row lock')
}

afterAll(async () => {
  // Every delete is keyed by ids or emails this file created: never a `where` that could be undefined.
  if (emails.length) {
    await prisma.crmAccount.deleteMany({ where: { source: 'LANDING', externalKey: { in: emails } } })
    await prisma.crmInboundEntry.deleteMany({ where: { externalKey: { in: emails } } })
  }
  if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
  if (stageIds.length) await prisma.crmStage.deleteMany({ where: { id: { in: stageIds } } })
})

describe('Bloque 0A: el buscador de identidad revalida bajo el candado que la persona siga en la cuenta', () => {
  it('🔴 el vendedor le quita a X el correo mientras la entrada espera el candado: la entrada no va a X y X no recupera el correo', async () => {
    const email = `ana0a-${suffix}@test.mx`
    const { accountId, contactId } = await accountWithPerson(email)
    const entryId = await landingEntry(email)

    let applying: Promise<void> | undefined
    await prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${accountId} FOR UPDATE`
        applying = applyEntry(entryId)
        await untilSomeoneWaitsForTheRow()
        await tx.crmContact.update({ where: { id: contactId }, data: { email: `otra-${suffix}@test.mx` } })
      },
      { timeout: 20_000 },
    )
    await applying

    const entry = await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entryId } })
    expect(entry.appliedAt).not.toBeNull()
    expect(entry.accountId).not.toBe(accountId)
    const people = await prisma.crmContact.findMany({ where: { accountId }, select: { email: true }, take: 5 })
    expect(people).toEqual([{ email: `otra-${suffix}@test.mx` }])
  })

  it('sin el cambio, la misma entrada sigue yendo a X (regresión)', async () => {
    const email = `beto0a-${suffix}@test.mx`
    const { accountId } = await accountWithPerson(email)
    const entryId = await landingEntry(email)

    await applyEntry(entryId)

    expect(await prisma.crmInboundEntry.findUniqueOrThrow({ where: { id: entryId } })).toMatchObject({ accountId })
  })
})
