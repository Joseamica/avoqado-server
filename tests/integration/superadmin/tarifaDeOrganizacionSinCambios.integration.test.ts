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
import { setPricingSchema } from '@/routes/superadmin/organization.routes'
import { validateRequest } from '@/middlewares/validation'
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
  skipIfUnchanged: true,
  ...extra,
})

/** Como la ruta: primero la validación de la ruta (que quita lo que su esquema no conoce) y luego el controlador. */
async function llamar(organizationId: string, body: Record<string, unknown>) {
  let falla: unknown
  let json: any
  const req: any = { params: { organizationId }, body, query: {}, authContext: { userId: null }, user: { uid: null } }
  const res: any = { status: () => res, json: (b: unknown) => (json = b) }
  let paso = false
  await validateRequest(setPricingSchema)(req, res, ((err?: unknown) => {
    if (err) falla = err
    else paso = true
  }) as any)
  if (falla) throw falla
  if (!paso) throw new Error(`la validación de la ruta rechazó la petición: ${JSON.stringify(json)}`)
  await setPricing(req, res, ((err: unknown) => (falla = err)) as any)
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

  it('un cliente viejo que no manda la bandera reescribe como antes (sin cambio de contrato)', async () => {
    const o = await org()
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    await llamar(o, delWizard({ skipIfUnchanged: undefined }))

    expect((await filas(o)).filter(f => f.active)).toHaveLength(1)
    expect(await filas(o)).toHaveLength(2)
  })

  it('una activa programada para MAÑANA no es la vigente: pedir lo mismo hoy sí crea la de hoy (Codex r2 #4)', async () => {
    const o = await org()
    const manana = new Date(Date.now() + 24 * 3600 * 1000)
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        effectiveFrom: manana,
      },
    })

    await llamar(o, delWizard())

    const activas = (await filas(o)).filter(f => f.active)
    expect(activas).toHaveLength(1)
    expect(activas[0].effectiveFrom.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('sin la bandera (otros clientes), lo mismo con una fecha pedida —futura, pasada o cercana— se escribe como siempre (Codex r3 H5, r4 #2, r5 #2)', async () => {
    const o = await org()
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    const fecha = (effectiveFrom: string) => delWizard({ skipIfUnchanged: undefined, effectiveFrom })
    await llamar(o, fecha(new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()))
    expect(await filas(o)).toHaveLength(2)

    // …y una fecha PASADA o a dos minutos pedida a propósito también (Codex r4 #2, r5 #2): sin la bandera, como siempre.
    await llamar(o, fecha('2026-10-01T00:00:00.000Z'))
    expect(await filas(o)).toHaveLength(3)
    await llamar(o, fecha(new Date(Date.now() + 2 * 60_000).toISOString()))
    expect(await filas(o)).toHaveLength(4)
  })

  it('el fin de vigencia que no se manda se conserva en la sustituta (Codex r2 #5)', async () => {
    const o = await org()
    const finDeMes = new Date('2099-12-31T23:59:59.000Z')
    await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        effectiveFrom: new Date('2026-01-01'),
        effectiveTo: finDeMes,
      },
    })

    await llamar(o, delWizard({ creditRate: 2.6 / 100 }))

    const activas = (await filas(o)).filter(f => f.active)
    expect(activas).toHaveLength(1)
    expect(activas[0].effectiveTo?.toISOString()).toBe(finDeMes.toISOString())
  })

  it('un cargo guardado en 0 (no null) y mandado en 0 cuenta como sin cambios', async () => {
    const o = await org()
    const vigente = await prisma.organizationPricingStructure.create({
      data: {
        organizationId: o,
        accountType: 'PRIMARY',
        debitRate: 0.022,
        creditRate: 0.025,
        amexRate: 0.035,
        internationalRate: 0.038,
        fixedFeePerTransaction: 0,
        monthlyServiceFee: 0,
        effectiveFrom: new Date('2026-01-01'),
      },
    })

    await llamar(o, delWizard())

    expect(await filas(o)).toEqual([vigente])
  })

  it('el IVA que manda la pantalla pasa la validación de la ruta y se guarda (antes la validación lo quitaba)', async () => {
    const o = await org()

    await llamar(o, delWizard({ includesTax: false, taxRate: 0.08 }))

    const [creada] = await filas(o)
    expect(creada.includesTax).toBe(false)
    expect(Number(creada.taxRate)).toBe(0.08)
  })

  it('sin tarifa previa la crea (primera vez), y dos guardados iguales al mismo tiempo dejan UNA sola vigente', async () => {
    const o = await org()

    await Promise.all([llamar(o, delWizard()), llamar(o, delWizard())])

    const activas = (await filas(o)).filter(f => f.active)
    expect(activas).toHaveLength(1)
    expect(await bitacora(o)).toHaveLength(1)
  })
})
