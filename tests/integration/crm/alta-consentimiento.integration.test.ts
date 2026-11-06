/**
 * «Nuevo prospecto» con la casilla «Aceptó recibir correos» contra un Postgres real (CRM campañas, tarea 8): la migración
 * (`entryId` opcional, `grantedById`), que el permiso del equipo nunca pisa el de la landing y que la landing, al
 * reescribir una fila del equipo, borra su atribución.
 *
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "alta-consentimiento" --ci --runInBand
 */
import type { CrmAccess } from '@/services/crm/access.service'
import { createManual, getInitialStage } from '@/services/crm/accounts.service'
import { AVISO_DE_LA_CASILLA_DEL_EQUIPO, escribirConsentimientoDelEquipoTx } from '@/services/crm/consent.service'
import { applyEntry, LANDING, recordSignupOutcome, saveLandingEntry } from '@/services/crm/inbound.service'
import { applyHubspot, previewHubspot } from '@/services/crm/hubspotImport.service'
import prisma from '@/utils/prismaClient'
import { createHash } from 'crypto'

const suffix = `crmalta${Date.now()}`
const A = `alta-a-${suffix}@test.mx`
const B = `alta-b-${suffix}@test.mx`
const C = `alta-c-${suffix}@test.mx`
const D = `alta-d-${suffix}@test.mx`
const H1 = `imp-1-${suffix}@test.mx`
const H2 = `imp-2-${suffix}@test.mx`
const H3 = `imp-3-${suffix}@test.mx`
const H4 = `imp-4-${suffix}@test.mx`
const E1 = `imp-borrado-${suffix}@test.mx`
const EMAILS = [A, B, C, D, H1, H2, H3, H4, E1]
const PHONE_BASE = String(Date.now()).slice(-7)

let seller: CrmAccess

const hash = (email: string) => createHash('sha256').update(`EMAIL:${email}`).digest('hex')
const consentOf = (email: string) => prisma.crmEmailConsent.findUnique({ where: { email } })
const input = (email: string, aceptaCorreos?: boolean) => ({
  name: `Café ${email}`,
  contact: { name: 'Paola', email, ...(aceptaCorreos === undefined ? {} : { aceptaCorreos }) },
})

beforeAll(async () => {
  const staff = await prisma.staff.create({ data: { email: `vendedor-${suffix}@test.mx`, firstName: 'Rafa', lastName: 'Alta' } })
  seller = {
    staffId: staff.id,
    isSuperadmin: false,
    ver: 'propios',
    editar: 'propios',
    contactar: true,
    campanas: false,
    exportar: false,
    ventas: false,
    admin: false,
    cerrar: true,
    bajas: false,
    plantillas: false,
    preparar: false,
    mandar: false,
    verCampanas: false,
    equipo: false,
    configurar: false,
  }
  await getInitialStage()
})

afterAll(async () => {
  await prisma.crmErased.deleteMany({ where: { keyHash: hash(E1) } })
  await prisma.crmAccount.deleteMany({ where: { externalKey: { startsWith: `hubspot:contact:${suffix}` } } })
  await prisma.crmEmailConsent.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.crmAccount.deleteMany({ where: { contacts: { some: { email: { in: EMAILS } } } } })
  await prisma.crmInboundEntry.deleteMany({ where: { externalKey: { in: EMAILS } } })
  await prisma.staff.deleteMany({ where: { id: seller.staffId } })
})

describe('alta a mano con la casilla', () => {
  it('con la casilla: una fila MANUAL con quién, cuándo y sin entrada; la respuesta lo confirma', async () => {
    const row = await createManual(seller, input(A, true))
    expect(row.consentimientoRegistrado).toBe(true)
    expect(await consentOf(A)).toMatchObject({
      source: 'MANUAL',
      entryId: null,
      grantedById: seller.staffId,
      noticeVersion: AVISO_DE_LA_CASILLA_DEL_EQUIPO,
      accountId: row.id,
    })
  })

  it('sin la casilla: la cuenta se crea y no hay permiso', async () => {
    const row = await createManual(seller, input(B))
    expect(row.consentimientoRegistrado).toBe(false)
    expect(await consentOf(B)).toBeNull()
  })

  it('🔴 nunca pisa un permiso que ya existía (el de la landing se queda) y la respuesta sigue diciendo true', async () => {
    const original = await prisma.crmEmailConsent.create({
      data: {
        email: C,
        entryId: 'centryprev000000000000009',
        consentAt: new Date('2026-01-01T00:00:00Z'),
        source: LANDING,
        noticeVersion: '2026-01-01',
      },
    })
    const row = await createManual(seller, input(C, true))
    expect(row.consentimientoRegistrado).toBe(true)
    expect(await consentOf(C)).toMatchObject({ id: original.id, source: LANDING, grantedById: null, noticeVersion: '2026-01-01' })
  })

  it('🔴 la landing que reescribe una fila MANUAL la deja LANDING con grantedById null', async () => {
    await createManual(seller, input(D, true))
    expect((await consentOf(D))?.grantedById).toBe(seller.staffId)

    const saved = await saveLandingEntry({
      firstName: 'Paola',
      lastName: 'Alta',
      phone: `55${PHONE_BASE}9`,
      email: D,
      companyName: `Café ${D}`,
      marketingConsent: true,
      privacyNoticeVersion: '2026-11-01',
    })
    await recordSignupOutcome(saved!.entryId, null)
    await applyEntry(saved!.entryId)

    expect(await consentOf(D)).toMatchObject({ source: LANDING, grantedById: null, entryId: saved!.entryId, noticeVersion: '2026-11-01' })
  })

  it('el helper deja a la importación lista: sin repetidos, normaliza y devuelve cuántas escribió', async () => {
    const acct = (await prisma.crmAccount.findFirst({ where: { contacts: { some: { email: B } } }, select: { id: true } }))!
    const n = await prisma.$transaction(tx =>
      escribirConsentimientoDelEquipoTx(tx, {
        emails: [B.toUpperCase(), B, '  '],
        accountId: acct.id,
        source: 'IMPORTACION',
        staffId: seller.staffId,
        at: new Date(),
      }),
    )
    expect(n).toBe(1)
    expect(await consentOf(B)).toMatchObject({ source: 'IMPORTACION', grantedById: seller.staffId })
  })
})

describe('importar de HubSpot con la casilla', () => {
  const HEADER = 'Record ID,First Name,Last Name,Phone Number,Email,Company Name\n'
  const NO_DEALS = 'Record ID,Deal Name,Deal Stage,Associated Contact IDs\n'
  const id = (n: number) => `${suffix}-${n}`
  const row = (n: number, email: string) => `${id(n)},Persona,${n},,${email},Negocio ${suffix} ${n}\n`
  let adminAccess: CrmAccess

  beforeAll(() => {
    adminAccess = { ...seller, admin: true, configurar: true, ver: 'todos', editar: 'todos' } as CrmAccess
  })

  it('con la casilla: sólo lo que el import CREA recibe permiso; lo que ya existía no se toca; la vista previa no escribe; erradas se saltan', async () => {
    // H2 already has a landing consent; E1 was deleted from the CRM (D7); «sin-arroba» is not an email.
    await prisma.crmEmailConsent.create({
      data: {
        email: H2,
        entryId: 'centryprev000000000000008',
        consentAt: new Date('2026-01-01T00:00:00Z'),
        source: LANDING,
        noticeVersion: '2026-01-01',
      },
    })
    await prisma.crmErased.create({ data: { keyHash: hash(E1), scope: '', erasedAt: new Date() } })
    const file = HEADER + row(1, H1) + row(2, H2) + row(3, E1) + row(4, 'sin-arroba')

    await previewHubspot(file, NO_DEALS)
    expect(await consentOf(H1)).toBeNull()

    const applied = await applyHubspot(adminAccess, file, NO_DEALS, { aceptaronCorreos: true })
    expect(applied.conPermiso).toBe(1) // only H1: H2 keeps the landing's, E1 is erased, the malformed one is skipped
    expect(await consentOf(H2)).toMatchObject({ source: LANDING, grantedById: null })
    expect(await consentOf(H1)).toMatchObject({ source: 'IMPORTACION', grantedById: seller.staffId, entryId: null })
    expect(await consentOf(E1)).toBeNull()
  })

  it('🔴 importar otra vez no pisa ni cuenta dos veces; sin la casilla no escribe nada', async () => {
    const again = await applyHubspot(adminAccess, HEADER + row(1, H1), NO_DEALS, { aceptaronCorreos: true })
    expect(again.conPermiso).toBe(0)
    const without = await applyHubspot(adminAccess, HEADER + row(5, H3), NO_DEALS)
    expect(without.conPermiso).toBeUndefined()
    expect(await consentOf(H3)).toBeNull()
  })

  it('un permiso que ya había (landing) no se pisa aunque el registro entre con la casilla', async () => {
    const h = await applyHubspot(adminAccess, HEADER + row(6, H4), NO_DEALS, { aceptaronCorreos: true })
    expect(h.conPermiso).toBe(1)
    expect(await consentOf(H2)).toMatchObject({ source: LANDING, grantedById: null, noticeVersion: '2026-01-01' })
  })
})
