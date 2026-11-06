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

import { randomUUID } from 'crypto'
import type { CrmAccess } from '@/services/crm/access.service'
import { recorrerAudiencia } from '@/services/crm/email/audience.service'
import { erasedHashes } from '@/services/crm/erase.service'
import { addContact, updateAccount } from '@/services/crm/ficha.service'
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
const staffIds: string[] = []
const erasedKeys: string[] = []

/** Un vendedor que ve y edita todo (o sólo lo suyo), sobre una persona de verdad (los eventos llevan su id). */
const seller = (staffId: string, over: Partial<CrmAccess> = {}): CrmAccess =>
  ({
    staffId,
    isSuperadmin: false,
    ver: 'todos',
    editar: 'todos',
    contactar: true,
    exportar: false,
    ventas: false,
    cerrar: false,
    bajas: false,
    plantillas: false,
    preparar: false,
    mandar: false,
    verCampanas: false,
    equipo: false,
    configurar: false,
    campanas: false,
    admin: false,
    ...over,
  }) as CrmAccess

async function vendedor(alias: string) {
  const { id } = await prisma.staff.create({ data: { email: `${alias}-${suffix}@test.mx`, firstName: alias, lastName: 'Ficha' } })
  staffIds.push(id)
  return id
}

const form = (email: string, over: Record<string, unknown> = {}) => ({
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
  ...over,
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

async function landingEntry(email: string, receivedAt = new Date(), over: Record<string, unknown> = {}) {
  emails.push(email)
  const saved = await saveLandingEntry(form(email, over), receivedAt)
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
  await prisma.crmEmailConsent.deleteMany({ where: { email: { contains: suffix } } })
  if (erasedKeys.length) await prisma.crmErased.deleteMany({ where: { keyHash: { in: erasedKeys } } })
  if (emails.length) {
    await prisma.crmAccount.deleteMany({ where: { source: 'LANDING', externalKey: { in: emails } } })
    await prisma.crmInboundEntry.deleteMany({ where: { externalKey: { in: emails } } })
  }
  if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
  if (stageIds.length) await prisma.crmStage.deleteMany({ where: { id: { in: stageIds } } })
  if (staffIds.length) {
    await prisma.activityLog.deleteMany({ where: { staffId: { in: staffIds } } })
    await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
  }
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

describe('Tarea 1 · PATCH /crm/accounts/:id: los datos del negocio con «lo que se vio»', () => {
  it('PATCH giro con vio correcto → guardado, un ACCOUNT_EDIT {campo, de, a} y lastTouchAt movido', async () => {
    const ana = await vendedor('ana-t1')
    const { accountId } = await accountWithPerson(`t1a-${suffix}@test.mx`, {
      giro: 'Cafetería',
      lastTouchAt: new Date(Date.now() - 86_400_000),
    })

    await expect(updateAccount(seller(ana), accountId, { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } })).resolves.toEqual({
      accountId,
      cambiados: ['giro'],
    })

    const account = await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId } })
    expect(account.giro).toBe('Bar')
    expect(account.lastTouchAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
    const events = await prisma.crmTimelineEvent.findMany({ where: { accountId, kind: 'ACCOUNT_EDIT' }, take: 5 })
    expect(events).toEqual([expect.objectContaining({ actorStaffId: ana, data: { campo: 'giro', de: 'Cafetería', a: 'Bar' } })])
  })

  it('🔴 otro escritor (la rutina de WhatsApp) llena el giro vacío y luego el vendedor guarda con vio null → 409 con ahora', async () => {
    const ana = await vendedor('ana-t1b')
    const { accountId } = await accountWithPerson(`t1b-${suffix}@test.mx`, { giro: null })
    // Lo que `upsertWhatsapp` escribe bajo el candado de la fila: el giro que estaba vacío.
    await prisma.crmAccount.update({ where: { id: accountId }, data: { giro: 'Barbería' } })

    await expect(updateAccount(seller(ana), accountId, { cambios: { giro: 'Bar' }, vio: { giro: null } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMBIO_AL_EDITAR',
      details: { ahora: { giro: 'Barbería' } },
    })
    expect((await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId } })).giro).toBe('Barbería')
  })

  it('🔴 tras editar sucursales, una entrada de la landing recibida ANTES no cambia giro ni sucursales; una recibida DESPUÉS sí', async () => {
    const ana = await vendedor('ana-t1c')
    const email = `t1c-${suffix}@test.mx`
    const { accountId } = await accountWithPerson(email, { giro: 'Bar', sucursales: 1 })
    const vieja = await landingEntry(email, new Date(Date.now() - 60_000))

    await updateAccount(seller(ana), accountId, { cambios: { sucursales: 5 }, vio: { sucursales: 1 } })
    await applyEntry(vieja)
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ giro: 'Bar', sucursales: 5 })

    const nueva = await landingEntry(email, new Date(Date.now() + 1_000))
    await applyEntry(nueva)
    expect(await prisma.crmAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ giro: 'Cafetería', sucursales: 2 })
  })

  it('cuenta borrada (D7) a media edición → 404 y nada escrito', async () => {
    const ana = await vendedor('ana-t1d')
    const { accountId } = await accountWithPerson(`t1d-${suffix}@test.mx`)

    let guardando: Promise<unknown> | undefined
    await prisma.$transaction(
      async tx => {
        // Lo que hace «Eliminar» (D7): toma la fila y la borra. El guardado espera el candado y llega a una fila que ya no existe.
        await tx.$queryRaw`SELECT "id" FROM "CrmAccount" WHERE "id" = ${accountId} FOR UPDATE`
        guardando = updateAccount(seller(ana), accountId, { cambios: { giro: 'Bar' }, vio: { giro: null } }).catch(error => error)
        await untilSomeoneWaitsForTheRow()
        await tx.crmAccount.delete({ where: { id: accountId } })
      },
      { timeout: 20_000 },
    )

    expect(await guardando).toMatchObject({ statusCode: 404 })
    expect(await prisma.crmAccount.findUnique({ where: { id: accountId } })).toBeNull()
    expect(await prisma.crmTimelineEvent.count({ where: { accountId } })).toBe(0)
  })
})

/** Los correos de esta prueba que la campaña PROSPECTOS alcanza. */
async function enProspectos(prefijo: string) {
  const vistos: string[] = []
  await recorrerAudiencia({ segmentos: [{ tipo: 'PROSPECTOS' }] }, async lote => {
    vistos.push(...lote.map(d => d.email).filter(email => email.startsWith(prefijo) && email.includes(suffix)))
  })
  return vistos.sort()
}
const llave = () => randomUUID()

describe('Tarea 2 · POST /crm/accounts/:id/contacts: agregar persona', () => {
  it('🔴 casilla sobre un correo eliminado por D7 (lápida) → la persona entra, sin permiso, consentimientoRegistrado false', async () => {
    const ana = await vendedor('ana-t2a')
    const { accountId } = await accountWithPerson(`t2a-beto-${suffix}@test.mx`)
    const email = `t2a-ana-${suffix}@test.mx`
    const [hash] = erasedHashes({ keys: [], emails: [email], phones: [], organizationId: null }).person
    erasedKeys.push(hash)
    await prisma.crmErased.create({ data: { keyHash: hash, erasedAt: new Date() } })

    const r = await addContact(seller(ana), accountId, { name: 'Ana', email, aceptaCorreos: true, clientRequestId: llave() })

    expect(r).toMatchObject({ permisoDelCorreo: false, consentimientoRegistrado: false, repetido: false })
    expect(await prisma.crmContact.count({ where: { id: r.contactId, accountId } })).toBe(1)
    expect(await prisma.crmEmailConsent.findUnique({ where: { email } })).toBeNull()
  })

  it('🔴 sin casilla la persona no entra a PROSPECTOS; con casilla, sí, y la casilla autoriza exactamente el correo escrito', async () => {
    const ana = await vendedor('ana-t2b')
    const { accountId } = await accountWithPerson(`t2b-beto-${suffix}@test.mx`)
    await addContact(seller(ana), accountId, { name: 'Sin', email: `t2b-sin-${suffix}@test.mx`, clientRequestId: llave() })
    await addContact(seller(ana), accountId, {
      name: 'Con',
      email: ` T2B-Con-${suffix}@Test.mx `,
      aceptaCorreos: true,
      clientRequestId: llave(),
    })

    expect(await enProspectos('t2b-')).toEqual([`t2b-con-${suffix}@test.mx`])
    const permisos = await prisma.crmEmailConsent.findMany({ where: { accountId }, select: { email: true, source: true }, take: 5 })
    expect(permisos).toEqual([{ email: `t2b-con-${suffix}@test.mx`, source: 'MANUAL' }])
  })
})
