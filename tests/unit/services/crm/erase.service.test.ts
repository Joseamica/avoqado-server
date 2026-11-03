/**
 * «Eliminar» a CRM account (D7, founder 2-nov: «al instante, pero solo superadmin, o sea yo»).
 *
 * What these pin: only the real superadmin deletes, and only after typing the account's name; the account goes with its
 * people, timeline and landing entries, and the ActivityLog says who without saying whom; and the tombstone keeps it from
 * coming back by itself — an old landing entry, an old signup or an old chat create nothing, a new one does — without
 * shutting out ANOTHER business that only shares a phone (Codex r1 H3). Promesa: Avoqado/docs/audit/2026-11-02-crm-eliminar-prospecto/.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import type { CrmAccess } from '@/services/crm/access.service'
import { deleteAccount, erasedHashes, ErasedIdentityError } from '@/services/crm/erase.service'
import { accountForTx, applyEntry } from '@/services/crm/inbound.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/crm/digest.service', () => ({ notifyNewProspect: jest.fn(), notifyReturningProspect: jest.fn() }))

const EMAIL = 'ana@cafe.mx'
const PHONE = '+525512345678'
const ORG_A = 'corgerasea000000000000001'
const ORG_B = 'corgeraseb000000000000001'
const ACCOUNT = 'caccounter000000000000001'
const MINUTE = 60_000

const FOUNDER: CrmAccess = {
  staffId: 'cstafffounder000000000001',
  isSuperadmin: true,
  ver: 'todos',
  editar: 'todos',
  contactar: true,
  campanas: true,
  exportar: true,
  ventas: true,
  admin: true,
}
/** Every key of the CRM, «Administrar» included — but not the superadmin. */
const ADMIN_DEL_EQUIPO: CrmAccess = { ...FOUNDER, staffId: 'cstaffadmin00000000000001', isSuperadmin: false }

let db: ReturnType<typeof installCrmInboundFake>

function seedAccount(over: Record<string, unknown> = {}) {
  const account = {
    id: ACCOUNT,
    name: 'Café Ana',
    source: 'LANDING',
    externalKey: EMAIL,
    stageId: FAKE_STAGE_ID,
    organizationId: null,
    lastTouchAt: new Date(Date.now() - 10 * MINUTE),
    ...over,
  }
  db.accounts.push(account)
  db.contacts.push({ id: 'ccontacter000000000000001', accountId: account.id, name: 'Ana López', email: EMAIL, phoneE164: PHONE })
  db.events.push({ accountId: account.id, kind: 'NOTE', data: { text: 'Llamar a Ana al 55 1234 5678' } })
  db.entries.push({
    id: 'centryapplied000000000001',
    source: 'LANDING',
    externalKey: EMAIL,
    payload: { email: EMAIL },
    accountId: account.id,
  })
  return account
}

/** A landing form of Ana's, saved and not applied yet, sent `ago` ms before now. */
function seedEntry(id: string, ago: number) {
  const entry = {
    id,
    source: 'LANDING',
    externalKey: EMAIL,
    payload: { firstName: 'Ana', lastName: 'López', email: EMAIL, phone: '55 1234 5678', companyName: 'Café Ana' },
    receivedAt: new Date(Date.now() - ago),
    signupOutcome: null,
    signupResolvedAt: new Date(),
    appliedAt: null,
    accountId: null,
    lastError: null,
    noticeSentAt: null,
    noticeAttempts: 0,
  }
  db.entries.push(entry)
  return entry
}

/** What a writer would create: an account for this person, through the resolver every writer shares. */
const create = (who: { emails?: string[]; phones?: string[]; organizationId?: string | null; key?: string }, seenAt?: Date) =>
  prisma.$transaction(tx =>
    accountForTx(
      tx,
      { emails: who.emails ?? [], phones: who.phones ?? [], organizationId: who.organizationId ?? null },
      { source: 'LANDING', externalKey: who.key ?? 'otra@persona.mx', data: { name: 'Nuevo', stageId: FAKE_STAGE_ID } },
      seenAt,
    ),
  )

beforeEach(() => {
  db = installCrmInboundFake(prismaMock)
})

describe('deleteAccount', () => {
  it('solo_el_superadmin_real_elimina: «Administrar» no basta, y nada se borra', async () => {
    seedAccount()

    await expect(deleteAccount(ADMIN_DEL_EQUIPO, ACCOUNT, 'Café Ana')).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_SOLO_SUPERADMIN',
    })

    expect(db.accounts).toHaveLength(1)
    expect(db.erased).toHaveLength(0)
  })

  it('pide_escribir_el_nombre: otro nombre no borra nada; mayúsculas y espacios de más sí cuentan como el mismo', async () => {
    seedAccount()

    await expect(deleteAccount(FOUNDER, ACCOUNT, 'Cafe Ana')).rejects.toMatchObject({ code: 'CRM_CONFIRMA_EL_NOMBRE' })
    expect(db.accounts).toHaveLength(1)
    expect(db.erased).toHaveLength(0)

    await expect(deleteAccount(FOUNDER, ACCOUNT, '  café   ANA ')).resolves.toEqual({ id: ACCOUNT, eliminado: true })
    expect(db.accounts).toHaveLength(0)
  })

  it('un_negocio_que_ya_no_esta_da_404', async () => {
    await expect(deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')).rejects.toMatchObject({ statusCode: 404, code: 'CRM_NEGOCIO_NO_EXISTE' })
  })

  it('se_va_con_sus_contactos_su_historia_y_sus_entradas, y la bitácora dice quién sin decir a quién', async () => {
    seedAccount({ organizationId: ORG_A })

    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    expect(db.accounts).toHaveLength(0)
    expect(db.contacts).toHaveLength(0)
    expect(db.events).toHaveLength(0)
    expect(db.entries).toHaveLength(0)
    expect(db.logs).toEqual([
      expect.objectContaining({
        staffId: FOUNDER.staffId,
        action: 'CRM_ACCOUNT_DELETED',
        entityId: ACCOUNT,
        data: expect.objectContaining({ source: 'LANDING', organizationLinked: true, contactos: 1, eventos: 1 }),
      }),
    ])
    // Key, Organization, email and phone — as hashes, never the values.
    expect(db.erased).toHaveLength(4)
    const kept = JSON.stringify([db.erased, db.logs])
    for (const value of ['Café Ana', 'Ana López', EMAIL, PHONE, '5512345678']) expect(kept).not.toContain(value)
    for (const row of db.erased)
      expect(row).toEqual({ keyHash: expect.stringMatching(/^[0-9a-f]{64}$/), scope: ORG_A, erasedAt: expect.any(Date) })
  })

  // I1 (revisión final de la fase 2 de correo): la cola de campañas no tiene llave foránea y el consentimiento puede colgar de
  // otra cuenta (o de ninguna). Sin esto la persona eliminada seguía recibiendo campañas.
  it('🔴 lo_que_estaba_por_mandarse_se_omite_y_su_consentimiento_se_va: por cuenta y por correo, en la misma transacción', async () => {
    seedAccount()
    db.contacts.push({ id: 'ccontacter000000000000002', accountId: ACCOUNT, name: 'Beto', email: '  Beto@Cafe.MX ', phoneE164: null })

    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    // Sólo lo que nunca se reclamó (PENDIENTE) es OMITIDO seguro. Una REINTENTO pudo haber salido en su intento anterior: se queda para
    // el remitente, que al reclamarla mira la lápida y la deja DESCONOCIDO sin llamar a Resend (familia C, pasada r2).
    expect(prismaMock.crmCampaignDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDIENTE',
        OR: [{ accountId: ACCOUNT }, { email: { in: [EMAIL, 'beto@cafe.mx'] } }],
      },
      data: { status: 'OMITIDO', skipReason: 'persona eliminada', nextAttemptAt: null },
    })
    expect(prismaMock.crmEmailConsent.deleteMany).toHaveBeenCalledWith({ where: { email: { in: [EMAIL, 'beto@cafe.mx'] } } })
  })

  it('borrarlo_otra_vez_renueva_la_lapida: alguien lo creó a mano y se vuelve a eliminar', async () => {
    seedAccount()
    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')
    const first = db.erased[0].erasedAt
    seedAccount({ id: 'caccountmano0000000000001', source: 'MANUAL', externalKey: null })

    await new Promise(resolve => setTimeout(resolve, 5))
    await deleteAccount(FOUNDER, 'caccountmano0000000000001', 'Café Ana')

    // The email and phone are the same: renewed, not repeated. The landing key of the first one keeps its date.
    expect(db.erased).toHaveLength(3)
    expect(db.erased.filter(row => row.erasedAt > first)).toHaveLength(2)
  })
})

describe('the tombstone', () => {
  it('nunca_retrocede (Codex r2 H1): otro negocio que comparte el teléfono se eliminó después y su fecha se queda', async () => {
    seedAccount()
    const later = new Date(Date.now() + 60 * MINUTE)
    const [phoneHash] = erasedHashes({ keys: [], emails: [], phones: [PHONE], organizationId: null }).person
    db.erased.push({ keyHash: phoneHash, scope: '', erasedAt: later })

    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    expect(db.erased.find(row => row.keyHash === phoneHash)!.erasedAt).toEqual(later)
  })

  it('una_entrada_vieja_de_la_landing_no_lo_vuelve_a_crear_y_se_borra_tambien', async () => {
    seedAccount()
    seedEntry('centryold0000000000000001', MINUTE)

    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')
    await applyEntry('centryold0000000000000001')

    expect(db.accounts).toHaveLength(0)
    expect(db.entries).toHaveLength(0)
  })

  it('una_entrada_nueva_despues_de_eliminar_si_entra: la persona volvió a llenar la landing', async () => {
    seedAccount()
    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')
    seedEntry('centrynew0000000000000001', -MINUTE)

    await applyEntry('centrynew0000000000000001')

    expect(db.accounts).toEqual([expect.objectContaining({ source: 'LANDING', externalKey: EMAIL })])
    expect(db.entries[0]).toMatchObject({ appliedAt: expect.any(Date), accountId: db.accounts[0].id })
  })

  it('sin_fecha_cuenta_como_viejo: una alta vieja, un archivo de HubSpot o un chat sin fecha no lo crean', async () => {
    seedAccount()
    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    await expect(create({ emails: [EMAIL] })).rejects.toBeInstanceOf(ErasedIdentityError)
    await expect(create({ phones: [PHONE] })).rejects.toBeInstanceOf(ErasedIdentityError)
    await expect(create({ key: EMAIL })).rejects.toBeInstanceOf(ErasedIdentityError)
    expect(db.accounts).toHaveLength(0)
    // What was said after the deletion does.
    await expect(create({ phones: [PHONE] }, new Date(Date.now() + MINUTE))).resolves.toMatchObject({ created: true })
  })

  it('otro_negocio_que_comparte_telefono_no_se_bloquea: el de una Organization distinta sí entra (Codex r1 H3)', async () => {
    seedAccount({ organizationId: ORG_A })
    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    // Its own Organization always stops it; with no Organization (WhatsApp, HubSpot) its phone does too.
    await expect(create({ organizationId: ORG_A })).rejects.toBeInstanceOf(ErasedIdentityError)
    await expect(create({ phones: [PHONE] })).rejects.toBeInstanceOf(ErasedIdentityError)
    // Another business, B, with the same reception phone and the same person's email: not this account.
    await expect(create({ phones: [PHONE], emails: [EMAIL], key: EMAIL, organizationId: ORG_B })).resolves.toMatchObject({
      created: true,
    })
  })

  it('un_negocio_sin_organizacion_eliminado_detiene_a_quien_el_resolver_le_habria_unido', async () => {
    seedAccount()
    await deleteAccount(FOUNDER, ACCOUNT, 'Café Ana')

    // The resolver would have joined B's signup to an account with no Organization and this phone: so does the tombstone.
    await expect(create({ phones: [PHONE], organizationId: ORG_B })).rejects.toBeInstanceOf(ErasedIdentityError)
  })
})
