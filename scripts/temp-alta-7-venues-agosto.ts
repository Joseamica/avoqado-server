/**
 * DELETE AFTER USE — no aplica: se queda commiteado como bitácora re-corrible, igual que
 * `temp-cambaceo-migration.ts` / `temp-create-activacion-slp.ts` (patrón del founder para
 * altas de PlayTelecom).
 *
 * Da de alta las 7 tiendas pedidas en Asana 1217743599033218 ("Generar Nuevos Venues (7)"):
 * 4 en Querétaro (supervisor Elias Medina) + 3 en San Luis Potosí (supervisor Juan Nájera o
 * René Cubos, según el comentario de Isaac 1217790184337899, 2026-08-24).
 *
 * Receta de 8 piezas por venue (ver memoria `playtelecom-alta-de-venue-receta.md`), clonando
 * DATOS REALES verificados el 2026-08-24 contra dos tiendas PT ya operando (BAE MIRADOR VIA
 * LACTEA y BAE UNIDAD PAVON) — no inventados:
 *   1. Venue — type OTHER, MXN, America/Mexico_City, status ACTIVE, kycStatus VERIFIED,
 *      operationalRole STORE, salesEnabled true.
 *   2. VenueSettings — requirePinLogin + trackPromoterLocation (11–18h).
 *   3. VenueModule SERIALIZED_INVENTORY con el config PT (labels SIM/ICCID, fotos de
 *      entrada/salida). Sin COMMISSIONS — ese módulo no va en tiendas reales.
 *   4. VenuePaymentConfig → merchant COMPARTIDO cmlah9251000ik628rhkkwhp0 (mismo que las
 *      demás 40+ tiendas PT).
 *   5. VenuePricingStructure — clonada de la tarifa canónica de la organización (3%
 *      débito/crédito, 3.5% amex, 3.3% internacional, $3 fija, IVA 16%). Sin esto los cobros
 *      con tarjeta quedan con feeAmount=0 (margen negativo silencioso).
 *   6. VenueRoleConfig ×8 — etiquetas PT (Promotor, Supervisor, Propietario…), clonadas
 *      exactas de BAE UNIDAD PAVON.
 *   7. StaffVenue back-office fijo (6, verificado — NO 7: Adan Uriel NO aparece en ninguna
 *      tienda PT real hoy, así que no se agrega): Isaac Mayoral, Adrian Palme, Daniel
 *      Samperio, Alberto Tejeda, Daniel Aguirre = OWNER; Edgar Salazar = ADMIN.
 *      + supervisor regional (MANAGER) según Isaac. SIN promotor — "vienen con promotor
 *      vacante" (Isaac, comentario 1217757396400620). SIN Terminal — pendiente hardware.
 *   8. ActivityLog VENUE_CREATED + KYC_APPROVED por cada tienda, actor superadmin
 *      cmhvejg9y00a72gtx23p4y2ai (mismo patrón que la alta anterior de MB Ciudad Satélite).
 *
 * ⚠️ ESCRIBE EN PRODUCCIÓN. Por defecto corre en DRY-RUN (no escribe nada).
 *    Para ejecutar de verdad: CONFIRM=EJECUTAR npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-alta-7-venues-agosto.ts
 *    Dry-run (preview):                          npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-alta-7-venues-agosto.ts
 */
import { PrismaClient, Prisma } from '@prisma/client'

const url = process.env.RENDER_DATABASE_URL
if (!url) {
  console.error('❌ RENDER_DATABASE_URL missing — aborting.')
  process.exit(1)
}
const prisma = new PrismaClient({ datasources: { db: { url } } })

const DRY_RUN = process.env.CONFIRM !== 'EJECUTAR'

// ── Constantes verificadas contra prod, 2026-08-24 ─────────────────────────
const ORG_ID = 'cmietitbn000zpr2d8213qkzq' // PlayTelecom
const ROLE_CONFIG_TEMPLATE_VENUE_ID = 'cmnrv_bae_unidad_pavon_3704' // BAE UNIDAD PAVON
const MERCHANT_ID = 'cmlah9251000ik628rhkkwhp0' // afiliación compartida de las 40+ tiendas PT
const SUPERADMIN_ACTOR_ID = 'cmhvejg9y00a72gtx23p4y2ai' // mismo actor de la alta de MB Ciudad Satélite (2026-08-03)

// Back-office fijo, verificado en BAE MIRADOR VIA LACTEA + BAE UNIDAD PAVON (staffVenue real)
const BACK_OFFICE = [
  { staffId: 'cmliew9si001epx28q93w9vq2', role: 'OWNER' as const }, // Isaac Mayoral
  { staffId: 'cmrcjfd1t0000ijc9eqb5ekud', role: 'OWNER' as const }, // Adrian Palme
  { staffId: 'cmpcxq4jy054arm2avsg1ejoq', role: 'OWNER' as const }, // Daniel Samperio
  { staffId: 'cmo1weriy006goe28irugg9cz', role: 'OWNER' as const }, // Alberto Tejeda
  { staffId: 'cmqzzl61w0008mk2awltepmdi', role: 'OWNER' as const }, // Daniel Aguirre
  { staffId: 'cmo0av9ie00keow2a4ne4syf3', role: 'ADMIN' as const }, // Edgar Salazar
]

// Supervisores regionales — Asana 1217743599033218, comentario 1217790184337899 (Isaac, 2026-08-24)
const ELIAS_MEDINA = 'cmmwtardt00qtmo28afreccho'
const JUAN_NAJERA = 'cmst49ash02ahou2askugxfmk'
const RENE_CUBOS = 'cmmwtt6ju00uxmo28ci85269t'

interface NewVenue {
  name: string
  slug: string
  address: string
  city: string
  state: string
  latitude: string
  longitude: string
  supervisorId: string
  supervisorLabel: string
}

const NEW_VENUES: NewVenue[] = [
  {
    name: 'BAE CIUDAD DEL SOL (1293)',
    slug: 'bae-ciudad-del-sol-1293',
    address: 'Prol. Bernardo Quintana 4028, Col. La Roma (zona Ciudad del Sol), 76132 Santiago de Querétaro, Qro.',
    city: 'Querétaro',
    state: 'Querétaro',
    latitude: '20.618358',
    longitude: '-100.409243',
    supervisorId: ELIAS_MEDINA,
    supervisorLabel: 'Elias Medina',
  },
  {
    name: 'BAE PAMES (2401)',
    slug: 'bae-pames-2401',
    address: 'Calle Choles No. 201, entre Av. de los Milagros y Calle Pames, Col. Cerrito Colorado, 76116 Santiago de Querétaro, Qro.',
    city: 'Querétaro',
    state: 'Querétaro',
    latitude: '20.637605',
    longitude: '-100.46493',
    supervisorId: ELIAS_MEDINA,
    supervisorLabel: 'Elias Medina',
  },
  {
    name: 'BAE PUERTA DEL SOL (3636)',
    slug: 'bae-puerta-del-sol-3636',
    address: 'Prolongación Bernardo Quintana Fracción I y II S/N, Puerta del Sol II, 76114 Santiago de Querétaro, Qro.',
    city: 'Querétaro',
    state: 'Querétaro',
    latitude: '20.616827',
    longitude: '-100.4484868',
    supervisorId: ELIAS_MEDINA,
    supervisorLabel: 'Elias Medina',
  },
  {
    name: 'BAE RANCHO BELLAVISTA (4736)',
    slug: 'bae-rancho-bellavista-4736',
    address: 'Av. Bellavista No. 2010, Fracc. Rancho Bellavista, 76134 Santiago de Querétaro, Qro.',
    city: 'Querétaro',
    state: 'Querétaro',
    latitude: '20.60667',
    longitude: '-100.44972',
    supervisorId: ELIAS_MEDINA,
    supervisorLabel: 'Elias Medina',
  },
  {
    name: 'BAE GALVEZ (1263)',
    slug: 'bae-galvez-1263',
    address: 'José Gálvez esq. 21 de Marzo 641, Col. 21 de Marzo, 78437 Soledad de Graciano Sánchez, S.L.P.',
    city: 'San Luis Potosí',
    state: 'San Luis Potosí',
    latitude: '22.149189',
    longitude: '-100.921927',
    supervisorId: JUAN_NAJERA,
    supervisorLabel: 'Juan Nájera',
  },
  {
    name: 'BAE MISION SAN PEDRO (3952)',
    slug: 'bae-mision-san-pedro-3952',
    address: 'Av. San Pedro 1840, Col. San Francisco de Asís, 78435 Soledad de Graciano Sánchez, S.L.P.',
    city: 'San Luis Potosí',
    state: 'San Luis Potosí',
    latitude: '22.169543',
    longitude: '-100.924812',
    supervisorId: JUAN_NAJERA,
    supervisorLabel: 'Juan Nájera',
  },
  {
    name: 'BAE VALLE DE PALMA (6693)',
    slug: 'bae-valle-de-palma-6693',
    address: 'Av. Julio R. Córdova, Fracc. La Virgen, 78430 Soledad de Graciano Sánchez, S.L.P.',
    city: 'San Luis Potosí',
    state: 'San Luis Potosí',
    latitude: '22.177754',
    longitude: '-100.908005',
    supervisorId: RENE_CUBOS,
    supervisorLabel: 'René Cubos',
  },
]

const strip = (o: any, keys: string[]) => {
  const c = { ...o }
  keys.forEach(k => delete c[k])
  return c
}
const now = new Date()

async function main() {
  console.log(`\n${DRY_RUN ? '🟡 DRY-RUN (no escribe)' : '🔴 EJECUTANDO ESCRITURAS EN PROD'} — ${NEW_VENUES.length} tiendas\n`)

  // ── Pre-condiciones: idempotencia por slug (salta las que ya existen, no aborta el lote —
  //    un intento previo pudo haber creado algunas antes de un timeout de red) + el molde de
  //    VenueRoleConfig debe existir ──
  const alreadyExists = new Set<string>()
  for (const nv of NEW_VENUES) {
    const existing = await prisma.venue.findUnique({ where: { slug: nv.slug }, select: { id: true, name: true } })
    if (existing) {
      console.log(`🟡 "${nv.slug}" ya existe (${existing.name} [${existing.id}]) — se salta, no se toca.`)
      alreadyExists.add(nv.slug)
    }
  }
  const roleConfigTemplates = await prisma.venueRoleConfig.findMany({ where: { venueId: ROLE_CONFIG_TEMPLATE_VENUE_ID } })
  if (roleConfigTemplates.length !== 8) {
    console.error(
      `❌ Esperaba 8 VenueRoleConfig en el molde ${ROLE_CONFIG_TEMPLATE_VENUE_ID}, encontré ${roleConfigTemplates.length}. Abortando.`,
    )
    return
  }

  const pricingCanonical = {
    accountType: 'PRIMARY' as const,
    debitRate: new Prisma.Decimal('0.03'),
    creditRate: new Prisma.Decimal('0.03'),
    amexRate: new Prisma.Decimal('0.035'),
    internationalRate: new Prisma.Decimal('0.033'),
    taxRate: new Prisma.Decimal('0.16'),
    fixedFeePerTransaction: new Prisma.Decimal('3'),
    active: true,
  }
  const moduleConfig = {
    ui: { enableShifts: false, skipTipScreen: true, skipReviewScreen: true, simplifiedOrderFlow: true },
    labels: { item: 'SIM', scan: 'Escanear SIM', barcode: 'ICCID', category: 'Tipo de SIM', register: 'Alta de SIM' },
    features: { enablePortabilidad: true },
    attendance: { requireClockInGps: true, requireClockOutGps: false, requireClockInPhoto: true, requireClockOutPhoto: true },
  }

  console.log('PLAN (por tienda, ×7):')
  for (const nv of NEW_VENUES) {
    console.log(`\n  ── ${nv.name} (${nv.city}, supervisor: ${nv.supervisorLabel}) ──`)
    console.log(`     slug ${nv.slug} · ${nv.address} · lat/lng ${nv.latitude},${nv.longitude}`)
    console.log(`     1. CREAR Venue (type OTHER, status ACTIVE, kycStatus VERIFIED, operationalRole STORE)`)
    console.log(`     2. CREAR VenueSettings (requirePinLogin, trackPromoterLocation 11-18h)`)
    console.log(`     3. CREAR VenueModule SERIALIZED_INVENTORY`)
    console.log(`     4. CREAR VenuePaymentConfig → merchant compartido ${MERCHANT_ID}`)
    console.log(`     5. CREAR VenuePricingStructure (3%/3%/3.5%/3.3%, $3 fija, IVA 16%)`)
    console.log(`     6. CLONAR 8 VenueRoleConfig del molde UNIDAD PAVON`)
    console.log(
      `     7. CREAR StaffVenue ×7: 6 back-office (5 OWNER + 1 ADMIN) + 1 MANAGER (${nv.supervisorLabel}) — SIN promotor, SIN pin`,
    )
    console.log(`     8. ActivityLog VENUE_CREATED + KYC_APPROVED (actor superadmin)`)
  }

  if (DRY_RUN) {
    console.log('\n🟡 DRY-RUN: no se escribió nada. Re-correr con CONFIRM=EJECUTAR para aplicar.')
    return
  }

  const results: { name: string; venueId: string }[] = []

  for (const nv of NEW_VENUES) {
    if (alreadyExists.has(nv.slug)) {
      console.log(`⏭️  ${nv.name} — ya existía, se salta.`)
      continue
    }
    const result = await prisma.$transaction(
      async tx => {
        const venue = await tx.venue.create({
          data: {
            organizationId: ORG_ID,
            name: nv.name,
            slug: nv.slug,
            type: 'OTHER',
            timezone: 'America/Mexico_City',
            currency: 'MXN',
            country: 'MX',
            status: 'ACTIVE',
            kycStatus: 'VERIFIED',
            operationalRole: 'STORE',
            salesEnabled: true,
            address: nv.address,
            city: nv.city,
            state: nv.state,
            latitude: new Prisma.Decimal(nv.latitude),
            longitude: new Prisma.Decimal(nv.longitude),
            active: true,
          },
        })

        await tx.venueSettings.create({
          data: {
            venueId: venue.id,
            requirePinLogin: true,
            trackPromoterLocation: true,
            promoterLocationStartHour: 11,
            promoterLocationEndHour: 18,
          },
        })

        await tx.venueModule.create({
          data: {
            venueId: venue.id,
            moduleId: 'cm6mod001serialized',
            enabled: true,
            config: moduleConfig,
            enabledBy: SUPERADMIN_ACTOR_ID,
            enabledAt: now,
          },
        })

        await tx.venuePaymentConfig.create({
          data: { venueId: venue.id, primaryAccountId: MERCHANT_ID, preferredProcessor: 'AUTO' },
        })

        await tx.venuePricingStructure.create({
          data: {
            venueId: venue.id,
            ...pricingCanonical,
            effectiveFrom: now,
            notes: `Clonada de la tarifa canónica PT — alta ${nv.name} (Asana 1217743599033218)`,
          },
        })

        for (const rc of roleConfigTemplates) {
          await tx.venueRoleConfig.create({
            data: {
              ...strip(rc, ['id', 'venueId', 'createdAt', 'updatedAt']),
              venueId: venue.id,
            },
          })
        }

        for (const bo of BACK_OFFICE) {
          await tx.staffVenue.create({ data: { staffId: bo.staffId, venueId: venue.id, role: bo.role, active: true } })
        }
        const supervisorSv = await tx.staffVenue.create({
          data: { staffId: nv.supervisorId, venueId: venue.id, role: 'MANAGER', active: true },
        })

        const log = (action: string, entity: string, entityId: string, data: any) =>
          tx.activityLog.create({ data: { action, entity, entityId, staffId: SUPERADMIN_ACTOR_ID, venueId: venue.id, data } })
        await log('VENUE_CREATED', 'Venue', venue.id, {
          name: nv.name,
          slug: nv.slug,
          reason: 'Alta de 7 venues nuevos PT (Asana 1217743599033218)',
        })
        await log('KYC_APPROVED', 'Venue', venue.id, {
          kycStatus: 'VERIFIED',
          reason: 'Alta directa PT, mismo patrón que MB Ciudad Satélite',
        })
        await log('STAFF_VENUE_ASSIGNED', 'StaffVenue', supervisorSv.id, {
          staffId: nv.supervisorId,
          role: 'MANAGER',
          label: nv.supervisorLabel,
        })

        return { venueId: venue.id }
      },
      { maxWait: 10000, timeout: 30000 }, // margen generoso: ~20 escrituras contra la DB remota, el default de 5s no alcanza
    )

    console.log(`✅ ${nv.name} creado: ${result.venueId}`)
    results.push({ name: nv.name, venueId: result.venueId })
  }

  console.log(`\n✅ HECHO. ${results.length}/${NEW_VENUES.length} tiendas creadas:`)
  for (const r of results) console.log(`   ${r.name}: ${r.venueId}`)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
