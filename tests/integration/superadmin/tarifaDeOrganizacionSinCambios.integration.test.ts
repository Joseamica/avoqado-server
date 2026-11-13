/**
 * D18 (13-nov-2026), lado SERVIDOR: `PUT /dashboard/superadmin/organizations/:id/payment-config/pricing` (`setPricing`).
 * Promesa: `docs/audit/2026-11-13-d17-d18-d20/promesa.md` del workspace.
 *
 * Antes: cada «Guardar» del Wizard de Pagos cerraba la tarifa de la organización y creaba otra idéntica, sin bitácora, y la
 * nueva perdía el IVA (`includesTax`/`taxRate`) y los campos que la pantalla no manda (mínimos, contrato, notas).
 * Ahora: si lo pedido es idéntico a la vigente, no escribe nada; si cambia, conserva lo que no se mandó y deja bitácora.
 */
import cuid from 'cuid'
import prisma from '@/utils/prismaClient'
import { setPricing } from '@/controllers/dashboard/organization-payment.superadmin.controller'
import { logAction } from '@/services/dashboard/activity-log.service' // la integración lo finge (integration-setup.ts)

jest.setTimeout(60000)

const sufijo = cuid().slice(-8)
const orgs: string[] = []

async function org() {
  const o = await prisma.organization.create({
    data: { name: `Tarifa org ${sufijo}`, email: `${cuid()}@example.test`, phone: '5500000000' },
  })
  orgs.push(o.id)
  return o.id
}

/** Lo que manda el Wizard de Pagos (`PaymentSetupWizard.handleSave`): tasas ÷100 en coma flotante y la fecha de ahora. */
const delWizard = (extra: Record<string, unknown> = {}) => ({
  accountType: 'PRIMARY',
  debitRate: 2.2 / 100,
  creditRate: 2.5 / 100,
  amexRate: 3.5 / 100,
  internationalRate: 3.8 / 100,
  fixedFeePerTransaction: 0,
  monthlyServiceFee: 0,
  effectiveFrom: new Date().toISOString(),
  ...extra,
})

async function llamar(organizationId: string, body: Record<string, unknown>) {
  let falla: unknown
  let json: any
  const res: any = { status: () => res, json: (b: unknown) => (json = b) }
  await setPricing(
    { params: { organizationId }, body, authContext: { userId: null }, user: { uid: null } } as any,
    res,
    ((err: unknown) => (falla = err)) as any,
  )
  if (falla) throw falla
  return json
}

const filas = (organizationId: string) =>
  prisma.organizationPricingStructure.findMany({ where: { organizationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

const bitacora = async (organizationId: string) =>
  (logAction as jest.Mock).mock.calls
    .map(([p]) => p)
    .filter(p => p.organizationId === organizationId && p.action === 'ORGANIZATION_PRICING_SET')

afterAll(async () => {
  await prisma.organizationPricingStructure.deleteMany({ where: { organizationId: { in: orgs } } })
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
  await prisma.$disconnect()
})

describe('setPricing · tarifa de la organización', () => {
  it('guardar lo mismo no cierra ni crea nada (la tarifa, su fecha y su huella quedan idénticas)', async () => {
    const o = await org()
    const vigente = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        includesTax: false,
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    const respuesta = await llamar(o, delWizard())

    expect(respuesta.id).toBe(vigente.id)
    expect(await filas(o)).toEqual([vigente])
    expect(await bitacora(o)).toHaveLength(0)
  })

  it('con un cambio: cierra la vigente, crea la nueva conservando IVA, mínimos y notas que no se mandaron, y deja bitácora', async () => {
    const o = await org()
    const vieja = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        includesTax: false,
        taxRate: 0.08,
        minimumMonthlyVolume: 50000,
        contractReference: 'CONTRATO-7',
        notes: 'pactado con el dueño',
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    await llamar(o, delWizard({ creditRate: 2.6 / 100 }))

    const [cerrada, nueva] = await filas(o)
    expect(cerrada.id).toBe(vieja.id)
    expect(cerrada.active).toBe(false)
    expect(nueva.active).toBe(true)
    expect(Number(nueva.creditRate)).toBe(0.026)
    expect(nueva.includesTax).toBe(false)
    expect(Number(nueva.taxRate)).toBe(0.08)
    expect(Number(nueva.minimumMonthlyVolume)).toBe(50000)
    expect(nueva.contractReference).toBe('CONTRATO-7')
    expect(nueva.notes).toBe('pactado con el dueño')
    const [log] = await bitacora(o)
    expect(log).toMatchObject({ entity: 'OrganizationPricingStructure', entityId: nueva.id })
    expect(log.data).toMatchObject({ accountType: 'PRIMARY', previousId: vieja.id })
  })

  it('lo que sí se manda gana: includesTax explícito (también null) se guarda tal cual', async () => {
    const o = await org()
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        includesTax: false,
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    await llamar(o, delWizard({ includesTax: null }))

    const activas = (await filas(o)).filter(f => f.active)
    expect(activas).toHaveLength(1)
    expect(activas[0].includesTax).toBeNull()
  })

  it('sin tarifa previa la crea (primera vez), y dos guardados iguales al mismo tiempo dejan UNA sola vigente', async () => {
    const o = await org()

    await Promise.all([llamar(o, delWizard()), llamar(o, delWizard())])

    const activas = (await filas(o)).filter(f => f.active)
    expect(activas).toHaveLength(1)
    expect(await bitacora(o)).toHaveLength(1)
  })
})
