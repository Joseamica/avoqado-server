/**
 * Setup script — create the PlayTelecom Walmart Express venue "WE JURICA (5815)".
 *
 * Re-runnable & idempotent (keyed by slug `we-jurica`): if the venue already
 * exists it reports and exits without touching anything. Mirrors the founder's
 * by-name PlayTelecom setup pattern (never mutates the shared creation path).
 *
 * Replicates a working PT store exactly by COPYING the SERIALIZED_INVENTORY
 * module config + the PT-specific VenueSettings from a reference BAE venue at
 * runtime, so the new venue is guaranteed identical to its siblings.
 *
 * Deferred (assigned later, per every other PT store): the physical PAX Terminal
 * and the promoter StaffVenue roster.
 *
 *   DATABASE_URL="postgres://..." npx tsx scripts/setup-we-jurica.ts
 *   DATABASE_URL="postgres://..." npx tsx scripts/setup-we-jurica.ts --dry-run
 */

import { PrismaClient, Prisma, VenueStatus, VerificationStatus, VenueType } from '@prisma/client'
import cuid from 'cuid'

const prisma = new PrismaClient()

// ─── Constants (verified in prod) ────────────────────────────────────
const ORG_NAME = 'PlayTelecom'
const REFERENCE_SLUG = 'bae-mirador-via-lactea' // copy module config + settings from here
const SHARED_MERCHANT_ID = 'cmlah9251000ik628rhkkwhp0' // blumon_2841653101, PAX A910S PRODUCTION (40/43 PT stores)
const SERIALIZED_MODULE_ID = 'cm6mod001serialized'
const ACTOR_STAFF_ID = 'cmhvejg9y00a72gtx23p4y2ai' // superadmin@superadmin.com

const VENUE = {
  name: 'WE JURICA (5815)',
  slug: 'we-jurica',
  address: 'Av. 5 de Febrero 9222, Jurica',
  city: 'Querétaro',
  state: 'Querétaro',
  zipCode: '76100',
  country: 'MX',
  latitude: new Prisma.Decimal('20.649761'),
  longitude: new Prisma.Decimal('-100.432886'),
}

// Settings fields that PT stores diverge from the schema defaults on.
// (Everything else on VenueSettings keeps its default.)
const PT_SETTINGS = {
  enableShifts: false,
  requirePinLogin: true,
  trackInventory: false,
  allowReservations: false,
  allowTakeout: false,
  allowDelivery: false,
  trackPromoterLocation: true,
  promoterLocationStartHour: 11,
  promoterLocationEndHour: 18,
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  // 1. Resolve the PlayTelecom org (exact name — there's also "Play Telecom Pruebas")
  const org = await prisma.organization.findFirst({ where: { name: ORG_NAME }, select: { id: true, name: true } })
  if (!org) throw new Error(`Organization "${ORG_NAME}" not found`)

  // 2. Idempotency — bail if the venue already exists
  const existing = await prisma.venue.findUnique({ where: { slug: VENUE.slug }, select: { id: true, name: true } })
  if (existing) {
    console.log(`✅ Venue already exists: ${existing.name} (${existing.id}) — nothing to do.`)
    return
  }

  // 3. Pull the reference module config + settings so the new venue is identical
  const ref = await prisma.venue.findUnique({
    where: { slug: REFERENCE_SLUG },
    select: {
      venueModules: { where: { moduleId: SERIALIZED_MODULE_ID }, select: { config: true } },
    },
  })
  const moduleConfig = ref?.venueModules?.[0]?.config ?? Prisma.JsonNull
  if (!ref?.venueModules?.length) {
    throw new Error(`Reference venue "${REFERENCE_SLUG}" has no SERIALIZED_INVENTORY module to copy`)
  }

  // 4. Sanity-check the shared merchant account is present + active
  const merchant = await prisma.merchantAccount.findUnique({
    where: { id: SHARED_MERCHANT_ID },
    select: { id: true, active: true, externalMerchantId: true },
  })
  if (!merchant || !merchant.active) throw new Error(`Shared merchant ${SHARED_MERCHANT_ID} missing or inactive`)

  const venueId = cuid()
  const now = new Date()

  console.log('── Plan ─────────────────────────────────────────────')
  console.log(`  org:      ${org.name} (${org.id})`)
  console.log(`  venue:    ${VENUE.name}  id=${venueId}  slug=${VENUE.slug}`)
  console.log(`  location: ${VENUE.address}, ${VENUE.city}, ${VENUE.state} ${VENUE.zipCode}`)
  console.log(`  geo:      ${VENUE.latitude}, ${VENUE.longitude}`)
  console.log(`  merchant: ${merchant.externalMerchantId} (${merchant.id})`)
  console.log(`  module:   SERIALIZED_INVENTORY (config copied from ${REFERENCE_SLUG})`)
  console.log('─────────────────────────────────────────────────────')

  if (dryRun) {
    console.log('🟡 --dry-run: no changes written.')
    return
  }

  await prisma.$transaction(async tx => {
    // Venue — ACTIVE + KYC pre-approved, exactly like its BAE/SAMS siblings
    await tx.venue.create({
      data: {
        id: venueId,
        organizationId: org.id,
        name: VENUE.name,
        slug: VENUE.slug,
        type: VenueType.OTHER,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        language: 'es',
        country: VENUE.country,
        address: VENUE.address,
        city: VENUE.city,
        state: VENUE.state,
        zipCode: VENUE.zipCode,
        latitude: VENUE.latitude,
        longitude: VENUE.longitude,
        salesEnabled: true,
        active: true,
        status: VenueStatus.ACTIVE,
        statusChangedAt: now,
        statusChangedBy: ACTOR_STAFF_ID,
        kycStatus: VerificationStatus.VERIFIED,
        kycCompletedAt: now,
        kycVerifiedBy: ACTOR_STAFF_ID,
        feeType: 'PERCENTAGE',
        feeValue: new Prisma.Decimal('0.0250'),
      },
    })

    // VenueSettings — PT-specific overrides (promoter tracking on, shifts off)
    await tx.venueSettings.create({ data: { venueId, ...PT_SETTINGS } })

    // Per-venue SERIALIZED_INVENTORY module (SIM/ICCID labels, portabilidad, GPS attendance)
    await tx.venueModule.create({
      data: {
        venueId,
        moduleId: SERIALIZED_MODULE_ID,
        enabled: true,
        config: moduleConfig as Prisma.InputJsonValue,
        enabledBy: ACTOR_STAFF_ID,
      },
    })

    // Payment routing → shared PT Blumon merchant
    await tx.venuePaymentConfig.create({
      data: {
        venueId,
        primaryAccountId: SHARED_MERCHANT_ID,
        preferredProcessor: 'AUTO',
      },
    })

    // Audit trail (dual event, mirrors the onboarding wizard's pre-approve path)
    await tx.activityLog.createMany({
      data: [
        {
          staffId: ACTOR_STAFF_ID,
          venueId,
          action: 'VENUE_CREATED',
          entity: 'Venue',
          entityId: venueId,
          data: { organizationId: org.id, venueSlug: VENUE.slug, via: 'setup-we-jurica', playtelecomStore: true },
        },
        {
          staffId: ACTOR_STAFF_ID,
          venueId,
          action: 'KYC_APPROVED',
          entity: 'Venue',
          entityId: venueId,
          data: { via: 'setup-we-jurica' },
        },
      ],
    })
  })

  console.log(`\n✅ Created ${VENUE.name} (${venueId})`)
  console.log('   Deferred (as with every PT store): physical PAX Terminal + promoter StaffVenue roster.')
}

main()
  .catch(e => {
    console.error('❌ setup-we-jurica failed:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
