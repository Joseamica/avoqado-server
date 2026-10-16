/**
 * EXPERIMENTO OTel — fixture PREREGISTRADO (plan, corrección 2). Corre UNA vez contra la base PLANTILLA desechable del
 * runner (nunca contra av-db-25 ni producción: se niega si la URL no apunta a 127.0.0.1/pg). Después cada corrida clona
 * la plantilla, así que todas arrancan con los mismos datos.
 *
 * Qué siembra (todos los ids son cuid v1, como `@default(cuid())`):
 *  - Organización + venue ACTIVO (operativo) con acceso a Mesas: Feature `TABLE_SERVICE` + VenueFeature activa (grant
 *    explícito, sin grandfathering ni modo demo — así el candado de `checkFeatureAccess` se evalúa de verdad).
 *  - Staff con rol WAITER (sus permisos por defecto incluyen `orders:create` y `payments:create`) + PIN para la TPV.
 *  - Catálogo: menú, categoría y un producto de $100.00; un área y una mesa.
 *  - Afiliación SINTÉTICA: PaymentProvider + MerchantAccount + VenuePaymentConfig (slot PRIMARY) + tarifa del negocio
 *    (VenuePricingStructure) + costo del proveedor (ProviderCostStructure). No hay banco: la TPV de script declara la
 *    aprobación; esto NO prueba el SDK ni Blumon/AngelPay.
 *  - VARIAS terminales TPV activadas (si no, una carga mediría rechazos por terminal ocupada).
 *
 * Salida: JSON por stdout (ids, seriales, PIN) — sin secretos.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { CLAVE_POS } from '../lib/constantes'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cuid: () => string = require('cuid')

const N_TERMINALES = Number(process.env.N_TERMINALES || 40)
const N_MESAS = Number(process.env.N_MESAS || 600)


async function main() {
  const url = process.env.DATABASE_URL || ''
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', 'pg'].includes(host) || /av-db-25/.test(url)) {
    throw new Error(`sembrar.ts se niega a escribir en ${host}: sólo la base desechable del runner`)
  }
  const prisma = new PrismaClient()
  const id = () => {
    const v = cuid()
    if (!/^c[a-z0-9]{24}$/.test(v)) throw new Error(`cuid inesperado: ${v}`)
    return v
  }
  const ahora = new Date()
  const desde = new Date(ahora.getTime() - 24 * 3600_000) // tarifas vigentes desde ayer

  const orgId = id()
  const venueId = id()
  const staffId = id()
  const PIN = '4821'

  await prisma.organization.create({
    data: { id: orgId, name: 'Exp OTel Org', email: 'exp-otel-org@exp.test', phone: '5500000001' },
  })
  await prisma.venue.create({
    data: {
      id: venueId,
      organizationId: orgId,
      name: 'Exp OTel Mesas',
      slug: 'exp-otel-mesas',
      status: 'ACTIVE',
      type: 'RESTAURANT',
      timezone: 'America/Mexico_City',
      currency: 'MXN',
    },
  })
  await prisma.staff.create({
    data: {
      id: staffId,
      email: 'exp-otel-mesero@exp.test',
      firstName: 'Mesero',
      lastName: 'Experimento',
      active: true,
      emailVerified: true,
      password: bcrypt.hashSync(CLAVE_POS, 10),
    } as any,
  })
  await prisma.staffOrganization.create({ data: { id: id(), staffId, organizationId: orgId, role: 'MEMBER', isPrimary: true } as any })
  await prisma.staffVenue.create({ data: { id: id(), staffId, venueId, role: 'WAITER', pin: PIN, active: true } })

  // Mesas (TABLE_SERVICE): grant explícito por VenueFeature.
  const feature =
    (await prisma.feature.findUnique({ where: { code: 'TABLE_SERVICE' } })) ??
    (await prisma.feature.create({
      data: { id: id(), code: 'TABLE_SERVICE', name: 'Mesas', category: 'OPERATIONS', monthlyPrice: new Prisma.Decimal(0) },
    }))
  await prisma.venueFeature.create({
    data: { id: id(), venueId, featureId: feature.id, active: true, monthlyPrice: new Prisma.Decimal(0) },
  })
  // En producción todas las Feature ya tienen su precio de Stripe; sin esto el arranque intenta sincronizarlas
  // (sin red: ~10 s de reintentos y CPU encima del primer cobro — medido en la corrida 38924934529). Ids de relleno.
  for (const f of await prisma.feature.findMany({ where: { stripePriceId: null }, select: { id: true, code: true }, take: 500 })) {
    await prisma.feature.update({
      where: { id: f.id },
      data: { stripeProductId: `prod_exp_otel_${f.code}`, stripePriceId: `price_exp_otel_${f.code}` },
    })
  }

  // Catálogo.
  const menuId = id()
  const categoryId = id()
  const productId = id()
  await prisma.menu.create({ data: { id: menuId, venueId, name: 'Menú Exp' } as any })
  await prisma.menuCategory.create({ data: { id: categoryId, venueId, name: 'Platos', slug: 'platos' } as any })
  await prisma.menuCategoryAssignment.create({ data: { id: id(), menuId, categoryId } as any })
  await prisma.product.create({
    data: { id: productId, venueId, sku: 'EXP-001', name: 'Plato del experimento', categoryId, price: new Prisma.Decimal('100.00') } as any,
  })
  const areaId = id()
  await prisma.area.create({ data: { id: areaId, venueId, name: 'Salón' } as any })
  // Muchas mesas: con carga, un cobro nunca cae en una mesa con otra cuenta abierta.
  const mesas = Array.from({ length: N_MESAS }, (_, i) => ({ id: id(), venueId, number: String(i + 1), capacity: 4, areaId }))
  await prisma.table.createMany({ data: mesas.map(m => ({ ...m, qrCode: `exp-otel-${m.id}` })) as any })
  const tableId = mesas[0].id

  // Segunda sucursal (sólo lecturas): prueba de contextos con dos venues concurrentes (corrección 7).
  const venue2Id = id()
  await prisma.venue.create({
    data: { id: venue2Id, organizationId: orgId, name: 'Exp OTel Segunda', slug: 'exp-otel-segunda', status: 'ACTIVE', type: 'RESTAURANT' },
  })
  await prisma.staffVenue.create({ data: { id: id(), staffId, venueId: venue2Id, role: 'WAITER', active: true } })

  // Afiliación y tarifas SINTÉTICAS.
  const provider =
    (await prisma.paymentProvider.findUnique({ where: { code: 'ANGELPAY' } })) ??
    (await prisma.paymentProvider.create({
      data: { id: id(), code: 'ANGELPAY', name: 'AngelPay (sintético del experimento)', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } as any,
    }))
  const merchantAccountId = id()
  await prisma.merchantAccount.create({
    data: {
      id: merchantAccountId,
      providerId: provider.id,
      externalMerchantId: 'EXP-OTEL-0001',
      displayName: 'Afiliación sintética',
      active: true,
      credentialsEncrypted: {},
    } as any,
  })
  await prisma.venuePaymentConfig.create({ data: { id: id(), venueId, primaryAccountId: merchantAccountId } })
  await prisma.venuePricingStructure.create({
    data: {
      id: id(),
      venueId,
      accountType: 'PRIMARY',
      debitRate: new Prisma.Decimal('0.0200'),
      creditRate: new Prisma.Decimal('0.0300'),
      amexRate: new Prisma.Decimal('0.0400'),
      internationalRate: new Prisma.Decimal('0.0450'),
      includesTax: false,
      effectiveFrom: desde,
      active: true,
    } as any,
  })
  await prisma.providerCostStructure.create({
    data: {
      id: id(),
      providerId: provider.id,
      merchantAccountId,
      debitRate: new Prisma.Decimal('0.0150'),
      creditRate: new Prisma.Decimal('0.0250'),
      amexRate: new Prisma.Decimal('0.0350'),
      internationalRate: new Prisma.Decimal('0.0400'),
      includesTax: false,
      effectiveFrom: desde,
      active: true,
    } as any,
  })

  // Liquidación de la afiliación (sin ella el efecto TRANSACTION_COST queda PENDING con AWAITING_SETTLEMENT_CONFIGURATION:
  // medido en la corrida 38924934529 — hueco del fixture, no del server).
  for (const cardType of ['DEBIT', 'CREDIT', 'AMEX', 'INTERNATIONAL', 'OTHER'] as const) {
    await prisma.settlementConfiguration.create({
      data: {
        id: id(),
        merchantAccountId,
        cardType,
        settlementDays: 1,
        settlementDayType: 'BUSINESS_DAYS',
        cutoffTime: '23:00',
        cutoffTimezone: 'America/Mexico_City',
        effectiveFrom: desde,
      } as any,
    })
  }

  // Terminales TPV activadas.
  const terminales: Array<{ id: string; serial: string }> = []
  for (let i = 1; i <= N_TERMINALES; i++) {
    const t = { id: id(), serial: `AVQD-EXPOTEL${String(i).padStart(4, '0')}` }
    await prisma.terminal.create({
      data: {
        id: t.id,
        venueId,
        serialNumber: t.serial,
        name: `TPV Exp ${i}`,
        type: 'TPV_ANDROID',
        status: 'ACTIVE',
        activatedAt: ahora,
        brand: 'NEXGO',
        assignedMerchantIds: [merchantAccountId],
      } as any,
    })
    terminales.push(t)
  }

  await prisma.$disconnect()
  process.stdout.write(
    JSON.stringify(
      {
        orgId,
        venueId,
        venue2Id,
        staffId,
        email: 'exp-otel-mesero@exp.test',
        rolStaff: 'WAITER',
        pin: PIN,
        productId,
        precioProducto: 100,
        tableId,
        mesas: mesas.map(m => m.id),
        merchantAccountId,
        terminales,
      },
      null,
      2,
    ) + '\n',
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
