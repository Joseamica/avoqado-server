/**
 * seed-avoqado-fitness-demo.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates a NEW gym-oriented demo venue "Avoqado Fitness" (slug: avoqado-fitness)
 * as a clone of the config of `avoqado-full`, WITHOUT touching avoqado-full.
 *
 * Design doc: docs/superpowers/specs/2026-07-07-avoqado-fitness-demo-clone-design.md
 *
 * SAFETY
 *   - Additive only. Creates a brand-new venue subtree under the existing org
 *     "Grupo Avoqado Prime". Never updates/deletes avoqado-full.
 *   - Idempotent-ish: aborts if slug `avoqado-fitness` already exists (unless --force).
 *   - Reversible: `--teardown` deletes the venue (cascade removes all children).
 *   - No TPV/terminal, no real money (ecommerce merchant is SANDBOX).
 *
 * RUN (against PROD — Render):
 *   DATABASE_URL="postgresql://…render.com/avoqado_db" \
 *     npx ts-node -r tsconfig-paths/register scripts/seed-avoqado-fitness-demo.ts
 *
 * TEARDOWN:
 *   DATABASE_URL="…render…/avoqado_db" \
 *     npx ts-node -r tsconfig-paths/register scripts/seed-avoqado-fitness-demo.ts --teardown
 */
import { ProductType, ReservationChannel, ReservationStatus, ClassSessionStatus, StaffRole } from '@prisma/client'
import { addDays, addMinutes, format } from 'date-fns'
import { fromZonedTime } from 'date-fns-tz'
import { randomBytes } from 'crypto'
import prisma from '../src/utils/prismaClient'
import { saveVenueFeatures } from '../src/services/dashboard/feature.service'
import logger from '../src/config/logger'

// ─── Constants (verified in prod 2026-07-07) ────────────────────────────────
const TEMPLATE_VENUE_ID = 'cmhvejgq300ad2gtxbrawgh7w' // avoqado-full
const ORG_ID = 'cmhvejg1t00a52gtx889cat0e' // Grupo Avoqado Prime
const NEW_SLUG = 'avoqado-fitness'
const NEW_NAME = 'Avoqado Fitness'
const TZ = 'America/Mexico_City'
const ACCENT = '#7ADD2C' // brand green

const FEATURE_CODES = [
  'ADVANCED_ANALYTICS',
  'ADVANCED_REPORTS',
  'AI_ASSISTANT_BUBBLE',
  'AVAILABLE_BALANCE',
  'CHATBOT',
  'INVENTORY_TRACKING',
  'LOYALTY_PROGRAM',
  'ONLINE_ORDERING',
  'RESERVATIONS',
]

// Staff already linked to avoqado-full — reused as logins / instructors.
const STAFF = {
  superadmin: 'cmhvejg9y00a72gtx23p4y2ai', // superadmin@superadmin.com
  owner: 'cmhvejghr00a92gtxxqiqf89b', // owner@owner.com
  admin: 'cmhvejgy600af2gtx94sdj5oh', // admin@admin.com
  manager: 'cmhvejh3n00ah2gtxo8k5clum', // manager@manager.com
  cashier: 'cmhvejh8800aj2gtxjmy99dcr', // cashier@cashier.com
  carlos: 'cmphcfum00007pn9kfh4l4pqw', // Carlos Mendoza (instructor)
  ana: 'cmphcfum00008pn9kfkethcl4', // Ana Torres (instructor)
  sofia: 'cmphcfum1000apn9k01wlekzk', // Sofía Herrera (instructor)
}
const INSTRUCTORS = [STAFF.carlos, STAFF.ana, STAFF.sofia, STAFF.manager]

// ─── Catalog blueprint ───────────────────────────────────────────────────────
type P = { name: string; price: number; sku: string; desc?: string; durationMinutes?: number; maxParticipants?: number }
type Cat = { name: string; slug: string; type: ProductType; displayOrder: number; icon?: string; products: P[] }

const CATALOG: Cat[] = [
  {
    name: 'Membresías',
    slug: 'membresias',
    type: ProductType.REGULAR,
    displayOrder: 0,
    icon: 'card',
    products: [
      { name: 'Inscripción', price: 300, sku: 'MEMB-001', desc: 'Pago único de inscripción.' },
      { name: 'Membresía Mensual', price: 799, sku: 'MEMB-002', desc: 'Acceso ilimitado por 1 mes.' },
      { name: 'Membresía Trimestral', price: 2099, sku: 'MEMB-003', desc: 'Acceso ilimitado por 3 meses.' },
      { name: 'Membresía Anual', price: 6999, sku: 'MEMB-004', desc: 'Acceso ilimitado por 12 meses.' },
      { name: 'Pase Diario', price: 150, sku: 'MEMB-005', desc: 'Acceso por un día.' },
      { name: 'Pase Semanal', price: 499, sku: 'MEMB-006', desc: 'Acceso por 7 días.' },
    ],
  },
  {
    name: 'Clases',
    slug: 'clases',
    type: ProductType.CLASS,
    displayOrder: 1,
    icon: 'activity',
    products: [
      {
        name: 'Indoor Cycling',
        price: 180,
        sku: 'CLASE-001',
        durationMinutes: 45,
        maxParticipants: 20,
        desc: 'Cardio de alta energía sobre bicicleta fija al ritmo de la música.',
      },
      {
        name: 'Spinning Power',
        price: 190,
        sku: 'CLASE-002',
        durationMinutes: 45,
        maxParticipants: 20,
        desc: 'Spinning de resistencia e intervalos de potencia.',
      },
      {
        name: 'HIIT',
        price: 200,
        sku: 'CLASE-003',
        durationMinutes: 45,
        maxParticipants: 16,
        desc: 'Entrenamiento por intervalos de alta intensidad.',
      },
      {
        name: 'Yoga Flow',
        price: 160,
        sku: 'CLASE-004',
        durationMinutes: 60,
        maxParticipants: 15,
        desc: 'Secuencias fluidas de yoga para fuerza y movilidad.',
      },
      {
        name: 'Pilates Reformer',
        price: 250,
        sku: 'CLASE-005',
        durationMinutes: 50,
        maxParticipants: 12,
        desc: 'Pilates en reformer para core y control.',
      },
      {
        name: 'Box Fit',
        price: 210,
        sku: 'CLASE-006',
        durationMinutes: 50,
        maxParticipants: 16,
        desc: 'Boxeo funcional para quemar calorías y liberar estrés.',
      },
      {
        name: 'Zumba',
        price: 150,
        sku: 'CLASE-007',
        durationMinutes: 55,
        maxParticipants: 25,
        desc: 'Baile fitness lleno de energía y ritmo.',
      },
      {
        name: 'Functional Training',
        price: 190,
        sku: 'CLASE-008',
        durationMinutes: 50,
        maxParticipants: 18,
        desc: 'Entrenamiento funcional con peso corporal y kettlebells.',
      },
    ],
  },
  {
    name: 'Entrenamiento & Citas',
    slug: 'entrenamiento',
    type: ProductType.APPOINTMENTS_SERVICE,
    displayOrder: 2,
    icon: 'user-check',
    products: [
      {
        name: 'Sesión Personal Training',
        price: 450,
        sku: 'CITA-001',
        durationMinutes: 60,
        desc: 'Sesión individual con entrenador certificado.',
      },
      { name: 'Valoración InBody', price: 250, sku: 'CITA-002', durationMinutes: 30, desc: 'Análisis de composición corporal.' },
      { name: 'Consulta Nutricional', price: 500, sku: 'CITA-003', durationMinutes: 45, desc: 'Plan de alimentación personalizado.' },
      { name: 'Masaje Deportivo', price: 600, sku: 'CITA-004', durationMinutes: 60, desc: 'Masaje de recuperación muscular.' },
      { name: 'Evaluación Postural', price: 350, sku: 'CITA-005', durationMinutes: 45, desc: 'Análisis postural y de movimiento.' },
    ],
  },
  {
    name: 'Suplementos & Retail',
    slug: 'suplementos',
    type: ProductType.REGULAR,
    displayOrder: 3,
    icon: 'shopping-bag',
    products: [
      { name: 'Proteína Whey 2kg', price: 750, sku: 'SUPP-001', desc: 'Proteína de suero, 2 kg.' },
      { name: 'Pre-Entreno', price: 550, sku: 'SUPP-002', desc: 'Fórmula pre-entrenamiento.' },
      { name: 'Creatina Monohidratada', price: 450, sku: 'SUPP-003', desc: 'Creatina 300 g.' },
      { name: 'Barra Proteica', price: 45, sku: 'SUPP-004', desc: 'Snack alto en proteína.' },
      { name: 'Shaker Avoqado', price: 120, sku: 'SUPP-005', desc: 'Shaker de 600 ml.' },
      { name: 'Guantes de Entrenamiento', price: 250, sku: 'SUPP-006', desc: 'Guantes acolchados.' },
      { name: 'Toalla Avoqado Fitness', price: 180, sku: 'SUPP-007', desc: 'Toalla de microfibra.' },
    ],
  },
  {
    name: 'Bebidas',
    slug: 'bebidas',
    type: ProductType.FOOD_AND_BEV,
    displayOrder: 4,
    icon: 'coffee',
    products: [
      { name: 'Agua Natural 600ml', price: 20, sku: 'BEB-001' },
      { name: 'Bebida Isotónica', price: 35, sku: 'BEB-002' },
      { name: 'Batido Proteico', price: 75, sku: 'BEB-003' },
      { name: 'Smoothie Verde', price: 85, sku: 'BEB-004' },
      { name: 'Café Americano', price: 40, sku: 'BEB-005' },
    ],
  },
]

const rand = (n: number) => randomBytes(n).toString('hex').slice(0, n)

// ─── Config clone helper ─────────────────────────────────────────────────────
/** Read one config row for the template venue and re-create it for `venueId`. */
async function cloneSingletonConfig(model: 'venueSettings' | 'reservationSettings' | 'loyaltyConfig', venueId: string): Promise<boolean> {
  const anyPrisma = prisma as any
  const src = await anyPrisma[model].findUnique({ where: { venueId: TEMPLATE_VENUE_ID } })
  if (!src) {
    logger.warn(`   ⚠️ template has no ${model} — skipping`)
    return false
  }
  const { id: _id, venueId: _v, createdAt: _c, updatedAt: _u, ...rest } = src
  await anyPrisma[model].create({ data: { ...rest, venueId } })
  logger.info(`   ✅ cloned ${model} from avoqado-full`)
  return true
}

// ─── Teardown ────────────────────────────────────────────────────────────────
async function teardown() {
  const venue = await prisma.venue.findUnique({ where: { slug: NEW_SLUG }, select: { id: true, name: true } })
  if (!venue) {
    logger.info(`Nothing to tear down — no venue with slug "${NEW_SLUG}".`)
    return
  }
  if (venue.id === TEMPLATE_VENUE_ID) {
    throw new Error('SAFETY ABORT: teardown target resolved to avoqado-full. Refusing.')
  }
  logger.warn(`🗑️  Deleting venue "${venue.name}" (${venue.id}) and ALL children (cascade)…`)
  await prisma.venue.delete({ where: { id: venue.id } })
  logger.info('✅ Teardown complete. avoqado-full untouched.')
}

// ─── Seed ────────────────────────────────────────────────────────────────────
async function seed(force: boolean) {
  // 0. Guard: venue must not already exist (unless --force reuses/aborts safely)
  const existing = await prisma.venue.findUnique({ where: { slug: NEW_SLUG }, select: { id: true } })
  if (existing) {
    if (!force) {
      throw new Error(`Venue "${NEW_SLUG}" already exists (${existing.id}). Re-run with --teardown first, or --force.`)
    }
    logger.warn(`--force: venue already exists (${existing.id}); tearing down then re-seeding.`)
    await prisma.venue.delete({ where: { id: existing.id } })
  }

  // 1. Venue
  const venue = await prisma.venue.create({
    data: {
      organizationId: ORG_ID,
      name: NEW_NAME,
      slug: NEW_SLUG,
      type: 'FITNESS',
      timezone: TZ,
      currency: 'MXN',
      language: 'es',
      country: 'MX',
      city: 'Ciudad de México',
      status: 'ACTIVE',
      active: true,
      kycStatus: 'VERIFIED', // KYC approved — venue reads as fully onboarded (matches avoqado-full)
      entityType: 'PERSONA_MORAL',
      seatCapExempt: true, // grandfathered — no tier/seat gating (matches avoqado-full)
      primaryColor: ACCENT,
      operationalSince: new Date(),
    },
  })
  const venueId = venue.id
  logger.info(`🏋️  Venue created: ${NEW_NAME} → ${venueId}`)

  // 2. Cloned config
  await cloneSingletonConfig('venueSettings', venueId)
  await cloneSingletonConfig('reservationSettings', venueId)
  await cloneSingletonConfig('loyaltyConfig', venueId)

  // 3. Features
  const features = await prisma.feature.findMany({ where: { code: { in: FEATURE_CODES }, active: true }, select: { id: true, code: true } })
  await saveVenueFeatures(
    venueId,
    features.map(f => f.id),
  )
  logger.info(`   ✅ Features: ${features.map(f => f.code).join(', ')}`)

  // 4. Staff logins + instructors
  const links: Array<[string, StaffRole]> = [
    [STAFF.superadmin, StaffRole.SUPERADMIN],
    [STAFF.owner, StaffRole.OWNER],
    [STAFF.admin, StaffRole.ADMIN],
    [STAFF.manager, StaffRole.MANAGER],
    [STAFF.cashier, StaffRole.CASHIER],
    [STAFF.carlos, StaffRole.MANAGER],
    [STAFF.ana, StaffRole.MANAGER],
    [STAFF.sofia, StaffRole.MANAGER],
  ]
  for (const [staffId, role] of links) {
    await prisma.staffVenue.upsert({
      where: { staffId_venueId: { staffId, venueId } },
      update: { active: true, role },
      create: { staffId, venueId, role, active: true },
    })
  }
  logger.info(`   ✅ Staff linked: ${links.length} (logins + instructors)`)

  // 5. Menu
  const menu = await prisma.menu.create({ data: { venueId, name: 'Membresías & Servicios', type: 'REGULAR', active: true } })

  // 6. Categories + products
  const productByName = new Map<string, { id: string; type: ProductType; durationMinutes?: number; maxParticipants?: number }>()
  let productCount = 0
  for (const cat of CATALOG) {
    const category = await prisma.menuCategory.create({
      data: { venueId, name: cat.name, slug: cat.slug, displayOrder: cat.displayOrder, icon: cat.icon, color: ACCENT, active: true },
    })
    await prisma.menuCategoryAssignment.create({ data: { menuId: menu.id, categoryId: category.id, displayOrder: cat.displayOrder } })

    let order = 0
    for (const p of cat.products) {
      const created = await prisma.product.create({
        data: {
          venueId,
          categoryId: category.id,
          sku: p.sku,
          name: p.name,
          description: p.desc,
          type: cat.type,
          price: p.price,
          displayOrder: order++,
          active: true,
          ...(cat.type === ProductType.CLASS
            ? {
                durationMinutes: p.durationMinutes,
                duration: p.durationMinutes,
                maxParticipants: p.maxParticipants,
                allowCreditRedemption: true,
              }
            : {}),
          ...(cat.type === ProductType.APPOINTMENTS_SERVICE ? { durationMinutes: p.durationMinutes, duration: p.durationMinutes } : {}),
        },
      })
      productByName.set(p.name, { id: created.id, type: cat.type, durationMinutes: p.durationMinutes, maxParticipants: p.maxParticipants })
      productCount++
    }
    logger.info(`   ✅ Category "${cat.name}" + ${cat.products.length} products`)
  }

  // 7. Class sessions — next 21 days, non-Sundays, 4 slots/day, round-robin class + instructor
  const classProducts = CATALOG.find(c => c.slug === 'clases')!.products.map(p => productByName.get(p.name)!)
  const slots = ['07:00', '09:00', '18:00', '19:30']
  const base = new Date()
  base.setHours(12, 0, 0, 0)
  let rr = 0
  let sessionCount = 0
  for (let d = 0; d < 21; d++) {
    const day = addDays(base, d)
    if (day.getDay() === 0) continue // skip Sundays (venue closed)
    const ymd = format(day, 'yyyy-MM-dd')
    for (const t of slots) {
      const cls = classProducts[rr % classProducts.length]
      const instructor = INSTRUCTORS[rr % INSTRUCTORS.length]
      rr++
      const dur = cls.durationMinutes ?? 45
      const startsAt = fromZonedTime(`${ymd}T${t}:00`, TZ)
      const endsAt = addMinutes(startsAt, dur)
      await prisma.classSession.create({
        data: {
          venueId,
          productId: cls.id,
          startsAt,
          endsAt,
          duration: dur,
          capacity: cls.maxParticipants ?? 16,
          assignedStaffId: instructor,
          createdById: STAFF.owner,
          status: ClassSessionStatus.SCHEDULED,
        },
      })
      sessionCount++
    }
  }
  logger.info(`   ✅ ClassSessions: ${sessionCount} (next 21 days, Mon–Sat)`)

  // 8. Credit packs (paquetes) + items
  const pid = (name: string) => productByName.get(name)!.id
  const packs = [
    {
      name: 'Paquete 5 Clases',
      price: 800,
      validityDays: 30,
      displayOrder: 0,
      desc: 'Cinco clases para usar cuando quieras.',
      items: [{ name: 'Indoor Cycling', quantity: 5 }],
    },
    {
      name: 'Paquete 10 Clases Mixto',
      price: 1500,
      validityDays: 45,
      displayOrder: 1,
      desc: 'Diez clases combinables entre cycling, HIIT y yoga.',
      items: [
        { name: 'Indoor Cycling', quantity: 4 },
        { name: 'HIIT', quantity: 3 },
        { name: 'Yoga Flow', quantity: 3 },
      ],
    },
    {
      name: 'Paquete Premium 20 Clases',
      price: 2900,
      validityDays: 60,
      displayOrder: 2,
      desc: 'Veinte clases para todo el catálogo.',
      items: [
        { name: 'Indoor Cycling', quantity: 3 },
        { name: 'Spinning Power', quantity: 3 },
        { name: 'HIIT', quantity: 3 },
        { name: 'Yoga Flow', quantity: 3 },
        { name: 'Pilates Reformer', quantity: 2 },
        { name: 'Box Fit', quantity: 2 },
        { name: 'Zumba', quantity: 2 },
        { name: 'Functional Training', quantity: 2 },
      ],
    },
  ]
  for (const pack of packs) {
    const created = await prisma.creditPack.create({
      data: {
        venueId,
        name: pack.name,
        description: pack.desc,
        price: pack.price,
        currency: 'MXN',
        validityDays: pack.validityDays,
        displayOrder: pack.displayOrder,
        active: true,
        items: { create: pack.items.map(i => ({ productId: pid(i.name), quantity: i.quantity })) },
      },
    })
    void created
  }
  logger.info(`   ✅ Credit packs: ${packs.length}`)

  // 9. Sample appointment reservations (non-fatal)
  const ptId = pid('Sesión Personal Training')
  const sampleNames = [
    { name: 'Laura Gómez', phone: '+525511112222', d: 1, t: '10:00' },
    { name: 'Diego Martínez', phone: '+525533334444', d: 2, t: '17:00' },
    { name: 'Paola Ruiz', phone: '+525555556666', d: 3, t: '11:00' },
  ]
  let resCount = 0
  for (const s of sampleNames) {
    try {
      const day = addDays(base, s.d)
      const ymd = format(day, 'yyyy-MM-dd')
      const startsAt = fromZonedTime(`${ymd}T${s.t}:00`, TZ)
      const endsAt = addMinutes(startsAt, 60)
      await prisma.reservation.create({
        data: {
          venueId,
          productId: ptId,
          confirmationCode: `PT-${rand(6).toUpperCase()}`,
          cancelSecret: rand(24),
          startsAt,
          endsAt,
          duration: 60,
          partySize: 1,
          channel: ReservationChannel.DASHBOARD,
          status: ReservationStatus.CONFIRMED,
          guestName: s.name,
          guestPhone: s.phone,
          assignedStaffId: STAFF.carlos,
        },
      })
      resCount++
    } catch (e) {
      logger.warn(`   ⚠️ sample reservation "${s.name}" skipped: ${(e as Error).message}`)
    }
  }
  logger.info(`   ✅ Sample reservations: ${resCount}`)

  // 10. Summary
  logger.info('')
  logger.info('════════════════════════ RESUMEN ════════════════════════')
  logger.info(`Venue:        ${NEW_NAME}  (${venueId})`)
  logger.info(`Slug:         ${NEW_SLUG}  ·  type FITNESS  ·  org Grupo Avoqado Prime`)
  logger.info(`Categorías:   ${CATALOG.length}`)
  logger.info(`Productos:    ${productCount}`)
  logger.info(`ClassSessions:${sessionCount}`)
  logger.info(`Credit packs: ${packs.length}`)
  logger.info(`Reservas:     ${resCount}`)
  logger.info(`Booking:      https://book.avoqado.io/${NEW_SLUG}/classes`)
  logger.info('══════════════════════════════════════════════════════════')
  logger.info('✅ Seed completo. avoqado-full intacto.')
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const dbUrl = process.env.DATABASE_URL ?? ''
  const host = dbUrl.split('@')[1]?.split('/')[0] ?? 'unknown'
  const dbName = dbUrl.split('/').pop()?.split('?')[0] ?? 'unknown'
  logger.info(`🎯 Target DB: ${dbName} @ ${host}`)

  if (args.includes('--teardown')) {
    await teardown()
    return
  }
  await seed(args.includes('--force'))
}

main()
  .catch(err => {
    logger.error('❌ Failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
