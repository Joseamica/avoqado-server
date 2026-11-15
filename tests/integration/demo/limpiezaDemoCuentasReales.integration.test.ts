/**
 * Convertir un negocio demo NO borra sus cuentas de cobro reales ni sus tarifas (encargo fe2b91, tarjeta hz:87f4b879:D7).
 *
 * Antes: si la configuración de pagos del negocio tenía ALGUNA cuenta demo, `cleanDemoData` borraba la configuración ENTERA y
 * todas sus tarifas, aunque otra posición ya tuviera la cuenta real del negocio (la que dio de alta antes de convertirse). El
 * negocio se quedaba sin cuenta de cobro ni tarifa.
 *
 * Ahora: se limpia sólo la posición con cuenta demo (y la tarifa de ESA posición). La principal no puede quedar vacía: si la demo
 * está en la principal y hay una real en otra posición, se deja como está y se avisa (bitácora), sin inventar tarifas.
 * Si TODAS las posiciones son demo, se borra todo como siempre.
 *
 * Contra base real. Correr (base desechable): npx jest --selectProjects=integration --runInBand --ci \
 *   --runTestsByPath tests/integration/demo/limpiezaDemoCuentasReales.integration.test.ts
 */
import { randomUUID } from 'crypto'
import { AccountType, Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'
// `integration-setup.ts` mockea la bitácora (fire-and-forget): se comprueba la llamada, no la fila.
import { logAction } from '@/services/dashboard/activity-log.service'

const D = (n: number) => new Prisma.Decimal(n)
const llave = `demo-cuentas-${randomUUID().slice(0, 8)}`
const negocios: string[] = []
const cuentas: string[] = []
let providerId: string

beforeAll(async () => {
  const p = await prisma.paymentProvider.create({
    data: { code: `${llave}-PROV`, name: 'Proveedor de prueba', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
  })
  providerId = p.id
})

afterAll(async () => {
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: negocios } } })
  await prisma.organizationPaymentConfig.deleteMany({ where: { organization: { name: { startsWith: llave } } } })
  for (const venueId of negocios) {
    await prisma.venuePricingStructure.deleteMany({ where: { venueId } })
    await prisma.venuePaymentConfig.deleteMany({ where: { venueId } })
  }
  await prisma.providerCostStructure.deleteMany({ where: { merchantAccountId: { in: cuentas } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: cuentas } } })
  await prisma.venue.deleteMany({ where: { id: { in: negocios } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: llave } } })
  await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
})

async function negocioTrial(sufijo: string): Promise<string> {
  return (await negocioTrialConOrg(sufijo)).venueId
}

async function negocioTrialConOrg(sufijo: string): Promise<{ venueId: string; orgId: string }> {
  const org = await prisma.organization.create({
    data: { name: `${llave}-${sufijo}`, email: `${llave}-${sufijo}@example.test`, phone: '5500000000' },
  })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: `Prueba ${sufijo}`, slug: `${llave}-${sufijo}`, status: 'TRIAL' },
  })
  negocios.push(venue.id)
  return { venueId: venue.id, orgId: org.id }
}

/** Una cuenta como las que siembra `demoSeed` (externalMerchantId con «demo») o una real del negocio. */
async function cuenta(tipo: 'demo' | 'real', sufijo: string): Promise<string> {
  const m = await prisma.merchantAccount.create({
    data: {
      providerId,
      externalMerchantId: tipo === 'demo' ? `blumon_demo_${sufijo}` : `afiliacion-${sufijo}`,
      displayName: tipo === 'demo' ? 'Cuenta Blumon TPV' : 'Cuenta del negocio',
      credentialsEncrypted: {},
    },
  })
  cuentas.push(m.id)
  await prisma.providerCostStructure.create({
    data: {
      providerId,
      merchantAccountId: m.id,
      debitRate: D(0.015),
      creditRate: D(0.025),
      amexRate: D(0.035),
      internationalRate: D(0.04),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })
  return m.id
}

async function tarifa(venueId: string, accountType: AccountType) {
  return prisma.venuePricingStructure.create({
    data: {
      venueId,
      accountType,
      debitRate: D(0.02),
      creditRate: D(0.03),
      amexRate: D(0.04),
      internationalRate: D(0.045),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  })
}

const tiposDeTarifa = async (venueId: string) =>
  (await prisma.venuePricingStructure.findMany({ where: { venueId }, select: { accountType: true }, take: 10 }))
    .map(t => t.accountType)
    .sort()

describe('cleanDemoData × cuentas de cobro reales', () => {
  beforeEach(() => jest.mocked(logAction).mockClear())

  it('🔴 principal REAL + secundaria demo: sólo se limpia la secundaria; la real, su tarifa y su costo se quedan', async () => {
    const venueId = await negocioTrial('real-demo')
    const real = await cuenta('real', 'a1')
    const demo = await cuenta('demo', 'a2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real, secondaryAccountId: demo } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    expect(config).not.toBeNull()
    expect(config!.primaryAccountId).toBe(real)
    expect(config!.secondaryAccountId).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: real } })).not.toBeNull()
    expect(await prisma.providerCostStructure.count({ where: { merchantAccountId: real } })).toBe(1)
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).toBeNull()
    expect(r.deletedMerchantAccounts).toBe(1)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DEMO_PAYMENT_POSITIONS_CLEANED',
        venueId,
        data: expect.objectContaining({ limpiadas: ['SECONDARY'], demoQueSeQueda: null }),
      }),
    )
  })

  it('🔴 principal y secundaria REALES + terciaria demo: sólo se limpia la terciaria', async () => {
    const venueId = await negocioTrial('real-real-demo')
    const real1 = await cuenta('real', 'b1')
    const real2 = await cuenta('real', 'b2')
    const demo = await cuenta('demo', 'b3')
    await prisma.venuePaymentConfig.create({
      data: { venueId, primaryAccountId: real1, secondaryAccountId: real2, tertiaryAccountId: demo },
    })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')
    await tarifa(venueId, 'TERTIARY')

    await cleanDemoData(venueId, null)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    expect(config).toMatchObject({ primaryAccountId: real1, secondaryAccountId: real2, tertiaryAccountId: null })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY', 'SECONDARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).toBeNull()
  })

  it('🔴 principal demo + secundaria REAL: no se borra nada de pagos (la principal no puede quedar vacía) y se avisa', async () => {
    const venueId = await negocioTrial('demo-real')
    const demo = await cuenta('demo', 'c1')
    const real = await cuenta('real', 'c2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo, secondaryAccountId: real } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    const config = await prisma.venuePaymentConfig.findUnique({ where: { venueId } })
    expect(config).toMatchObject({ primaryAccountId: demo, secondaryAccountId: real })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY', 'SECONDARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: real } })).not.toBeNull()
    // La demo sigue en uso por la principal: no se borra.
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo } })).not.toBeNull()
    expect(r.deletedMerchantAccounts).toBe(0)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DEMO_PAYMENT_POSITIONS_CLEANED',
        venueId,
        data: expect.objectContaining({ limpiadas: [], demoQueSeQueda: 'PRIMARY' }),
      }),
    )
  })

  it('[demo, demo, real]: la principal demo se queda, la secundaria demo se vacía con su tarifa y la real no se toca', async () => {
    const venueId = await negocioTrial('demo-demo-real')
    const demo1 = await cuenta('demo', 'f1')
    const demo2 = await cuenta('demo', 'f2')
    const real = await cuenta('real', 'f3')
    await prisma.venuePaymentConfig.create({
      data: { venueId, primaryAccountId: demo1, secondaryAccountId: demo2, tertiaryAccountId: real },
    })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')
    await tarifa(venueId, 'TERTIARY')

    await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toMatchObject({
      primaryAccountId: demo1,
      secondaryAccountId: null,
      tertiaryAccountId: real,
    })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY', 'TERTIARY'])
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo2 } })).toBeNull()
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo1 } })).not.toBeNull()
  })

  it('Codex r2 #1: la tarifa de una posición demo se borra aunque la use un canal en línea (el canal pierde el enlace, como antes)', async () => {
    const venueId = await negocioTrial('canal')
    const real = await cuenta('real', 'g1')
    const demo = await cuenta('demo', 'g2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real, secondaryAccountId: demo } })
    await tarifa(venueId, 'PRIMARY')
    const secundaria = await tarifa(venueId, 'SECONDARY')
    const canal = await prisma.ecommerceMerchant.create({
      data: {
        venueId,
        businessName: 'Tienda en línea de prueba',
        contactEmail: `${llave}-canal@example.test`,
        publicKey: `pk_test_${llave}`,
        secretKeyHash: `hash-${llave}`,
        providerId,
        providerCredentials: {},
        pricingStructureId: secundaria.id,
      },
    })

    await cleanDemoData(venueId, null)

    expect((await prisma.venuePaymentConfig.findUnique({ where: { venueId } }))!.secondaryAccountId).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect((await prisma.ecommerceMerchant.findUnique({ where: { id: canal.id } }))!.pricingStructureId).toBeNull()
  })

  it('Codex r1/r2 #2: una cuenta demo que también usa la organización no se borra y la limpieza NO se cae', async () => {
    const { venueId, orgId } = await negocioTrialConOrg('org-usa-demo')
    const demo1 = await cuenta('demo', 'h1')
    const demo2 = await cuenta('demo', 'h2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo1, secondaryAccountId: demo2 } })
    await prisma.organizationPaymentConfig.create({ data: { organizationId: orgId, primaryAccountId: demo2 } })
    await tarifa(venueId, 'PRIMARY')

    const r = await cleanDemoData(venueId, null)

    // La limpieza terminó (antes: RESTRICT de la organización tumbaba toda la transacción).
    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo1 } })).toBeNull()
    expect(await prisma.merchantAccount.findUnique({ where: { id: demo2 } })).not.toBeNull()
    expect(r.deletedMerchantAccounts).toBe(1)
  })

  it('regresión · TODAS demo (como las siembra el demo): se borra la configuración, todas sus tarifas y las cuentas demo', async () => {
    const venueId = await negocioTrial('demo-demo')
    const demo1 = await cuenta('demo', 'd1')
    const demo2 = await cuenta('demo', 'd2')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: demo1, secondaryAccountId: demo2 } })
    await tarifa(venueId, 'PRIMARY')
    await tarifa(venueId, 'SECONDARY')

    const r = await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toBeNull()
    expect(await tiposDeTarifa(venueId)).toEqual([])
    expect(await prisma.merchantAccount.count({ where: { id: { in: [demo1, demo2] } } })).toBe(0)
    expect(r.deletedMerchantAccounts).toBe(2)
  })

  it('regresión · TODAS reales: no se toca nada de pagos y no se escribe bitácora de pagos', async () => {
    const venueId = await negocioTrial('real-solo')
    const real = await cuenta('real', 'e1')
    await prisma.venuePaymentConfig.create({ data: { venueId, primaryAccountId: real } })
    await tarifa(venueId, 'PRIMARY')

    await cleanDemoData(venueId, null)

    expect(await prisma.venuePaymentConfig.findUnique({ where: { venueId } })).toMatchObject({ primaryAccountId: real })
    expect(await tiposDeTarifa(venueId)).toEqual(['PRIMARY'])
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'DEMO_PAYMENT_POSITIONS_CLEANED' }))
  })
})
