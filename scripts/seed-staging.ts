/**
 * Staging Database Seed
 * =====================
 *
 * Populates a FRESH, EMPTY staging database with realistic, multi-sector test
 * data so a new developer can log into `avoqado-web-dashboard` and exercise
 * reports, charts, catalog, orders/payments, inventory and shifts.
 *
 * WHY THIS IS A THIN WRAPPER (and not a new 206-model seed):
 * ----------------------------------------------------------
 * `prisma/seed.ts` (~5,700 lines) ALREADY produces exactly what staging needs:
 *   - 2 Organizations (Grupo Avoqado, PlayTelecom)
 *   - Multi-sector venues across different `VenueType` values:
 *       · "Avoqado Full"    → RESTAURANT  (BusinessCategory FOOD_SERVICE) — full catalog,
 *                              orders, payments, shifts, stock batches, terminals, reservations
 *       · "Avoqado Wellness"→ SPA         (BusinessCategory SERVICES)     — services + classes,
 *                              retail products, bookings, ClassSessions, deposits
 *       · "BAE EL PORTAL"   → OTHER       (telecom)                       — serialized inventory
 *       · "Avoqado Empty"   → RESTAURANT  (intentionally empty venue)
 *     NOTE: `BusinessCategory` (FOOD_SERVICE / RETAIL / SERVICES …) is NOT a DB enum.
 *     It is derived in code from `VenueType` via `getBusinessCategory()`
 *     (`src/utils/businessCategory.ts`). Multi-sector data therefore means a spread
 *     of `VenueType` values, which the existing seed already provides.
 *   - A login-able OWNER plus SUPERADMIN and per-venue staff
 *   - Modules + Features enabled so dashboard sections are visible
 *
 * Re-implementing all of that from scratch would be strictly worse and error-prone
 * (the brief explicitly warns against it). So this script REUSES `prisma/seed.ts`
 * verbatim: it runs it as a child process with a staging-safe configuration, then
 * applies a small staging-specific post-step (Firebase UID linkage, see below).
 *
 * `prisma/seed.ts` is NOT modified by this script.
 *
 * FIREBASE / DASHBOARD LOGIN — IMPORTANT CLARIFICATION:
 * ----------------------------------------------------
 * The `avoqado-web-dashboard` authenticates against `avoqado-server` with
 * EMAIL + PASSWORD → JWT cookie (see `src/services/dashboard/auth.service.ts`,
 * `loginStaff()`), bcrypt-hashed in the `Staff.password` column. Firebase in
 * this repo is used only for Storage and push notifications, NOT dashboard auth.
 * The `Staff` model has no `firebaseUid` column.
 *
 * So the real, working staging login is the email/password below. The
 * `STAGING_OWNER_FIREBASE_UID` env var is still honoured: this script stamps it
 * into the owner's `Staff.employeeCode` field (an unused, free-text slot) as a
 * forward-compatible linkage point — if/when the staging dashboard adds a
 * Firebase auth path, the UID is already associated with the owner row and can
 * be migrated to a dedicated column without re-seeding.
 *
 * ENVIRONMENT VARIABLES:
 * ----------------------
 *   STAGING_DATABASE_URL        (required) Postgres connection string for the
 *                               staging DB. This script REFUSES to run against
 *                               anything that looks like production.
 *   STAGING_OWNER_FIREBASE_UID  (optional) Firebase UID to associate with the
 *                               OWNER staff row. Default: 'staging-owner-uid'.
 *   SEED_DAYS                   (optional) Days of historical transactional data.
 *                               Default: 45 (≈1.5 months — enough for charts).
 *   SEED_SEED                   (optional) Numeric seed for reproducible data.
 *                               Default: 20240101 (deterministic staging data).
 *
 * USAGE:
 * ------
 *   # From the avoqado-server repo root, with the staging DB empty (schema migrated):
 *   STAGING_DATABASE_URL="postgres://…/avoqado_staging" \
 *     npx ts-node -r tsconfig-paths/register scripts/seed-staging.ts
 *
 *   # With an explicit Firebase UID and a longer history window:
 *   STAGING_DATABASE_URL="postgres://…/avoqado_staging" \
 *   STAGING_OWNER_FIREBASE_UID="abc123FirebaseUid" \
 *   SEED_DAYS=60 \
 *     npx ts-node -r tsconfig-paths/register scripts/seed-staging.ts
 *
 * This script does NOT commit anything and is safe to re-run (the underlying
 * seed wipes + re-seeds when SEED_RESET=true, which this wrapper sets).
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

// ==========================================
// CONFIGURATION
// ==========================================

const REPO_ROOT = path.resolve(__dirname, '..')

const STAGING_DATABASE_URL = process.env.STAGING_DATABASE_URL
const STAGING_OWNER_FIREBASE_UID = process.env.STAGING_OWNER_FIREBASE_UID || 'staging-owner-uid'
const SEED_DAYS = process.env.SEED_DAYS || '45'
const SEED_SEED = process.env.SEED_SEED || '20240101'

// The OWNER credentials the underlying `prisma/seed.ts` creates (see seed.ts ~L892).
// This is the actual, working dashboard login.
const OWNER_EMAIL = 'owner@owner.com'
const OWNER_PASSWORD = 'owner'

// ==========================================
// SAFETY GUARDS
// ==========================================

function assertStagingDatabase(url: string | undefined): asserts url is string {
  if (!url) {
    console.error('❌ STAGING_DATABASE_URL is not set.')
    console.error('   Set it to the staging Postgres connection string and re-run:')
    console.error('   STAGING_DATABASE_URL="postgres://…/avoqado_staging" \\')
    console.error('     npx ts-node -r tsconfig-paths/register scripts/seed-staging.ts')
    process.exit(1)
  }

  const lowered = url.toLowerCase()
  const looksLikeProd =
    lowered.includes('prod') ||
    lowered.includes('production') ||
    // Common prod hosts for this project — refuse outright.
    lowered.includes('api.avoqado.io')

  const looksLikeStaging = lowered.includes('staging') || lowered.includes('stage') || lowered.includes('stg')

  if (looksLikeProd && !looksLikeStaging) {
    console.error('❌ STAGING_DATABASE_URL appears to point at PRODUCTION.')
    console.error('   This script wipes and re-seeds the target DB. Aborting for safety.')
    console.error(`   URL host fragment did not contain "staging"/"stage"/"stg".`)
    process.exit(1)
  }

  if (!looksLikeStaging) {
    console.warn('⚠️  STAGING_DATABASE_URL does not contain "staging"/"stage"/"stg".')
    console.warn('   Proceeding anyway — make sure this is NOT a production database.')
  }
}

// ==========================================
// STEP 1 — RUN THE EXISTING SEED (verbatim)
// ==========================================

function runUnderlyingSeed(databaseUrl: string): void {
  console.log('🌱 [seed-staging] Step 1/2 — running prisma/seed.ts against the staging DB…')
  console.log(`   SEED_DAYS=${SEED_DAYS}  SEED_SEED=${SEED_SEED}  SEED_RESET=true`)
  console.log('')

  const result = spawnSync('npx', ['ts-node', '-r', 'tsconfig-paths/register', 'prisma/seed.ts'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Point Prisma at the staging DB for this child process only.
      DATABASE_URL: databaseUrl,
      // Belt-and-suspenders: prisma.config.ts can swap DATABASE_URL when
      // USE_RENDER_DB=true — make sure that override is off for staging.
      USE_RENDER_DB: 'false',
      // Wipe the DB first so a fresh, empty staging DB gets a clean dataset
      // and re-runs stay idempotent.
      SEED_RESET: 'true',
      // Staging-tuned volume: enough history for charts/metrics without bloat.
      SEED_DAYS,
      // Deterministic data so every developer sees the same staging numbers.
      SEED_SEED,
      NODE_ENV: 'development',
    },
  })

  if (result.status !== 0) {
    console.error('')
    console.error(`❌ [seed-staging] prisma/seed.ts exited with code ${result.status}.`)
    process.exit(result.status ?? 1)
  }

  console.log('')
  console.log('✅ [seed-staging] Underlying seed finished.')
}

// ==========================================
// STEP 2 — STAGING-SPECIFIC POST-PROCESSING
// ==========================================
// Stamp the configurable Firebase UID onto the OWNER staff row so it can be
// linked to a staging Firebase user later. Stored in `Staff.employeeCode`
// (a free-text, currently-unused field) — see header comment for rationale.

async function applyStagingOwnerFirebaseLink(databaseUrl: string): Promise<void> {
  console.log('')
  console.log('🔗 [seed-staging] Step 2/2 — linking OWNER staff row to Firebase UID…')

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  })

  try {
    const owner = await prisma.staff.findUnique({ where: { email: OWNER_EMAIL } })

    if (!owner) {
      console.warn(`⚠️  OWNER staff row (${OWNER_EMAIL}) not found — skipping Firebase UID link.`)
      console.warn('   The underlying seed may have changed its owner email; check prisma/seed.ts.')
      return
    }

    await prisma.staff.update({
      where: { id: owner.id },
      data: { employeeCode: STAGING_OWNER_FIREBASE_UID },
    })

    console.log(`✅ [seed-staging] OWNER "${OWNER_EMAIL}" linked to Firebase UID: ${STAGING_OWNER_FIREBASE_UID}`)
    console.log('   (stored in Staff.employeeCode as a forward-compatible linkage slot)')
  } finally {
    await prisma.$disconnect()
  }
}

// ==========================================
// SUMMARY
// ==========================================

function printSummary(): void {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🎉 Staging database seeded successfully.')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('WHAT WAS CREATED:')
  console.log('  • 2 Organizations: "Grupo Avoqado", "PlayTelecom"')
  console.log('  • Multi-sector venues (different VenueType → BusinessCategory):')
  console.log('      - Avoqado Full     RESTAURANT  (FOOD_SERVICE) — full catalog + transactions')
  console.log('      - Avoqado Wellness SPA         (SERVICES)     — services, classes, retail items, bookings')
  console.log('      - BAE EL PORTAL    OTHER       (telecom)      — serialized inventory')
  console.log('      - Avoqado Empty    RESTAURANT                 — intentionally empty venue')
  console.log('  • Staff: SUPERADMIN, OWNER + per-venue ADMIN/MANAGER/CASHIER/WAITER')
  console.log('  • Catalog: menus, categories, products/items, modifiers')
  console.log('  • Transactions: orders, order items, payments, shifts, stock batches')
  console.log('  • Modules + Features enabled so dashboard sections render')
  console.log('  • Reservations, ClassSessions, terminals, reviews, notifications')
  console.log('')
  console.log('DASHBOARD LOGIN (avoqado-web-dashboard — email + password):')
  console.log(`  OWNER:      ${OWNER_EMAIL} / ${OWNER_PASSWORD}`)
  console.log('  SUPERADMIN: superadmin@superadmin.com / superadmin')
  console.log('  (per-venue: admin@admin.com / admin, manager@manager.com / manager, …)')
  console.log('')
  console.log('FIREBASE LINK:')
  console.log(`  OWNER staff row carries Firebase UID "${STAGING_OWNER_FIREBASE_UID}"`)
  console.log('  in Staff.employeeCode. Create the matching user in the staging')
  console.log('  Firebase project, or override with STAGING_OWNER_FIREBASE_UID.')
  console.log('  NOTE: the dashboard logs in via email/password, not Firebase —')
  console.log('  this UID is a forward-compatible association only.')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
}

// ==========================================
// MAIN
// ==========================================

async function main(): Promise<void> {
  console.log('')
  console.log('🚀 Avoqado — Staging Database Seed')
  console.log('   (thin wrapper that reuses prisma/seed.ts; see file header for details)')
  console.log('')

  assertStagingDatabase(STAGING_DATABASE_URL)

  runUnderlyingSeed(STAGING_DATABASE_URL)
  await applyStagingOwnerFirebaseLink(STAGING_DATABASE_URL)
  printSummary()
}

main().catch(err => {
  console.error('')
  console.error('❌ [seed-staging] Failed:', err)
  process.exit(1)
})
