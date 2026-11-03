/**
 * «Eliminar» a CRM account against a real Postgres (D7). The unit tests' Prisma mock cannot prove these: the row lock the
 * deletion and the resolver share, the tombstone's unique (keyHash, scope) and what READ COMMITTED lets a writer see after
 * the deletion commits. Promesa y Codex: Avoqado/docs/audit/2026-11-02-crm-eliminar-prospecto/.
 *
 * Run with (the cloud creates and migrates its own database):
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/eliminar.integration.test.ts --ci
 */
jest.mock('@/services/email.service', () => ({
  __esModule: true,
  default: {
    sendEmail: jest.fn().mockResolvedValue(true),
    sendEmailWithResult: jest.fn().mockResolvedValue({ ok: true, transient: false }),
  },
}))

import type { CrmAccess } from '@/services/crm/access.service'
import { getInitialStage } from '@/services/crm/accounts.service'
import { correrEnvioDeCampanas } from '@/services/crm/email/campaignSender.service'
import { deleteAccount, erasedHashes, ErasedIdentityError } from '@/services/crm/erase.service'
import emailService from '@/services/email.service'
import { accountForTx, applyEntry, LANDING, recordSignupOutcome, saveLandingEntry } from '@/services/crm/inbound.service'
import { canonicalPhoneE164 } from '@/utils/phone'
import { env } from '@/config/env'
import prisma from '@/utils/prismaClient'

const suffix = `crme${Date.now()}`
const RACE_EMAIL = `ana-${suffix}@test.mx`
const BACK_EMAIL = `beto-${suffix}@test.mx`
const SHARED_EMAIL = `carla-${suffix}@test.mx`
const OTHER_EMAIL = `dani-${suffix}@test.mx`
const MAIL_EMAIL = `elena-${suffix}@test.mx`
const SENDING_EMAIL = `fer-${suffix}@test.mx`
const CONSENT_ONLY_EMAIL = `gaby-${suffix}@test.mx`
const EMAILS = [RACE_EMAIL, BACK_EMAIL, SHARED_EMAIL, OTHER_EMAIL, MAIL_EMAIL, SENDING_EMAIL, CONSENT_ONLY_EMAIL]
const send = emailService.sendEmailWithResult as jest.Mock
const ENV = { ...process.env }
const PHONE_BASE = String(Date.now()).slice(-7)
const phoneOf = (email: string) => `55${PHONE_BASE}${EMAILS.indexOf(email)}`

let founder: CrmAccess
const organizationIds: string[] = []

/** A form of the landing, saved and with its signup resolved (it failed: a prospect), not applied yet. */
async function savedEntry(email: string, phone = phoneOf(email), extra: Record<string, unknown> = {}) {
  const saved = await saveLandingEntry({ firstName: 'Ana', lastName: 'Eliminar', phone, email, companyName: `Café ${email}`, ...extra })
  if (!saved) throw new Error('The entry was not saved')
  await recordSignupOutcome(saved.entryId, null)
  return saved.entryId
}

const accountOf = (email: string) =>
  prisma.crmAccount.findUnique({ where: { source_externalKey: { source: LANDING, externalKey: email } }, select: { id: true, name: true } })

beforeAll(async () => {
  const staff = await prisma.staff.create({ data: { email: `founder-${suffix}@test.mx`, firstName: 'Founder', lastName: 'Eliminar' } })
  founder = {
    staffId: staff.id,
    isSuperadmin: true,
    ver: 'todos',
    editar: 'todos',
    contactar: true,
    campanas: true,
    exportar: true,
    ventas: true,
    admin: true,
  }
  await getInitialStage()
})

afterEach(() => {
  if (ENV.CRM_CORREO_PRUEBAS === undefined) delete process.env.CRM_CORREO_PRUEBAS
  else process.env.CRM_CORREO_PRUEBAS = ENV.CRM_CORREO_PRUEBAS
})

afterAll(async () => {
  // Every delete is keyed by what this file created: a `where` with an undefined value would wipe the table.
  await prisma.crmCampaign.deleteMany({ where: { name: `Eliminar ${suffix}` } })
  await prisma.crmEmailConsent.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.crmAccount.deleteMany({ where: { source: LANDING, externalKey: { in: EMAILS } } })
  await prisma.crmInboundEntry.deleteMany({ where: { externalKey: { in: EMAILS } } })
  const hashes = EMAILS.flatMap(email => {
    const { person } = erasedHashes({
      keys: [{ source: LANDING, externalKey: email }],
      emails: [email],
      phones: [canonicalPhoneE164(phoneOf(email))!],
      organizationId: null,
    })
    return person
  })
  const orgHashes = organizationIds.map(id => erasedHashes({ keys: [], emails: [], phones: [], organizationId: id }).organization!)
  await prisma.crmErased.deleteMany({ where: { keyHash: { in: [...hashes, ...orgHashes] } } })
  if (founder) {
    await prisma.activityLog.deleteMany({ where: { staffId: founder.staffId } })
    await prisma.staff.deleteMany({ where: { id: founder.staffId } })
  }
  if (organizationIds.length) await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } })
})

describe('«Eliminar» against Postgres', () => {
  it('eliminar_y_una_entrada_vieja_a_la_vez: no queda negocio ni entrada, sea quien sea el que llegue primero', async () => {
    await applyEntry(await savedEntry(RACE_EMAIL))
    const account = await accountOf(RACE_EMAIL)
    expect(account).not.toBeNull()
    // A form of the same person, sent before the deletion, applied at the same instant.
    const late = await savedEntry(RACE_EMAIL)

    const [deleted] = await Promise.allSettled([deleteAccount(founder, account!.id, account!.name), applyEntry(late)])
    expect(deleted.status).toBe('fulfilled')
    // The sweep's next pass, if that entry lost its mark in the race.
    await applyEntry(late)

    expect(await accountOf(RACE_EMAIL)).toBeNull()
    expect(await prisma.crmInboundEntry.count({ where: { externalKey: RACE_EMAIL } })).toBe(0)
    const log = await prisma.activityLog.findFirst({
      where: { staffId: founder.staffId, action: 'CRM_ACCOUNT_DELETED', entityId: account!.id },
    })
    expect(JSON.stringify(log?.data)).not.toContain(RACE_EMAIL)
  })

  it('una_entrada_nueva_despues_de_eliminar_si_entra', async () => {
    await applyEntry(await savedEntry(BACK_EMAIL))
    const account = await accountOf(BACK_EMAIL)
    await deleteAccount(founder, account!.id, account!.name)

    await applyEntry(await savedEntry(BACK_EMAIL))

    const again = await accountOf(BACK_EMAIL)
    expect(again).not.toBeNull()
    expect(again!.id).not.toBe(account!.id)
  })

  it('la_lapida_detiene_lo_viejo_y_no_a_otro_negocio_que_comparte_telefono', async () => {
    const org = await prisma.organization.create({ data: { name: `Negocio A ${suffix}`, email: SHARED_EMAIL, phone: '5500000000' } })
    const other = await prisma.organization.create({ data: { name: `Negocio B ${suffix}`, email: OTHER_EMAIL, phone: '5500000000' } })
    organizationIds.push(org.id, other.id)
    const stage = await getInitialStage()
    const phone = canonicalPhoneE164(phoneOf(SHARED_EMAIL))!
    const { account } = await prisma.$transaction(tx =>
      accountForTx(
        tx,
        { emails: [SHARED_EMAIL], phones: [phone], organizationId: org.id },
        {
          source: LANDING,
          externalKey: SHARED_EMAIL,
          data: { name: `Café A ${suffix}`, stageId: stage.id, organizationId: org.id },
          contact: { name: 'Carla', email: SHARED_EMAIL, phoneE164: phone },
        },
      ),
    )
    await deleteAccount(founder, account.id, `Café A ${suffix}`)
    const create = (organizationId: string | null, externalKey: string, seenAt?: Date) =>
      prisma.$transaction(tx =>
        accountForTx(
          tx,
          { emails: [], phones: [phone], organizationId },
          { source: LANDING, externalKey, data: { name: `Café ${externalKey}`, stageId: stage.id, organizationId } },
          seenAt,
        ),
      )

    // Its own Organization, or a writer with no Organization (WhatsApp, HubSpot): stopped.
    await expect(create(org.id, `x-${SHARED_EMAIL}`)).rejects.toBeInstanceOf(ErasedIdentityError)
    await expect(create(null, `y-${SHARED_EMAIL}`)).rejects.toBeInstanceOf(ErasedIdentityError)
    // Business B shares the reception phone: it is somebody else, and it goes in.
    const { created } = await create(other.id, OTHER_EMAIL)
    expect(created).toBe(true)
    await prisma.crmAccount.deleteMany({ where: { organizationId: other.id } })
  })

  // The merge of D7 with the CRM's email (phase 2): the deletion still goes through with the email tables' rows, and
  // takes what hangs from the account by its key. Extending it to the rest of the email data is a later task (D1).
  // I1 (final review): what was still queued for that person no longer goes out — it stays in the history as OMITIDO.
  it('eliminar_con_correo_del_crm: se van sus correos y su consentimiento; el renglón de la campaña se queda OMITIDO', async () => {
    await applyEntry(await savedEntry(MAIL_EMAIL, phoneOf(MAIL_EMAIL), { marketingConsent: true }))
    const account = await accountOf(MAIL_EMAIL)
    const contact = await prisma.crmContact.findFirstOrThrow({ where: { accountId: account!.id }, select: { id: true } })
    expect(await prisma.crmEmailConsent.count({ where: { email: MAIL_EMAIL, accountId: account!.id } })).toBe(1)
    await prisma.crmEmailMessage.create({
      data: {
        accountId: account!.id,
        contactId: contact.id,
        staffId: founder.staffId,
        direction: 'SALIDA',
        fromEmail: `founder-${suffix}@test.mx`,
        toEmail: MAIL_EMAIL,
        subject: 'Hola',
        status: 'ENVIADO',
      },
    })
    const campaign = await prisma.crmCampaign.create({
      data: { name: `Eliminar ${suffix}`, subject: 'Novedades', blocks: [], audience: {}, createdById: founder.staffId },
    })
    await prisma.crmCampaignDelivery.create({
      data: { campaignId: campaign.id, email: MAIL_EMAIL, reason: 'PROSPECTO', vars: {}, accountId: account!.id },
    })

    await deleteAccount(founder, account!.id, account!.name)

    expect(await accountOf(MAIL_EMAIL)).toBeNull()
    expect(await prisma.crmEmailMessage.count({ where: { accountId: account!.id } })).toBe(0)
    expect(await prisma.crmEmailConsent.count({ where: { email: MAIL_EMAIL } })).toBe(0)
    // A plain id with no foreign key: the campaign's history keeps its row (and its email) — what D1 has to decide —, but it
    // is no longer waiting to be sent.
    expect(
      await prisma.crmCampaignDelivery.findMany({
        where: { campaignId: campaign.id, accountId: account!.id },
        select: { status: true, skipReason: true },
        take: 2,
      }),
    ).toEqual([{ status: 'OMITIDO', skipReason: 'persona eliminada' }])
  })

  // I1: the deletion runs while a campaign is going out. Three ways the person could still get it: a row already queued
  // (the deletion skips it), a consent that hangs from no account (the deletion removes it), and an enqueue that read the
  // audience before the deletion committed and inserts its rows after (the sender checks the tombstone and the account).
  it('🔴 eliminar_a_media_campana: el remitente ya no le manda nada; una campaña confirmada después sí le llega', async () => {
    env.MARKETING_KILL_SWITCH = undefined
    const stage = await getInitialStage()
    const account = await prisma.crmAccount.create({ data: { name: `Café Fer ${suffix}`, source: 'MANUAL', stageId: stage.id } })
    await prisma.crmContact.create({ data: { accountId: account.id, name: 'Fer', email: SENDING_EMAIL } })
    // Her consent hangs from no account (it came in before the account existed, or from another one): no cascade takes it.
    await prisma.crmEmailConsent.create({
      data: {
        email: SENDING_EMAIL,
        accountId: null,
        entryId: `entry-${suffix}`,
        consentAt: new Date(),
        source: 'LANDING',
        noticeVersion: 'v1',
      },
    })
    const sending = async (enqueuedAt: Date) =>
      prisma.crmCampaign.create({
        data: {
          name: `Eliminar ${suffix}`,
          subject: 'Novedades',
          blocks: [{ type: 'paragraph', text: 'Hola' }],
          audience: {},
          status: 'ENVIANDO',
          enqueuedAt,
          createdById: founder.staffId,
        },
      })
    const queued = (campaignId: string, email: string, accountId: string | null) =>
      prisma.crmCampaignDelivery.create({ data: { campaignId, email, reason: 'PROSPECTO', vars: {}, accountId } })

    const first = await sending(new Date())
    const already = await queued(first.id, SENDING_EMAIL, account.id)
    const racing = await sending(new Date())

    await deleteAccount(founder, account.id, account.name)

    expect(await prisma.crmEmailConsent.count({ where: { email: SENDING_EMAIL } })).toBe(0)
    expect(await prisma.crmCampaignDelivery.findUniqueOrThrow({ where: { id: already.id } })).toMatchObject({
      status: 'OMITIDO',
      skipReason: 'persona eliminada',
    })
    // The racing enqueue's rows land after the commit: one by her email, one by her account with an email the account's
    // contacts never had (the consent's own address).
    const byEmail = await queued(racing.id, SENDING_EMAIL, null)
    const byAccount = await queued(racing.id, CONSENT_ONLY_EMAIL, account.id)
    // A campaign confirmed well after the deletion (a client list, a new form): the tombstone does not block her forever.
    const later = await sending(new Date(Date.now() + 10 * 60_000))
    const after = await queued(later.id, SENDING_EMAIL, null)
    process.env.CRM_CORREO_PRUEBAS = `${SENDING_EMAIL},${CONSENT_ONLY_EMAIL}`
    send.mockClear()

    await correrEnvioDeCampanas({ ahora: new Date(), pausaMs: 0 })

    expect(send.mock.calls.map(([mail]) => mail.idempotencyKey)).toEqual([after.id])
    for (const id of [byEmail.id, byAccount.id])
      expect(await prisma.crmCampaignDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'OMITIDO',
        skipReason: 'persona eliminada',
      })
    expect(await prisma.crmCampaignDelivery.findUniqueOrThrow({ where: { id: after.id } })).toMatchObject({ status: 'ENVIADO' })
  })
})
