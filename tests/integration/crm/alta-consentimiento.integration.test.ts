/**
 * «Nuevo prospecto» con la casilla «Aceptó recibir correos» contra un Postgres real (CRM campañas, tarea 8): la migración
 * (`entryId` opcional, `grantedById`), que el permiso del equipo nunca pisa el de la landing y que la landing, al
 * reescribir una fila del equipo, borra su atribución.
 *
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration --testPathPattern "alta-consentimiento" --ci --runInBand
 */
import type { CrmAccess } from '@/services/crm/access.service'
import { createManual, getInitialStage } from '@/services/crm/accounts.service'
import {
  applyEntry,
  AVISO_DE_LA_CASILLA_DEL_EQUIPO,
  escribirConsentimientoDelEquipoTx,
  LANDING,
  recordSignupOutcome,
  saveLandingEntry,
} from '@/services/crm/inbound.service'
import prisma from '@/utils/prismaClient'

const suffix = `crmalta${Date.now()}`
const A = `alta-a-${suffix}@test.mx`
const B = `alta-b-${suffix}@test.mx`
const C = `alta-c-${suffix}@test.mx`
const D = `alta-d-${suffix}@test.mx`
const EMAILS = [A, B, C, D]
const PHONE_BASE = String(Date.now()).slice(-7)

let seller: CrmAccess

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
