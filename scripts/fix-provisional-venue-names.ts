/**
 * fix-provisional-venue-names.ts — re-runnable data fix (NOT a one-off)
 *
 * PROBLEM
 * -------
 * `ensureVenueForOnboarding` creates a "provisional" venue mid-wizard so Steps 8/9 have a
 * real venueId. Until 2026-07-26 it fired on the FIRST `GET /onboarding/:orgId/progress`
 * — which the SetupWizard issues on MOUNT, before Step 2 (business info) exists — because
 * `getV2SetupDataForCompletion` defaulted the name to the placeholder `'Mi Negocio'`,
 * making the `if (!businessName) return null` guard unreachable.
 *
 * The venue was therefore created with:
 *   name  = 'Mi Negocio'   slug = 'mi-negocio-N'
 *   address / city / state / zipCode / phone = ''      type = RESTAURANT (default)
 *
 * ...and completion only flipped `status`, so nothing the operator typed afterwards ever
 * reached the venue. The correct values were sitting untouched in
 * `OnboardingProgress.v2SetupData.step2` / `.step3` the whole time.
 *
 * The code fix is in place (the guard is live again + completion now rehydrates), but
 * venues created during the broken window are still mis-named. This script repairs them
 * from their OWN wizard data — nothing is invented or hardcoded.
 *
 * WHAT IT DOES
 * ------------
 *   For every venue whose name is still the placeholder (or whose slug is `mi-negocio*`),
 *   read its org's `v2SetupData`, and apply the wizard's business info via the SAME
 *   `applyBusinessInfoToVenue` helper the completion path uses — name, slug, address,
 *   city, state, zipCode, country, phone, email, venue type. Venues whose wizard has no
 *   business name yet are SKIPPED (nothing to recover; they'll be named correctly when
 *   the operator finishes Step 2).
 *
 * SAFETY
 * ------
 *   - Dry-run by default. Writes ONLY with `--apply`.
 *   - Idempotent: a venue already carrying its real name produces no write.
 *   - Never blanks a populated field with an empty wizard value.
 *   - Writes an `ActivityLog` row per repaired venue (via the shared helper).
 *   - Changing the slug also changes the dashboard URL and the Firebase Storage path
 *     prefix (`buildStoragePath` uses `venue.slug`). That is intentional here: these
 *     venues are fresh out of onboarding, and `mi-negocio-N` is wrong forever otherwise.
 *     Pass `--keep-slug` if you'd rather only fix the display name.
 *
 * USAGE
 * -----
 *   DATABASE_URL=$RENDER_DATABASE_URL npx tsx scripts/fix-provisional-venue-names.ts            # dry-run
 *   DATABASE_URL=$RENDER_DATABASE_URL npx tsx scripts/fix-provisional-venue-names.ts --apply    # write
 *   ... --apply --actor=<staffId>       # attribute the ActivityLog rows to a real person
 *   ... --apply --keep-slug             # rename only, leave the slug alone
 */

import prisma from '../src/utils/prismaClient'
import { getV2SetupDataForCompletion } from '../src/services/onboarding/onboardingProgress.service'
import { applyBusinessInfoToVenue } from '../src/services/onboarding/venueCreation.service'

const APPLY = process.argv.includes('--apply')
const KEEP_SLUG = process.argv.includes('--keep-slug')
const ACTOR = process.argv.find(a => a.startsWith('--actor='))?.split('=')[1]

const PLACEHOLDER_NAME = 'Mi Negocio'

async function main() {
  console.log(`\n🔎 Buscando venues con el nombre placeholder "${PLACEHOLDER_NAME}"...\n`)

  // ONLY venues still literally carrying the placeholder. A venue whose slug is
  // `mi-negocio*` but whose name is something else was RENAMED BY HAND in the dashboard —
  // that name is the operator's decision and must never be overwritten with wizard data.
  // Those are reported separately at the end.
  const candidates = await prisma.venue.findMany({
    where: { name: PLACEHOLDER_NAME },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      organizationId: true,
      organization: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  // Renamed-by-hand leftovers: right name, placeholder slug. Report only.
  const renamedByHand = await prisma.venue.findMany({
    where: { slug: { startsWith: 'mi-negocio' }, name: { not: PLACEHOLDER_NAME } },
    select: { name: true, slug: true, status: true },
  })

  if (candidates.length === 0) {
    console.log('✅ Ningún venue con el nombre placeholder.\n')
  }

  let repaired = 0
  let skipped = 0

  for (const venue of candidates) {
    let businessInfo
    try {
      const setup = await getV2SetupDataForCompletion(venue.organizationId)
      businessInfo = setup.businessInfo
    } catch (err) {
      console.log(`  ⏭️  ${venue.slug} (org "${venue.organization.name}") — sin datos del wizard V2: ${(err as Error).message}`)
      skipped++
      continue
    }

    const realName = businessInfo.name?.trim()
    if (!realName) {
      console.log(`  ⏭️  ${venue.slug} (org "${venue.organization.name}") — el wizard aún no tiene nombre de negocio, se queda como está`)
      skipped++
      continue
    }

    console.log(`  🛠️  ${venue.slug} [${venue.status}]`)
    console.log(`        nombre : "${venue.name}"  →  "${realName}"`)
    if (businessInfo.city) console.log(`        ciudad : "" → "${businessInfo.city}"`)
    if (businessInfo.address) console.log(`        dirección: "" → "${businessInfo.address}"`)
    if (businessInfo.phone) console.log(`        teléfono : "" → "${businessInfo.phone}"`)
    if (businessInfo.venueType) console.log(`        tipo   : → ${businessInfo.venueType}`)

    if (APPLY) {
      // --keep-slug: feed the helper the CURRENT name so it doesn't re-slug, then set the
      // display name separately.
      if (KEEP_SLUG) {
        await applyBusinessInfoToVenue(venue.id, { ...businessInfo, name: venue.name }, ACTOR)
        await prisma.venue.update({ where: { id: venue.id }, data: { name: realName } })
      } else {
        const updated = await applyBusinessInfoToVenue(venue.id, businessInfo as any, ACTOR)
        if (updated && updated.slug !== venue.slug) console.log(`        slug   : "${venue.slug}" → "${updated.slug}"`)
      }
      repaired++
    }
  }

  if (renamedByHand.length > 0) {
    console.log(`\n  ℹ️  Renombrados a mano por el dueño (NO se tocan, solo el slug quedó feo):`)
    for (const v of renamedByHand) {
      console.log(`        "${v.name}" [${v.status}] — slug "${v.slug}"`)
    }
    console.log(`      Cambiar su slug mueve la URL del dashboard y el prefijo en Firebase Storage;`)
    console.log(`      hazlo a mano solo si el venue todavía no tiene documentos/KYC subidos.`)
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  Candidatos: ${candidates.length} · Reparados: ${APPLY ? repaired : 0} · Omitidos: ${skipped}`)
  if (!APPLY) {
    console.log(`\n  Dry-run: no se escribió nada. Corre otra vez con --apply para aplicarlo.\n`)
  } else {
    console.log('')
  }
}

main()
  .catch(err => {
    console.error('\n❌ Falló el fix:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
