/**
 * Negocios demo en producción (opción A del founder, 29-oct-2026): un negocio por giro, con un usuario compartido, para
 * que un prospecto juegue con el panel y la app. Cada giro vive en su organización «Avoqado Demo · <giro>», con
 * `status = LIVE_DEMO`, así el candado (`./candadoDemo.ts`) no deja que nada salga al mundo real.
 *
 * Cada noche (`jobs/negocios-demo-reinicio.job.ts`) cada negocio se BORRA entero y vuelve a nacer con un id nuevo, el
 * mismo nombre, el mismo enlace (slug) y el mismo usuario. Id nuevo a propósito: 82 tablas guardan el `venueId` sin
 * borrarse con el negocio, y con el mismo id esos restos «revivirían» en el demo limpio (Codex r1, hallazgo 10).
 *
 * Plan y promesa: Avoqado/docs/audit/2026-10-28-negocios-demo/. Primera creación en producción: a mano, con el «sí, en
 * prod» del founder (`npx tsx scripts/seed-demo-venues.ts`). El job sólo reinicia una organización demo que ya existe.
 */

import {
  BusinessType,
  VenueType,
  ProductType,
  PaymentMethod,
  OrderType,
  OrderStatus,
  PaymentStatus,
  CommissionRecipient,
  CommissionTrigger,
  CommissionCalcType,
  ReservationStatus,
  DepositStatus,
  BatchStatus,
  RawMaterialCategory,
  Unit,
  UnitType,
  Prisma,
  VenueStatus,
} from '@prisma/client'
import { addDays, subDays } from 'date-fns'
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz'
import bcrypt from 'bcryptjs'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { deleteVenueDataTx, DELETION_TIMEOUT_MS } from '@/services/cleanup/liveDemoCleanup.service'
import { conNegocio, DOMINIO_DEMO, olvidarNegocioDemo } from './candadoDemo'

import { generateSlug } from '@/utils/slugify'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings, getMappings } from '@/services/fiscal/accountMapping.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { createProduct } from '@/services/dashboard/product.dashboard.service'
import { createCommissionConfig } from '@/services/dashboard/commission/commission-config.service'
import { createPaymentLink } from '@/services/dashboard/paymentLink.service'
import { encryptProviderKey } from '@/services/fiscal/fiscalKey.service'

// ════════════════════════════════════════════════════════════════════════════
// Stable identity keys (idempotency anchors)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cada giro vive en SU organización, como un cliente real: el panel trata al dueño de una sucursal como dueño de toda su
 * organización, así que con una sola organización el prospecto del salón veía (y operaba) los seis demos.
 */
const PREFIJO_ORG_DEMO = 'avoqado-demo-'
const slugDeOrgDemo = (clave: string) => `${PREFIJO_ORG_DEMO}${clave}`
const DEMO_OWNER_EMAIL = `demos@${DOMINIO_DEMO}`
/** El usuario que se le comparte al prospecto de cada giro. */
export const correoDelDemo = (clave: string) => `${clave}@${DOMINIO_DEMO}`
const PIN_DEMO = '1234'
const DEMO_TZ = 'America/Mexico_City'

// ════════════════════════════════════════════════════════════════════════════
// Venue blueprints (EXACT data from the spec)
// ════════════════════════════════════════════════════════════════════════════

type RegularProduct = { name: string; sku: string; price: number; stock: number; description?: string }
type ServiceProduct = { name: string; sku: string; price: number; durationMinutes: number; description?: string }
type Consumable = {
  name: string
  sku: string
  unit: Unit
  unitType: UnitType
  currentStock: number
  costPerUnit: number
  expiresInDays: number
  lote: string
}

interface VenueBlueprint {
  key: string
  name: string
  type: VenueType
  businessType: BusinessType
  city: string
  state: string
  zipCode: string
  address: string
  staffName: { first: string; last: string }
  staffRole: 'vendedor' | 'especialista'
  /** Decimal rate, e.g. 0.04 = 4%. */
  commissionRate: number
  /** Optional tier: rate over `tierThreshold` MXN/month. */
  tier?: { threshold: number; rate: number }
  loyalty: { pointsPerDollar: number; pointsPerVisit: number; minPointsRedeem: number }
  regulars: RegularProduct[]
  services: ServiceProduct[]
  consumables: Consumable[]
  /** Demo RFC so the chart-of-accounts (póliza) seeds without depending on Facturapi. */
  rfc: string
  legalName: string
  /** Whether to seed a future appointment (SALON + CLINIC). */
  seedReservation: boolean
  /** Ventas pagadas en los últimos 30 días (un mes que se vea real). */
  historyOrders: number
  /** Restaurante: mesas del área «Salón» (para el modo Mesas del POS). */
  mesas?: number
  /** Payment-link title (branded). */
  paymentLinkTitle: string
}

const BLUEPRINTS: VenueBlueprint[] = [
  // ─── 1. Lunaria Boutique — RETAIL_STORE ────────────────────────────────────
  {
    key: 'lunaria',
    name: 'Lunaria Boutique',
    type: VenueType.RETAIL_STORE,
    businessType: BusinessType.RETAIL_STORE,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '06700',
    address: 'Av. Álvaro Obregón 145, Roma Norte',
    staffName: { first: 'Paola', last: 'Ríos' },
    staffRole: 'vendedor',
    commissionRate: 0.04,
    tier: { threshold: 20000, rate: 0.05 },
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 }, // 1 pto por $10
    regulars: [
      { name: 'Blusa de lino', sku: 'LUN-BLU-001', price: 590, stock: 24 },
      { name: 'Jeans mom fit', sku: 'LUN-JEA-002', price: 890, stock: 18 },
      { name: 'Vestido midi', sku: 'LUN-VES-003', price: 1290, stock: 12 },
      { name: 'Bolsa de piel', sku: 'LUN-BOL-004', price: 1850, stock: 8 },
      { name: 'Aretes de plata', sku: 'LUN-ARE-005', price: 450, stock: 30 },
    ],
    services: [],
    consumables: [],
    rfc: 'LBO250630AB1',
    legalName: 'Lunaria Boutique SA de CV',
    seedReservation: false,
    historyOrders: 150,
    paymentLinkTitle: 'Lunaria Boutique — Pago en tienda',
  },

  // ─── 2. Studio Bloom — SALON ───────────────────────────────────────────────
  {
    key: 'bloom',
    name: 'Studio Bloom',
    type: VenueType.SALON,
    businessType: BusinessType.OTHER,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '06140',
    address: 'Av. Tamaulipas 66, Condesa',
    staffName: { first: 'Mariana', last: 'Cano' },
    staffRole: 'especialista',
    commissionRate: 0.3, // 30% por servicio
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [{ name: 'Shampoo profesional', sku: 'BLO-SHA-001', price: 320, stock: 15 }],
    services: [
      { name: 'Corte y peinado', sku: 'BLO-COR-001', price: 450, durationMinutes: 45 },
      { name: 'Tinte completo', sku: 'BLO-TIN-002', price: 1200, durationMinutes: 120 },
      { name: 'Manicure en gel', sku: 'BLO-MAN-003', price: 350, durationMinutes: 60 },
      { name: 'Facial hidratante', sku: 'BLO-FAC-004', price: 800, durationMinutes: 60 },
      { name: 'Depilación con cera', sku: 'BLO-DEP-005', price: 400, durationMinutes: 30 },
    ],
    consumables: [],
    rfc: 'SBL250630CD2',
    legalName: 'Studio Bloom SA de CV',
    seedReservation: true,
    historyOrders: 120,
    paymentLinkTitle: 'Studio Bloom — Pago de servicio',
  },

  // ─── 3. Dermédica — CLINIC (híbrido) ───────────────────────────────────────
  {
    key: 'dermedica',
    name: 'Dermédica',
    type: VenueType.CLINIC,
    businessType: BusinessType.OTHER,
    city: 'Ciudad de México',
    state: 'CDMX',
    zipCode: '11560',
    address: 'Av. Presidente Masaryk 220, Polanco',
    staffName: { first: 'Elena', last: 'Ruiz' },
    staffRole: 'especialista',
    commissionRate: 0.15, // "comisión por servicio" — sin tasa explícita en spec; 15% razonable
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [
      { name: 'Protector solar SPF50', sku: 'DER-SPF-001', price: 620, stock: 20 },
      { name: 'Crema retinol 0.3%', sku: 'DER-RET-002', price: 980, stock: 14 },
      { name: 'Limpiador facial', sku: 'DER-LIM-003', price: 540, stock: 18 },
    ],
    services: [
      { name: 'Consulta dermatológica', sku: 'DER-CON-001', price: 900, durationMinutes: 30 },
      { name: 'Limpieza facial profunda', sku: 'DER-LFP-002', price: 1200, durationMinutes: 60 },
      { name: 'Aplicación de toxina botulínica', sku: 'DER-TOX-003', price: 6500, durationMinutes: 45 },
      { name: 'Peeling químico', sku: 'DER-PEE-004', price: 2500, durationMinutes: 45 },
    ],
    consumables: [
      {
        name: 'Vial de toxina botulínica',
        sku: 'DER-RM-TOX',
        unit: Unit.UNIT,
        unitType: UnitType.COUNT,
        currentStock: 6,
        costPerUnit: 3200,
        expiresInDays: 180,
        lote: 'TOX-LOTE-A1',
      },
      {
        name: 'Jeringa de ácido hialurónico',
        sku: 'DER-RM-AH',
        unit: Unit.UNIT,
        unitType: UnitType.COUNT,
        currentStock: 10,
        costPerUnit: 1800,
        expiresInDays: 365,
        lote: 'AH-LOTE-B2',
      },
    ],
    rfc: 'DER250630EF3',
    legalName: 'Dermédica SA de CV',
    seedReservation: true,
    historyOrders: 90,
    paymentLinkTitle: 'Dermédica — Pago de consulta',
  },

  // ─── 4. Casa Jacaranda — RESTAURANT ───────────────────────────────────────
  {
    key: 'restaurante',
    name: 'Casa Jacaranda',
    type: VenueType.RESTAURANT,
    businessType: BusinessType.RESTAURANT,
    city: 'Guadalajara',
    state: 'Jalisco',
    zipCode: '44160',
    address: 'Av. Chapultepec 210, Americana',
    staffName: { first: 'Luis', last: 'Herrera' },
    staffRole: 'vendedor',
    commissionRate: 0.02,
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [
      { name: 'Tacos de arrachera', sku: 'JAC-TAC-001', price: 189, stock: 200 },
      { name: 'Enchiladas suizas', sku: 'JAC-ENC-002', price: 165, stock: 200 },
      { name: 'Sopa de tortilla', sku: 'JAC-SOP-003', price: 95, stock: 200 },
      { name: 'Guacamole con totopos', sku: 'JAC-GUA-004', price: 125, stock: 200 },
      { name: 'Agua fresca de jamaica', sku: 'JAC-AGU-005', price: 45, stock: 300 },
      { name: 'Cerveza artesanal', sku: 'JAC-CER-006', price: 85, stock: 240 },
      { name: 'Flan napolitano', sku: 'JAC-FLA-007', price: 70, stock: 120 },
    ],
    services: [],
    consumables: [],
    rfc: 'CJA250630GH4',
    legalName: 'Casa Jacaranda SA de CV',
    seedReservation: false,
    historyOrders: 210,
    paymentLinkTitle: 'Casa Jacaranda — Anticipo de evento',
    mesas: 8,
  },

  // ─── 5. Café Tostado — CAFE ───────────────────────────────────────────────
  {
    key: 'cafeteria',
    name: 'Café Tostado',
    type: VenueType.CAFE,
    businessType: BusinessType.CAFE,
    city: 'Puebla',
    state: 'Puebla',
    zipCode: '72000',
    address: 'Calle 5 de Mayo 410, Centro',
    staffName: { first: 'Carla', last: 'Vega' },
    staffRole: 'vendedor',
    commissionRate: 0.02,
    loyalty: { pointsPerDollar: 0, pointsPerVisit: 10, minPointsRedeem: 100 }, // 10 visitas = 1 premio
    regulars: [
      { name: 'Americano', sku: 'TOS-AME-001', price: 45, stock: 500 },
      { name: 'Capuchino', sku: 'TOS-CAP-002', price: 58, stock: 500 },
      { name: 'Latte de vainilla', sku: 'TOS-LAT-003', price: 65, stock: 500 },
      { name: 'Chai latte', sku: 'TOS-CHA-004', price: 62, stock: 400 },
      { name: 'Croissant de mantequilla', sku: 'TOS-CRO-005', price: 42, stock: 80 },
      { name: 'Concha de chocolate', sku: 'TOS-CON-006', price: 25, stock: 90 },
      { name: 'Bolsa de café en grano 250 g', sku: 'TOS-BOL-007', price: 210, stock: 40 },
    ],
    services: [],
    consumables: [],
    rfc: 'CTO250630IJ5',
    legalName: 'Café Tostado SA de CV',
    seedReservation: false,
    historyOrders: 260,
    paymentLinkTitle: 'Café Tostado — Pedido para llevar',
  },

  // ─── 6. Pulso Fitness — FITNESS ───────────────────────────────────────────
  {
    key: 'gimnasio',
    name: 'Pulso Fitness',
    type: VenueType.FITNESS,
    businessType: BusinessType.OTHER,
    city: 'Monterrey',
    state: 'Nuevo León',
    zipCode: '64620',
    address: 'Av. Vasconcelos 330, San Pedro Garza García',
    staffName: { first: 'Diego', last: 'Salinas' },
    staffRole: 'especialista',
    commissionRate: 0.1,
    loyalty: { pointsPerDollar: 0.1, pointsPerVisit: 0, minPointsRedeem: 100 },
    regulars: [
      { name: 'Agua natural 1 L', sku: 'PUL-AGU-001', price: 25, stock: 120 },
      { name: 'Bebida isotónica', sku: 'PUL-ISO-002', price: 35, stock: 90 },
      { name: 'Proteína en polvo 1 kg', sku: 'PUL-PRO-003', price: 890, stock: 15 },
      { name: 'Toalla Pulso', sku: 'PUL-TOA-004', price: 220, stock: 25 },
      { name: 'Mensualidad', sku: 'PUL-MEN-005', price: 1290, stock: 999 },
    ],
    services: [
      { name: 'Clase de spinning', sku: 'PUL-SPI-001', price: 180, durationMinutes: 45 },
      { name: 'Clase de yoga', sku: 'PUL-YOG-002', price: 160, durationMinutes: 60 },
      { name: 'Entrenamiento personal', sku: 'PUL-ENT-003', price: 450, durationMinutes: 60 },
    ],
    consumables: [],
    rfc: 'PFI250630KL6',
    legalName: 'Pulso Fitness SA de CV',
    seedReservation: true,
    historyOrders: 140,
    paymentLinkTitle: 'Pulso Fitness — Pago de mensualidad',
  },
]

// ════════════════════════════════════════════════════════════════════════════
// La organización de cada giro (por slug; nunca se borra) + su dueño interno
// ════════════════════════════════════════════════════════════════════════════

async function ensureDemoOrgAndOwner(bp: VenueBlueprint): Promise<{ organizationId: string; ownerStaffId: string }> {
  const DEMO_ORG_SLUG = slugDeOrgDemo(bp.key)
  const DEMO_ORG_NAME = `Avoqado Demo · ${bp.name}`
  // Organization (stable by slug — never recreated).
  const org = await prisma.organization.upsert({
    where: { slug: DEMO_ORG_SLUG },
    update: {},
    create: {
      name: DEMO_ORG_NAME,
      slug: DEMO_ORG_SLUG,
      email: 'demos@avoqado.io',
      phone: '5500000000',
      type: BusinessType.OTHER,
    },
  })

  // Owner Staff (stable by globally-unique email).
  const owner = await prisma.staff.upsert({
    where: { email: DEMO_OWNER_EMAIL },
    update: {},
    create: {
      email: DEMO_OWNER_EMAIL,
      firstName: 'Avoqado',
      lastName: 'Demos',
      phone: '5500000000',
      active: true,
      emailVerified: true,
    },
  })

  // Membership (stable by composite unique).
  await prisma.staffOrganization.upsert({
    where: { staffId_organizationId: { staffId: owner.id, organizationId: org.id } },
    update: { isActive: true },
    create: {
      staffId: owner.id,
      organizationId: org.id,
      role: 'OWNER',
      isActive: true,
      isPrimary: true,
    },
  })

  logger.info(`✅ Organización demo "${DEMO_ORG_NAME}" (${org.id}) lista`)
  return { organizationId: org.id, ownerStaffId: owner.id }
}

// ════════════════════════════════════════════════════════════════════════════
// Reinicio: el negocio demo se borra entero y vuelve a nacer (id nuevo, mismo nombre, enlace y usuario)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cambia el negocio demo del giro por uno nuevo EN UNA SOLA TRANSACCIÓN: o queda el viejo, o queda el nuevo, nunca un
 * hueco. El nuevo nace directo en `LIVE_DEMO` (sin pasar por el alta ni por `TRIAL`) y con el usuario del giro ya
 * adentro. El demo anterior se reconoce por su usuario, no por su nombre, que el prospecto puede cambiar (Codex r2, 6 y 7).
 * Las sesiones NO se cierran: el panel entra al negocio nuevo por su enlace, y cerrar una sesión deja al panel en un ciclo
 * (aviso aparte en el tablero). La sesión vieja no se salta el candado porque las reglas también miran al USUARIO.
 */
async function recrearNegocio(bp: VenueBlueprint, organizationId: string, usuarioDemoId: string): Promise<string> {
  const anteriores = await prisma.venue.findMany({
    where: { organizationId, staff: { some: { staffId: usuarioDemoId } } },
    select: { id: true, status: true },
    take: 10,
  })
  const otro = anteriores.find(v => v.status !== VenueStatus.LIVE_DEMO)
  if (otro) throw new Error(`🚨 El usuario de «${bp.name}» está en un negocio ${otro.status}, no LIVE_DEMO: no se toca`)

  const venue = await prisma.$transaction(
    async tx => {
      // Candado de la fila y estado releído ANTES de borrar: si un SUPERADMIN aprobó el KYC entre la lectura de arriba y
      // aquí, el negocio ya es real y no se toca (Codex r6, 1). Ordenados por id para no cruzarse con otro candado.
      for (const id of anteriores.map(v => v.id).sort()) {
        const [fila] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Venue" WHERE id = ${id} FOR UPDATE`
        if (fila && fila.status !== VenueStatus.LIVE_DEMO)
          throw new Error(`🚨 El negocio ${id} de «${bp.name}» ya es ${fila.status}, no LIVE_DEMO: no se toca`)
      }
      let filas = 0
      for (const v of anteriores) filas += await deleteVenueDataTx(tx, v.id)
      // La contabilidad del RFC va en la MISMA transacción: si algo falla, el demo viejo queda con sus libros (Codex r3, 5).
      await borrarContabilidadDemoTx(tx, organizationId, bp.rfc)
      if (anteriores.length) logger.info(`   🗑️  Negocio demo anterior borrado (${filas} filas)`)

      // El enlace de siempre; si un negocio real ya lo usa, el demo lleva «-demo».
      const base = generateSlug(bp.name)
      const ocupado = await tx.venue.findUnique({ where: { slug: base }, select: { id: true } })
      const slug = ocupado ? `${base}-demo` : base
      const ahora = new Date()
      const nuevo = await tx.venue.create({
        data: {
          organizationId,
          name: bp.name,
          slug,
          type: bp.type,
          timezone: DEMO_TZ,
          currency: 'MXN',
          country: 'MX',
          address: bp.address,
          city: bp.city,
          state: bp.state,
          zipCode: bp.zipCode,
          phone: '5500000000',
          email: correoDelDemo(bp.key),
          rfc: bp.rfc,
          status: VenueStatus.LIVE_DEMO,
          statusChangedAt: ahora,
          demoExpiresAt: null,
          onboardingCompletedAt: ahora,
          active: true,
          operationalSince: ahora,
        },
        select: { id: true, slug: true },
      })
      // Sólo el usuario del giro: el dueño interno de la organización no aparece en el equipo que ve el prospecto.
      await tx.staffVenue.create({ data: { staffId: usuarioDemoId, venueId: nuevo.id, role: 'OWNER', active: true, pin: PIN_DEMO } })
      await tx.venueSettings.create({
        data: { venueId: nuevo.id, autoCloseShifts: false, requirePinLogin: true, notifyBadReviews: false, badReviewThreshold: 3 },
      })
      return nuevo
    },
    { timeout: DELETION_TIMEOUT_MS },
  )

  for (const v of anteriores) olvidarNegocioDemo(v.id)
  olvidarNegocioDemo(venue.id)
  logger.info(`   🏗️  Negocio demo listo: ${venue.id} (slug ${venue.slug})`)
  return venue.id
}

/**
 * La contabilidad vive por (organización, RFC), no por negocio, así que borrar el negocio no la toca: un periodo cerrado o
 * una póliza a mano de un prospecto sobrevivían al reinicio e impedían generar las pólizas nuevas (Codex r1, hallazgo 10).
 * Sólo en la organización demo (las precondiciones de `sembrarNegociosDemo` ya comprobaron que todos sus negocios son
 * LIVE_DEMO). Una prueba falla si aparece otro modelo con `organizationId` + `rfc` sin decidir aquí qué hacer con él.
 */
export const MODELOS_POR_RFC_DEL_DEMO = [
  'JournalEntry',
  'AccountMapping',
  'LedgerAccount',
  'AccountingPeriodLock',
  'Expense',
  'SalesRetention',
  'FiscalLossCarryforward',
  'FixedAsset',
  'Employee',
  'PayrollRun',
] as const

async function borrarContabilidadDemoTx(tx: Prisma.TransactionClient, organizationId: string, rfc: string): Promise<void> {
  const donde = { organizationId, rfc }
  await tx.journalEntry.deleteMany({ where: donde }) // sus renglones caen en cascada
  await tx.accountMapping.deleteMany({ where: donde })
  await tx.ledgerAccount.updateMany({ where: donde, data: { parentId: null } }) // el padre es RESTRICT
  await tx.ledgerAccount.deleteMany({ where: donde })
  await tx.accountingPeriodLock.deleteMany({ where: donde })
  await tx.expense.deleteMany({ where: donde })
  await tx.salesRetention.deleteMany({ where: donde })
  await tx.fiscalLossCarryforward.deleteMany({ where: donde })
  await tx.fixedAssetDepreciation.deleteMany({ where: { fixedAsset: donde } })
  await tx.fixedAsset.deleteMany({ where: donde })
  await tx.payrollRun.deleteMany({ where: donde })
  await tx.employee.deleteMany({ where: donde })
}

/**
 * El usuario que se le comparte al prospecto (sin negocio todavía: lo recibe en `recrearNegocio`). Miembro de la
 * organización, no dueño, para que no vea los otros demos. La contraseña sale de `NEGOCIOS_DEMO_PASSWORD`; sólo se vuelve a
 * escribir si cambió.
 */
async function asegurarUsuarioDemo(bp: VenueBlueprint, organizationId: string, password: string): Promise<string> {
  const email = correoDelDemo(bp.key)
  const actual = await prisma.staff.findUnique({ where: { email }, select: { id: true, password: true } })
  const igual = actual?.password ? await bcrypt.compare(password, actual.password) : false
  const datos = { firstName: 'Demo', lastName: bp.name, active: true, emailVerified: true }
  const staff = actual
    ? await prisma.staff.update({
        where: { id: actual.id },
        data: { ...datos, ...(igual ? {} : { password: await bcrypt.hash(password, 12) }) },
      })
    : await prisma.staff.create({ data: { ...datos, email, password: await bcrypt.hash(password, 12) } })
  await prisma.staffOrganization.upsert({
    where: { staffId_organizationId: { staffId: staff.id, organizationId } },
    update: { isActive: true, role: 'MEMBER' },
    create: { staffId: staff.id, organizationId, role: 'MEMBER', isActive: true, isPrimary: true },
  })
  logger.info(`   👤 Usuario demo ${email} (dueño de su negocio, PIN ${PIN_DEMO})`)
  return staff.id
}

/** Restaurante: un área «Salón» con sus mesas, para el modo Mesas del POS. */
async function sembrarMesas(bp: VenueBlueprint, venueId: string): Promise<void> {
  if (!bp.mesas) return
  const area = await prisma.area.create({ data: { venueId, name: 'Salón' } })
  for (let n = 1; n <= bp.mesas; n++) {
    await prisma.table.create({
      data: { venueId, areaId: area.id, number: String(n), capacity: n % 3 === 0 ? 6 : 4, qrCode: `demo-${venueId}-mesa-${n}` },
    })
  }
  logger.info(`   🍽️  ${bp.mesas} mesas en el Salón`)
}

// ════════════════════════════════════════════════════════════════════════════
// Features + modules
// ════════════════════════════════════════════════════════════════════════════

async function enableCommissionsModule(venueId: string, ownerStaffId: string): Promise<void> {
  const module = await prisma.module.findUnique({ where: { code: 'COMMISSIONS' }, select: { id: true } })
  if (!module) {
    logger.warn('   ⚠️ COMMISSIONS module not found — skipping module enable')
    return
  }
  await prisma.venueModule.upsert({
    where: { venueId_moduleId: { venueId, moduleId: module.id } },
    update: { enabled: true },
    create: { venueId, moduleId: module.id, enabled: true, enabledBy: ownerStaffId },
  })
  logger.info('   ✅ COMMISSIONS module enabled')
}

// ════════════════════════════════════════════════════════════════════════════
// Catalog: category + products (REGULAR with stock) + services (APPOINTMENTS)
// ════════════════════════════════════════════════════════════════════════════

interface SeededProduct {
  id: string
  name: string
  price: number
  type: ProductType
}

async function seedCatalog(bp: VenueBlueprint, venueId: string): Promise<SeededProduct[]> {
  const seeded: SeededProduct[] = []

  // --- Category for retail products ---
  if (bp.regulars.length > 0) {
    const catName = bp.type === VenueType.RETAIL_STORE ? 'Catálogo' : 'Productos'
    const productCat = await prisma.menuCategory.create({
      data: { venueId, name: catName, slug: `${bp.key}-productos`, active: true, displayOrder: 1, isDemo: true },
    })

    for (const p of bp.regulars) {
      const product = await createProduct(
        venueId,
        {
          name: p.name,
          description: p.description,
          price: p.price,
          type: ProductType.REGULAR,
          sku: p.sku,
          categoryId: productCat.id,
        },
        { type: 'SERVICE', servicePrincipalId: 'DEMO_VENUE_SEED' },
      )

      // Turn on quantity inventory tracking + create the stock row (mirrors the
      // café seeder's seedProductInventory pattern).
      await prisma.product.update({
        where: { id: product.id },
        data: { inventoryMethod: 'QUANTITY', unit: Unit.UNIT },
      })
      await prisma.inventory.create({
        data: {
          venueId,
          productId: product.id,
          currentStock: p.stock,
          minimumStock: Math.max(2, Math.floor(p.stock * 0.2)),
          maximumStock: Math.ceil(p.stock * 1.5),
          reservedStock: 0,
          isDemo: true,
        },
      })

      seeded.push({ id: product.id, name: product.name, price: p.price, type: ProductType.REGULAR })
    }
    logger.info(`   ✅ ${bp.regulars.length} REGULAR products + inventory`)
  }

  // --- Category for services ---
  if (bp.services.length > 0) {
    const svcCat = await prisma.menuCategory.create({
      data: { venueId, name: 'Servicios', slug: `${bp.key}-servicios`, active: true, displayOrder: 2, isDemo: true },
    })

    for (const s of bp.services) {
      const product = await createProduct(
        venueId,
        {
          name: s.name,
          description: s.description,
          price: s.price,
          type: ProductType.APPOINTMENTS_SERVICE,
          sku: s.sku,
          categoryId: svcCat.id,
          durationMinutes: s.durationMinutes,
          duration: s.durationMinutes,
        },
        { type: 'SERVICE', servicePrincipalId: 'DEMO_VENUE_SEED' },
      )
      seeded.push({ id: product.id, name: product.name, price: s.price, type: ProductType.APPOINTMENTS_SERVICE })
    }
    logger.info(`   ✅ ${bp.services.length} APPOINTMENTS_SERVICE products`)
  }

  return seeded
}

// ════════════════════════════════════════════════════════════════════════════
// Consumables (RawMaterial + StockBatch with lote + caducidad)
// ════════════════════════════════════════════════════════════════════════════

async function seedConsumables(bp: VenueBlueprint, venueId: string): Promise<void> {
  if (bp.consumables.length === 0) return

  for (const c of bp.consumables) {
    const rm = await prisma.rawMaterial.create({
      data: {
        venueId,
        name: c.name,
        sku: c.sku,
        category: RawMaterialCategory.OTHER,
        currentStock: c.currentStock,
        unit: c.unit,
        unitType: c.unitType,
        minimumStock: 2,
        reorderPoint: 3,
        costPerUnit: c.costPerUnit,
        avgCostPerUnit: c.costPerUnit,
        isDemo: true,
      },
    })

    const batch = await prisma.stockBatch.create({
      data: {
        venueId,
        rawMaterialId: rm.id,
        batchNumber: c.lote,
        initialQuantity: c.currentStock,
        remainingQuantity: c.currentStock,
        unit: c.unit,
        costPerUnit: c.costPerUnit,
        receivedDate: new Date(),
        expirationDate: addDays(new Date(), c.expiresInDays),
        status: BatchStatus.ACTIVE,
      },
    })

    await prisma.rawMaterialMovement.create({
      data: {
        venueId,
        rawMaterialId: rm.id,
        batchId: batch.id,
        type: 'ADJUSTMENT',
        quantity: c.currentStock,
        unit: c.unit,
        previousStock: 0,
        newStock: c.currentStock,
        costImpact: c.costPerUnit * c.currentStock,
        reason: 'Stock inicial — Demo venue',
        reference: `DEMO-${bp.key}`,
      },
    })
  }
  logger.info(`   ✅ ${bp.consumables.length} consumibles (RawMaterial + lote + caducidad)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Staff (vendedor/especialista) — beyond the org owner
// ════════════════════════════════════════════════════════════════════════════

async function ensureVenueStaff(bp: VenueBlueprint, venueId: string): Promise<string> {
  const email = `${bp.staffName.first}.${bp.staffName.last}.${bp.key}@${DOMINIO_DEMO}`.toLowerCase().replace(/\s+/g, '')

  const staff = await prisma.staff.upsert({
    where: { email },
    update: {},
    create: {
      email,
      firstName: bp.staffName.first,
      lastName: bp.staffName.last,
      active: true,
      emailVerified: true,
    },
  })

  // Attach to venue (StaffVenue). CASHIER = "Payment access only" — the right
  // operational role for a salesperson/specialist who takes payments in the demo.
  await prisma.staffVenue.upsert({
    where: { staffId_venueId: { staffId: staff.id, venueId } },
    update: { active: true },
    create: { staffId: staff.id, venueId, role: 'CASHIER', active: true },
  })

  logger.info(`   ✅ Staff ${bp.staffName.first} ${bp.staffName.last} (${bp.staffRole}) → ${staff.id}`)
  return staff.id
}

// ════════════════════════════════════════════════════════════════════════════
// Commission config (+ tiers for the retail 4%/5% case)
// ════════════════════════════════════════════════════════════════════════════

async function seedCommission(bp: VenueBlueprint, venueId: string, ownerStaffId: string): Promise<void> {
  if (bp.tier) {
    // TIERED: base rate up to threshold, higher rate above it.
    await createCommissionConfig(
      venueId,
      {
        name: `Comisión ${bp.staffRole} (escalonada)`,
        description: `${bp.commissionRate * 100}% base, ${bp.tier.rate * 100}% al pasar $${bp.tier.threshold.toLocaleString('es-MX')}/mes`,
        recipient: CommissionRecipient.SERVER,
        trigger: CommissionTrigger.PER_PAYMENT,
        calcType: CommissionCalcType.TIERED,
        defaultRate: bp.commissionRate,
        priority: 10,
        // Un esquema por niveles nace con sus niveles (nivelesDelEsquema.ts, S-NIVELES-ATÓMICO).
        tiers: [
          { tierLevel: 1, name: 'Base', minThreshold: 0, maxThreshold: bp.tier.threshold, rate: bp.commissionRate },
          { tierLevel: 2, name: 'Meta superada', minThreshold: bp.tier.threshold, maxThreshold: null, rate: bp.tier.rate },
        ],
      },
      ownerStaffId,
    )
    logger.info(`   ✅ Comisión TIERED ${bp.commissionRate * 100}%/${bp.tier.rate * 100}% (umbral $${bp.tier.threshold})`)
  } else {
    // Flat percentage per service/payment.
    await createCommissionConfig(
      venueId,
      {
        name: `Comisión ${bp.staffRole}`,
        description: `${bp.commissionRate * 100}% por servicio`,
        recipient: CommissionRecipient.SERVER,
        trigger: CommissionTrigger.PER_PAYMENT,
        calcType: CommissionCalcType.PERCENTAGE,
        defaultRate: bp.commissionRate,
        priority: 10,
      },
      ownerStaffId,
    )
    logger.info(`   ✅ Comisión PERCENTAGE ${bp.commissionRate * 100}%`)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Loyalty config
// ════════════════════════════════════════════════════════════════════════════

async function seedLoyalty(bp: VenueBlueprint, venueId: string): Promise<void> {
  await prisma.loyaltyConfig.create({
    data: {
      venueId,
      pointsPerDollar: bp.loyalty.pointsPerDollar,
      pointsPerVisit: bp.loyalty.pointsPerVisit,
      redemptionRate: 0.01, // 100 pts = $1
      minPointsRedeem: bp.loyalty.minPointsRedeem,
      pointsExpireDays: 365,
      active: true,
      isDemo: true,
    },
  })
  logger.info(`   ✅ Lealtad: ${bp.loyalty.pointsPerDollar} pto/$, recompensa a ${bp.loyalty.minPointsRedeem} pts`)
}

// ════════════════════════════════════════════════════════════════════════════
// Ecommerce merchant (Blumon, chargeable) — required by createPaymentLink
// ════════════════════════════════════════════════════════════════════════════

async function ensureChargeableMerchant(bp: VenueBlueprint, venueId: string): Promise<string> {
  // Reuse the Blumon PaymentProvider the café seeder created (find-or-create).
  let blumon = await prisma.paymentProvider.findFirst({ where: { code: 'BLUMON' } })
  if (!blumon) {
    blumon = await prisma.paymentProvider.create({
      data: {
        code: 'BLUMON',
        name: 'Blumon PAX Payment Solutions',
        type: 'PAYMENT_PROCESSOR',
        countryCode: ['MX'],
        active: true,
      },
    })
  }

  const shortId = venueId.substring(0, 8)
  // isEcommerceMerchantChargeable() treats Blumon as chargeable iff
  // providerCredentials.accessToken is a non-empty string.
  const merchant = await prisma.ecommerceMerchant.create({
    data: {
      venueId,
      channelName: 'Web Principal',
      businessName: bp.legalName,
      contactEmail: `pay.${bp.key}.${shortId}@${DOMINIO_DEMO}`,
      publicKey: `pk_demo_${bp.key}_${shortId}`,
      secretKeyHash: `demo_secret_hash_${bp.key}_${shortId}`,
      providerId: blumon.id,
      providerCredentials: {
        accessToken: `demo_blumon_token_${shortId}`,
        blumonMerchantId: `blumon_demo_${shortId}`,
        blumonPosId: '999',
        environment: 'SANDBOX',
      },
      providerMerchantId: `blumon_demo_${bp.key}_${shortId}`,
      active: true,
      sandboxMode: true,
      chargesEnabled: true,
    },
  })
  logger.info('   ✅ EcommerceMerchant (Blumon SANDBOX, chargeable) ready')
  return merchant.id
}

// ════════════════════════════════════════════════════════════════════════════
// Payment link (branded, attributed to the venue's salesperson/specialist)
// ════════════════════════════════════════════════════════════════════════════

async function seedPaymentLink(
  bp: VenueBlueprint,
  venueId: string,
  staffId: string,
  attributedStaffId: string,
  products: SeededProduct[],
): Promise<void> {
  // Build an ITEM link off the first 1-2 real products so the demo shows a real
  // basket + inventory deduction. Fall back to an OPEN PAYMENT link if no
  // suitable product exists.
  const linkableRegular = products.find(p => p.type === ProductType.REGULAR)

  if (linkableRegular) {
    await createPaymentLink(
      venueId,
      {
        title: bp.paymentLinkTitle,
        description: 'Pago demo — dispara recibo, factura, comisión, puntos, póliza y reporte.',
        purpose: 'ITEM',
        amountType: 'FIXED',
        isReusable: true,
        items: [{ productId: linkableRegular.id, quantity: 1 }],
        attributedStaffIds: [attributedStaffId],
      },
      staffId,
    )
    logger.info(`   ✅ Payment link (ITEM: ${linkableRegular.name}) attributed to staff`)
  } else {
    await createPaymentLink(
      venueId,
      {
        title: bp.paymentLinkTitle,
        description: 'Pago demo de servicio.',
        purpose: 'PAYMENT',
        amountType: 'OPEN',
        isReusable: true,
        attributedStaffIds: [attributedStaffId],
      },
      staffId,
    )
    logger.info('   ✅ Payment link (OPEN PAYMENT) attributed to staff')
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Future reservation (SALON + CLINIC) — deposit-required + assigned staff
// ════════════════════════════════════════════════════════════════════════════

async function seedReservation(
  bp: VenueBlueprint,
  venueId: string,
  staffId: string,
  customerId: string,
  products: SeededProduct[],
): Promise<void> {
  if (!bp.seedReservation) return

  const service = products.find(p => p.type === ProductType.APPOINTMENTS_SERVICE)
  if (!service) {
    logger.warn('   ⚠️ No service product to attach reservation to — skipping reservation')
    return
  }

  const startsAt = addDays(new Date(), 2)
  startsAt.setHours(11, 0, 0, 0)
  const durationMin = bp.services.find(s => s.name === service.name)?.durationMinutes ?? 60
  const endsAt = new Date(startsAt.getTime() + durationMin * 60_000)

  const code = `RES-${bp.key.substring(0, 3).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`

  await prisma.reservation.create({
    data: {
      venueId,
      confirmationCode: code,
      status: ReservationStatus.CONFIRMED,
      startsAt,
      endsAt,
      // El bloque de agenda coincide con el fin del servicio: estos datos no usan buffer.
      blockedEndsAt: endsAt,
      duration: durationMin,
      customerId,
      partySize: 1,
      productId: service.id,
      assignedStaffId: staffId,
      createdById: staffId,
      // No-show deposit: requested but unpaid (demo shows "depósito no-show").
      depositAmount: new Prisma.Decimal(100),
      depositStatus: DepositStatus.PENDING,
      specialRequests: 'Recordatorio por WhatsApp 24h antes. Política de depósito por no-show.',
      confirmedAt: new Date(),
    },
  })
  logger.info(`   ✅ Reservación futura (${service.name}, depósito $100 no-show, recordatorio WA)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Customers (realistic) for loyalty + order history
// ════════════════════════════════════════════════════════════════════════════

const CUSTOMER_POOL: Record<string, Array<{ first: string; last: string; phone: string; points: number }>> = {
  lunaria: [
    { first: 'Valeria', last: 'Mendoza', phone: '5551110001', points: 320 },
    { first: 'Regina', last: 'Castillo', phone: '5551110002', points: 180 },
    { first: 'Daniela', last: 'Ortega', phone: '5551110003', points: 95 },
    { first: 'Sofía', last: 'Beltrán', phone: '5551110004', points: 540 },
    { first: 'Camila', last: 'Navarro', phone: '5551110005', points: 60 },
  ],
  restaurante: [
    { first: 'Rodrigo', last: 'Aguilar', phone: '5550030001', points: 260 },
    { first: 'Fernanda', last: 'Ibarra', phone: '5550030002', points: 140 },
    { first: 'Javier', last: 'Montes', phone: '5550030003', points: 90 },
    { first: 'Lucía', last: 'Cervantes', phone: '5550030004', points: 410 },
  ],
  cafeteria: [
    { first: 'Emilio', last: 'Paredes', phone: '5550040001', points: 70 },
    { first: 'Renata', last: 'Gallardo', phone: '5550040002', points: 30 },
    { first: 'Santiago', last: 'Quiroz', phone: '5550040003', points: 90 },
    { first: 'Valentina', last: 'Rosas', phone: '5550040004', points: 50 },
  ],
  gimnasio: [
    { first: 'Héctor', last: 'Garza', phone: '5550050001', points: 300 },
    { first: 'Mónica', last: 'Treviño', phone: '5550050002', points: 220 },
    { first: 'Pablo', last: 'Cantú', phone: '5550050003', points: 150 },
    { first: 'Alejandra', last: 'Leal', phone: '5550050004', points: 80 },
  ],
  bloom: [
    { first: 'Andrea', last: 'Fuentes', phone: '5552220001', points: 210 },
    { first: 'Paulina', last: 'Reyes', phone: '5552220002', points: 130 },
    { first: 'Ximena', last: 'Lozano', phone: '5552220003', points: 75 },
    { first: 'Mariana', last: 'Solís', phone: '5552220004', points: 400 },
  ],
  dermedica: [
    { first: 'Isabel', last: 'Carranza', phone: '5553330001', points: 260 },
    { first: 'Renata', last: 'Aguilar', phone: '5553330002', points: 150 },
    { first: 'Lucía', last: 'Domínguez', phone: '5553330003', points: 90 },
    { first: 'Fernanda', last: 'Salas', phone: '5553330004', points: 480 },
  ],
}

async function seedCustomers(bp: VenueBlueprint, venueId: string): Promise<Array<{ id: string; name: string; phone: string }>> {
  const pool = CUSTOMER_POOL[bp.key] ?? []
  const created: Array<{ id: string; name: string; phone: string }> = []
  const now = new Date()

  for (const c of pool) {
    const cust = await prisma.customer.create({
      data: {
        venueId,
        firstName: c.first,
        lastName: c.last,
        phone: c.phone,
        loyaltyPoints: c.points,
        totalVisits: Math.max(1, Math.round(c.points / 50)),
        firstVisitAt: subDays(now, 60),
        lastVisitAt: subDays(now, Math.floor(Math.random() * 7)),
        marketingConsent: true,
        active: true,
      },
    })
    created.push({ id: cust.id, name: `${c.first} ${c.last}`, phone: c.phone })
  }
  logger.info(`   ✅ ${created.length} clientes con puntos de lealtad`)
  return created
}

// ════════════════════════════════════════════════════════════════════════════
// Historial: un mes de ventas pagadas (días anteriores, en horas de negocio; hoy queda para el prospecto)
// ════════════════════════════════════════════════════════════════════════════

async function seedHistory(
  bp: VenueBlueprint,
  venueId: string,
  products: SeededProduct[],
  customers: Array<{ id: string; name: string; phone: string }>,
  staffId: string,
  ecommerceMerchantId: string,
): Promise<void> {
  if (products.length === 0) {
    logger.warn('   ⚠️ No products — skipping history')
    return
  }
  const now = new Date()
  let cardOrdersLinked = 0

  for (let i = 0; i < bp.historyOrders; i++) {
    // Del día 1 al 30 hacia atrás, entre 9:00 y 20:59 de Ciudad de México. Hoy se deja vacío: lo que el prospecto
    // cobre aparece solo como «hoy» en el panel.
    const dia = formatInTimeZone(subDays(now, 1 + Math.floor(Math.random() * 30)), DEMO_TZ, 'yyyy-MM-dd')
    const hora = String(9 + Math.floor(Math.random() * 12)).padStart(2, '0')
    const minuto = String(Math.floor(Math.random() * 60)).padStart(2, '0')
    const orderDate = fromZonedTime(`${dia}T${hora}:${minuto}:00.000`, DEMO_TZ)

    // 1-3 line items from the real catalog.
    const numItems = Math.floor(Math.random() * 3) + 1
    const lineItems: Array<{ product: SeededProduct; quantity: number }> = []
    let subtotal = 0
    for (let j = 0; j < numItems; j++) {
      const product = products[Math.floor(Math.random() * products.length)]
      const quantity = Math.floor(Math.random() * 2) + 1
      lineItems.push({ product, quantity })
      subtotal += product.price * quantity
    }
    // En México el precio del catálogo ya trae el IVA: el total es la suma, sin nada encima.
    const taxAmount = 0
    const total = +subtotal.toFixed(2)

    const hasCustomer = Math.random() < 0.7 && customers.length > 0
    const customer = hasCustomer ? customers[Math.floor(Math.random() * customers.length)] : null

    // 🔴 NO se estampa `shiftId`, y es DELIBERADO: ventas de demo con fecha inventada; atarlas a un turno metería ventas
    // ficticias en su corte.
    const order = await prisma.order.create({
      data: {
        venueId,
        customerId: customer?.id,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
        orderNumber: `${bp.key.toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
        type: OrderType.MANUAL_ENTRY,
        status: OrderStatus.COMPLETED,
        paymentStatus: PaymentStatus.PAID,
        subtotal,
        taxAmount,
        total,
        contratoDePrecio: 'IVA_INCLUIDO',
        createdById: staffId,
        servedById: staffId,
        createdAt: orderDate,
        completedAt: orderDate,
      },
    })

    for (const { product, quantity } of lineItems) {
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: product.id,
          quantity,
          unitPrice: product.price,
          taxAmount: 0,
          total: +(product.price * quantity).toFixed(2),
        },
      })
    }

    if (customer) {
      await prisma.orderCustomer.create({
        data: { orderId: order.id, customerId: customer.id, isPrimary: true, addedAt: orderDate },
      })
    }

    // Payment method mix: 55% card, 15% debit, 30% cash.
    const r = Math.random()
    const method = r < 0.55 ? PaymentMethod.CREDIT_CARD : r < 0.7 ? PaymentMethod.DEBIT_CARD : PaymentMethod.CASH
    const tipAmount = Math.random() < 0.25 ? Math.round(total * 0.1) : 0

    // Card/debit payments route through the EcommerceMerchant channel (so the
    // order is CFDI-invoiceable: loadOrderForCfdi resolves the emisor via the
    // payment's merchant → MerchantFiscalConfig). Cash stays merchant-less.
    const isCard = method !== PaymentMethod.CASH
    if (isCard) cardOrdersLinked++

    await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: total,
        tipAmount,
        method,
        ecommerceMerchantId: isCard ? ecommerceMerchantId : undefined,
        status: 'COMPLETED',
        feePercentage: 0.025,
        feeAmount: +((total + tipAmount) * 0.025).toFixed(2),
        netAmount: +((total + tipAmount) * 0.975).toFixed(2),
        processedById: staffId,
        createdAt: orderDate,
      },
    })
  }
  logger.info(`   ✅ ${bp.historyOrders} órdenes pagadas (últimos 30 días) — ${cardOrdersLinked} con merchant (CFDI-facturables)`)
}

// ════════════════════════════════════════════════════════════════════════════
// Chart of accounts + account mappings (póliza explosion)
//   - Scoped on (organizationId, rfc). The 3 demo venues share ONE org but each
//     has its OWN rfc, so the org holds 3 distinct 88-account charts (one per
//     rfc) — correct, NOT duplication. We seed/guard per (org, rfc).
//   - needs venue.rfc (set in recrearNegocio).
//   - mappings (movementType → ledger account) are REQUIRED by the auto-posting
//     engine; without them generatePoliciesForVenue posts nothing.
//   - seedBaseChart + seedDefaultMappings are both insert-if-absent (idempotent
//     per (org, rfc)) — re-running does NOT re-triplicate. We add an explicit
//     guard so a fully-seeded scope skips the redundant transaction.
// ════════════════════════════════════════════════════════════════════════════

const BASE_CHART_SIZE = 88 // accounts per (org, rfc) once seeded

async function seedChartAndMappings(venueId: string, organizationId: string, rfc: string, ownerStaffId: string): Promise<void> {
  try {
    const existingAccounts = await prisma.ledgerAccount.count({ where: { organizationId, rfc } })

    if (existingAccounts >= BASE_CHART_SIZE) {
      logger.info(`   ✅ Catálogo contable ya sembrado (${existingAccounts} cuentas para rfc ${rfc}) — guard, no re-seed`)
    } else {
      const chart = await seedBaseChart(venueId, { staffId: ownerStaffId })
      logger.info(`   ✅ Catálogo contable (${chart.accounts.length} cuentas, sector auto por giro)`)
    }

    // Idempotent: insert-if-absent, never overwrites a user-changed mapping.
    await seedDefaultMappings(venueId, { staffId: ownerStaffId })

    // Verify the engine will find every required mapping (no missing → pólizas can post).
    const map = await getMappings(venueId)
    const mappedCount = map.mappings.filter(m => m.account).length
    const unmapped = map.mappings.filter(m => !m.account).map(m => m.movementType)
    logger.info(
      `   ✅ Mapeos contables: ${mappedCount}/${map.mappings.length} asignados` +
        (unmapped.length > 0 ? ` (sin cuenta: ${unmapped.join(', ')})` : ''),
    )
  } catch (err) {
    logger.error(`   ❌ Chart/mappings failed: ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Auto-post pólizas for the seeded history (so Contabilidad isn't empty)
// ════════════════════════════════════════════════════════════════════════════

async function seedPolicies(venueId: string, ownerStaffId: string): Promise<number> {
  // No period → posts ALL eligible COMPLETED payments (covers the full 14-day
  // window regardless of month boundaries). Idempotent via per-payment keys.
  const result = await generatePoliciesForVenue(venueId, { actorStaffId: ownerStaffId })

  if (result.needsFiscalSetup) {
    logger.warn('   ⚠️ Pólizas: needsFiscalSetup=true (venue sin RFC) — no se generaron')
    return 0
  }
  if (result.missingMappings.length > 0) {
    logger.warn(`   ⚠️ Pólizas: faltan mapeos requeridos (${result.missingMappings.join(', ')}) — no se generaron`)
    return 0
  }
  logger.info(
    `   ✅ Pólizas generadas: ${result.posted} nuevas, ${result.alreadyPosted} ya existían ` +
      `(candidatos: ${result.candidates}, omitidos: ${result.skipped})`,
  )
  return result.posted + result.alreadyPosted
}

// ════════════════════════════════════════════════════════════════════════════
// CFDI emisor + MerchantFiscalConfig (OPTIONAL — only if Facturapi test key set)
//   - FiscalEmisor: the venue's SAT identity + Facturapi key (encrypted).
//   - MerchantFiscalConfig: gates issuance. issueCfdiForOrder loads
//     facturacionEnabled from the order payment's merchant → MerchantFiscalConfig
//     → fiscalEmisor. Without this row + facturacionEnabled=true, stamping throws
//     "Facturación no habilitada para este comercio". We link it to the venue's
//     EcommerceMerchant (the branded payment-link channel).
// ════════════════════════════════════════════════════════════════════════════

async function seedFiscalEmisor(bp: VenueBlueprint, venueId: string, ecommerceMerchantId: string): Promise<boolean> {
  const facturapiKey = process.env.FACTURAPI_TEST_KEY
  if (!facturapiKey) {
    logger.info('   ℹ️ FACTURAPI_TEST_KEY not set → skipping FiscalEmisor (CFDI stamping disabled; other 5 explosions unaffected)')
    return false
  }
  // La promesa: el demo no factura al SAT. Una llave viva aquí timbraría de verdad; sólo una de prueba de Facturapi.
  if (!facturapiKey.startsWith('sk_test_')) {
    logger.warn('   ⚠️ FACTURAPI_TEST_KEY no es una llave de prueba (sk_test_) → sin FiscalEmisor en el demo')
    return false
  }

  let providerKeyEnc: string
  try {
    providerKeyEnc = encryptProviderKey(facturapiKey)
  } catch (err) {
    logger.warn(
      `   ⚠️ Could not encrypt Facturapi key (is FISCAL_PROVIDER_KEY set?): ${err instanceof Error ? err.message : String(err)} → skipping FiscalEmisor`,
    )
    return false
  }

  // FiscalEmisor is PRESERVED across runs (stamped CFDIs Restrict it), so UPSERT
  // by (venueId, rfc) — never wiped/recreated. csdStatus=ACTIVE: validateBeforeStamp
  // HARD-BLOCKS unless the emisor's CSD is ACTIVE (cfdiValidation.ts:24). In
  // Facturapi TEST mode the PAC supplies a built-in test CSD, so ACTIVE is correct
  // for sandbox stamping.
  const emisor = await prisma.fiscalEmisor.upsert({
    where: { venueId_rfc: { venueId, rfc: bp.rfc } },
    update: {
      legalName: bp.legalName,
      regimenFiscal: '601',
      lugarExpedicion: bp.zipCode,
      serie: 'F',
      provider: 'FACTURAPI',
      providerKeyEnc,
      csdStatus: 'ACTIVE',
      defaultUsoCfdi: 'G03',
    },
    create: {
      venueId,
      rfc: bp.rfc,
      legalName: bp.legalName,
      regimenFiscal: '601', // General de Ley Personas Morales
      lugarExpedicion: bp.zipCode, // fiscal CP — must be a valid SAT c_CodigoPostal
      serie: 'F',
      provider: 'FACTURAPI',
      providerKeyEnc,
      csdStatus: 'ACTIVE',
      defaultUsoCfdi: 'G03',
    },
  })

  // Fiscally enable the EcommerceMerchant (the payment-link channel) so the
  // order's payment resolves facturacionEnabled=true. Cascades with the merchant
  // (the venue is brand new every night), so create fresh. Unique on ecommerceMerchantId.
  await prisma.merchantFiscalConfig.create({
    data: {
      ecommerceMerchantId,
      fiscalEmisorId: emisor.id,
      facturacionEnabled: true,
      autofacturaEnabled: true,
      includeInGlobal: true,
    },
  })

  logger.info('   ✅ FiscalEmisor + MerchantFiscalConfig (facturacionEnabled=true) — CFDI puede timbrar en sandbox')
  return true
}

// ════════════════════════════════════════════════════════════════════════════
// Per-venue orchestration
// ════════════════════════════════════════════════════════════════════════════

interface VenueReport {
  name: string
  venueId: string
  orgName: string
  organizationId: string
  products: number
  services: number
  inventory: number
  consumables: number
  commission: string
  loyalty: boolean
  reservation: boolean
  paymentLink: boolean
  historyOrders: number
  ledgerAccounts: number
  accountMappings: number
  journalEntries: number
  cfdiEmisor: boolean
}

async function seedVenue(bp: VenueBlueprint, organizationId: string, ownerStaffId: string, password: string): Promise<VenueReport> {
  logger.info('')
  logger.info(`════════════ ${bp.name} (${bp.type}) ════════════`)

  // El usuario del giro primero; después el cambio del negocio viejo por uno nuevo, de una sola vez y ya en LIVE_DEMO.
  const usuarioDemoId = await asegurarUsuarioDemo(bp, organizationId, password)
  const venueId = await recrearNegocio(bp, organizationId, usuarioDemoId)
  // Todo lo que se siembra corre con el negocio demo en el contexto: si algo intentara mandar un aviso, el candado lo frena.
  // Quien «hace» la semilla es el dueño del negocio (el usuario del giro): es el único con acceso a él.
  return conNegocio(venueId, () => sembrarContenido(bp, venueId, organizationId, usuarioDemoId))
}

async function sembrarContenido(bp: VenueBlueprint, venueId: string, organizationId: string, ownerStaffId: string): Promise<VenueReport> {
  await sembrarMesas(bp, venueId)

  // Funciones: LIVE_DEMO ya ve todas sin plan (basePlan.service, DEMO_VENUE_STATUSES). Sólo el módulo de comisiones.
  await enableCommissionsModule(venueId, ownerStaffId)

  // Staff (salesperson/specialist) for attribution + commission
  const venueStaffId = await ensureVenueStaff(bp, venueId)

  // Catalog
  const products = await seedCatalog(bp, venueId)
  await seedConsumables(bp, venueId)

  // Commission + loyalty
  await seedCommission(bp, venueId, ownerStaffId)
  await seedLoyalty(bp, venueId)

  // Chart of accounts + mappings (póliza prerequisites). Scoped (org, rfc);
  // bp.rfc was pinned onto the venue in recrearNegocio.
  await seedChartAndMappings(venueId, organizationId, bp.rfc, ownerStaffId)

  // Cobro channel: chargeable EcommerceMerchant. Created BEFORE history so card
  // payments can route through it (→ CFDI-invoiceable) and the payment link can
  // bind to it.
  const ecommerceMerchantId = await ensureChargeableMerchant(bp, venueId)

  // Customers + history (card payments linked to the merchant)
  const customers = await seedCustomers(bp, venueId)
  await seedHistory(bp, venueId, products, customers, venueStaffId, ecommerceMerchantId)

  // Pólizas: auto-post the history so Contabilidad is populated (not empty).
  await seedPolicies(venueId, ownerStaffId)

  // Branded payment link
  await seedPaymentLink(bp, venueId, ownerStaffId, venueStaffId, products)

  // Reservation (SALON + CLINIC)
  await seedReservation(bp, venueId, venueStaffId, customers[0]?.id ?? '', products)

  // CFDI (optional): emisor + MerchantFiscalConfig linking the merchant fiscally.
  const cfdiEmisor = await seedFiscalEmisor(bp, venueId, ecommerceMerchantId)

  // Final fiscal counts (shared org, this venue's rfc) for the report.
  const [ledgerAccounts, accountMappings, journalEntries] = await Promise.all([
    prisma.ledgerAccount.count({ where: { organizationId, rfc: bp.rfc } }),
    prisma.accountMapping.count({ where: { organizationId, rfc: bp.rfc, ledgerAccountId: { not: null } } }),
    prisma.journalEntry.count({ where: { organizationId, rfc: bp.rfc } }),
  ])

  return {
    name: bp.name,
    venueId,
    orgName: `Avoqado Demo · ${bp.name}`,
    organizationId,
    products: bp.regulars.length,
    services: bp.services.length,
    inventory: bp.regulars.length,
    consumables: bp.consumables.length,
    commission: bp.tier ? `TIERED ${bp.commissionRate * 100}%/${bp.tier.rate * 100}%` : `${bp.commissionRate * 100}%`,
    loyalty: true,
    reservation: bp.seedReservation,
    paymentLink: true,
    historyOrders: bp.historyOrders,
    ledgerAccounts,
    accountMappings,
    journalEntries,
    cfdiEmisor,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Entradas: el script (primera creación, a mano) y el job (reinicio nocturno)
// ════════════════════════════════════════════════════════════════════════════

function passwordDemo(): string {
  const password = process.env.NEGOCIOS_DEMO_PASSWORD
  if (!password || password.length < 8)
    throw new Error('Falta NEGOCIOS_DEMO_PASSWORD (8+ caracteres): es la contraseña de los usuarios demo')
  return password
}

/**
 * Crea (o recrea) los negocios demo. Un negocio que falla no detiene a los demás; se devuelve qué pasó con cada uno.
 * `soloClave` siembra uno (`--venue restaurante`).
 */
export async function sembrarNegociosDemo(opts: { soloClave?: string } = {}): Promise<{ ok: VenueReport[]; fallas: string[] }> {
  const password = passwordDemo()
  const blueprints = opts.soloClave ? BLUEPRINTS.filter(b => b.key === opts.soloClave) : BLUEPRINTS
  if (blueprints.length === 0) throw new Error(`No hay giro «${opts.soloClave}». Válidos: ${BLUEPRINTS.map(b => b.key).join(', ')}`)
  const ok: VenueReport[] = []
  const fallas: string[] = []
  for (const bp of blueprints) {
    try {
      const { organizationId, ownerStaffId } = await ensureDemoOrgAndOwner(bp)
      // Precondición ANTES de borrar nada: en la organización del giro sólo hay su negocio demo. Si aparece otro (alguien
      // lo movió ahí, o una entrada de alta que el candado no conocía), ese giro no se toca y se avisa.
      const ajenos = await prisma.venue.findMany({
        where: { organizationId, status: { not: VenueStatus.LIVE_DEMO } },
        select: { name: true, status: true },
        take: 5,
      })
      if (ajenos.length) {
        throw new Error(
          `🚨 La organización demo de «${bp.name}» tiene negocios que no son LIVE_DEMO (${ajenos.map(v => `${v.name}: ${v.status}`).join(', ')})`,
        )
      }
      ok.push(await seedVenue(bp, organizationId, ownerStaffId, password))
    } catch (error) {
      logger.error(`❌ Negocio demo «${bp.name}» no se pudo sembrar`, { error })
      fallas.push(bp.name)
    }
  }
  return { ok, fallas }
}

/**
 * El job de cada noche: sólo los giros cuya organización demo ya existe (la primera creación es a mano, con el founder).
 * Un giro que nunca se creó no nace solo.
 */
export async function reiniciarNegociosDemo(): Promise<{ ok: number; fallas: string[] } | null> {
  const orgs = await prisma.organization.findMany({
    where: { slug: { in: BLUEPRINTS.map(b => slugDeOrgDemo(b.key)) } },
    select: { slug: true },
    take: BLUEPRINTS.length,
  })
  if (orgs.length === 0) return null
  const ok: number[] = []
  const fallas: string[] = []
  for (const bp of BLUEPRINTS.filter(b => orgs.some(o => o.slug === slugDeOrgDemo(b.key)))) {
    const r = await sembrarNegociosDemo({ soloClave: bp.key })
    ok.push(r.ok.length)
    fallas.push(...r.fallas)
  }
  return { ok: ok.reduce((a, b) => a + b, 0), fallas }
}

export const GIROS_DEMO = BLUEPRINTS.map(b => ({ clave: b.key, nombre: b.name, usuario: correoDelDemo(b.key) }))
