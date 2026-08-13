/**
 * Isolated demo organization for the corporate master catalog (Act 2 of the PITS demo).
 *
 * The H1A rollout runbook requires the first master-catalog grant to happen in an
 * organization created only for that purpose. This script builds exactly that: a
 * fictional highway travel-center chain whose operation mirrors the prospect's
 * (convenience store + restaurant + cafeteria, grouped by geographic region),
 * with the catalog module switched on and nothing else touched.
 *
 * It never reads, writes or reaches into any pre-existing organization. Venue
 * shape is cloned from a live template venue instead of being hand-declared, so
 * a required column added to Venue later cannot silently break this seed.
 *
 *   npx tsx scripts/seed-paradores-demo.ts --dry-run    # validate, write nothing
 *   npx tsx scripts/seed-paradores-demo.ts              # create
 *   npx tsx scripts/seed-paradores-demo.ts --teardown   # remove everything it made
 *
 * Re-running is safe: every write is an upsert keyed on the demo slugs.
 */

import { CatalogReferenceStatus, ModuleScope, OrganizationEntitlementSource, OrganizationEntitlementStatus, Prisma } from '@prisma/client'
import prisma from '../src/utils/prismaClient'

const ORG_NAME = 'Grupo Paradores del Bajío'
const ORG_EMAIL = 'corporativo@paradores-demo.avoqado.io'
const ORG_PHONE = '5512956265'
const TEMPLATE_VENUE_SLUG = 'la-ribera-demo'
const MODULE_CODE = 'MASTER_CATALOG'
const FEATURE_CODE = 'MASTER_CATALOG'

/** Staff that must be able to open the corporate catalog during the demo. */
const CORPORATE_EMAILS = ['jose@avoqado.io', 'owner@owner.com']

/**
 * Two regions, four points of sale. Enough to demonstrate publishing to an
 * explicit subset of branches — which is what the prospect asked for — without
 * making the venue switcher unreadable on a shared screen.
 */
const VENUES = [
  { slug: 'parador-bajio-tienda', name: 'Parador Bajío — Tienda', region: 'Centro', type: 'RETAIL' },
  { slug: 'parador-bajio-restaurante', name: 'Parador Bajío — Restaurante', region: 'Centro', type: 'RESTAURANT' },
  { slug: 'parador-altos-tienda', name: 'Parador Los Altos — Tienda', region: 'Occidente', type: 'RETAIL' },
  { slug: 'parador-altos-cafeteria', name: 'Parador Los Altos — Cafetería', region: 'Occidente', type: 'RESTAURANT' },
] as const

/** Reference data, so the "create product" form has real options to pick from. */
const BRANDS = ['Bimbo', 'Coca-Cola', 'Sabritas', 'Lala', 'Marca Propia']
const MANUFACTURERS = ['Grupo Bimbo', 'Coca-Cola FEMSA', 'PepsiCo México', 'Grupo Lala']
const FAMILIES: Array<{ name: string; children: string[] }> = [
  { name: 'Bebidas', children: ['Agua', 'Refrescos', 'Jugos'] },
  { name: 'Botanas', children: ['Frituras', 'Galletas'] },
  { name: 'Abarrotes', children: ['Panadería', 'Lácteos'] },
]

const dryRun = process.argv.includes('--dry-run')
const teardown = process.argv.includes('--teardown')

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

function log(step: string, detail = ''): void {
  console.log(`${dryRun ? '[dry-run] ' : ''}${step}${detail ? ` — ${detail}` : ''}`)
}

/** Fails loudly rather than seeding a half-built demo an hour before it is shown. */
async function preflight() {
  const template = await prisma.venue.findUnique({ where: { slug: TEMPLATE_VENUE_SLUG } })
  if (!template) throw new Error(`Template venue "${TEMPLATE_VENUE_SLUG}" not found. Cannot clone venue shape.`)

  const moduleDef = await prisma.module.findUnique({ where: { code: MODULE_CODE } })
  if (!moduleDef) throw new Error(`Module "${MODULE_CODE}" is not defined. Run: npx tsx scripts/setup-modules.ts`)
  if (moduleDef.scope !== ModuleScope.ORGANIZATION_ONLY) {
    throw new Error(`Module "${MODULE_CODE}" has scope ${moduleDef.scope}; expected ORGANIZATION_ONLY.`)
  }

  const staff = await prisma.staff.findMany({ where: { email: { in: [...CORPORATE_EMAILS] }, active: true } })
  if (staff.length === 0) throw new Error(`None of ${CORPORATE_EMAILS.join(', ')} exist as active Staff.`)

  log('preflight ok', `template=${template.slug} module=${moduleDef.code} staff=${staff.length}`)
  return { template, moduleDef, staff }
}

async function removeEverything() {
  const org = await prisma.organization.findFirst({ where: { name: ORG_NAME } })
  if (!org) return log('teardown', 'nothing to remove')

  const venues = await prisma.venue.findMany({ where: { organizationId: org.id }, select: { id: true, slug: true } })
  log('teardown', `removing org ${org.id} and its ${venues.length} venues`)
  if (dryRun) return

  // Venue_organizationId_fkey is RESTRICT, not CASCADE: the organization cannot
  // go while it still owns venues. Catalog rows, entitlements and module
  // assignments do cascade from the organization, so venues are the only thing
  // that has to be removed by hand first.
  for (const venue of venues) {
    await prisma.staffVenue.deleteMany({ where: { venueId: venue.id } })
    await prisma.venue.delete({ where: { id: venue.id } })
    log('teardown', `venue ${venue.slug} removed`)
  }
  await prisma.staffOrganization.deleteMany({ where: { organizationId: org.id } })
  await prisma.organization.delete({ where: { id: org.id } })
  log('teardown done')
}

async function run() {
  const { template, moduleDef, staff } = await preflight()
  const actor = staff[0]

  const existing = await prisma.organization.findFirst({ where: { name: ORG_NAME } })
  log('organization', existing ? `reusing ${existing.id}` : 'will create')
  if (dryRun && !existing) return log('dry-run stops here', 'nothing was written')

  const org =
    existing ??
    (await prisma.organization.create({
      data: { name: ORG_NAME, email: ORG_EMAIL, phone: ORG_PHONE },
    }))

  // --- venues, cloned from the template so required columns come along ---
  for (const spec of VENUES) {
    const already = await prisma.venue.findUnique({ where: { slug: spec.slug } })
    if (already) {
      log('venue', `${spec.slug} already exists`)
      continue
    }
    if (dryRun) {
      log('venue', `${spec.slug} would be created (region ${spec.region})`)
      continue
    }

    const { id: _id, createdAt: _c, updatedAt: _u, organizationId: _o, slug: _s, name: _n, ...shape } = template as Record<string, any>
    await prisma.venue.create({
      data: {
        ...(shape as Prisma.VenueUncheckedCreateInput),
        slug: spec.slug,
        name: spec.name,
        organizationId: org.id,
        // The region lives in the venue's own address fields until the regional
        // pricing model ships; the demo only needs it to be visible and grouped.
        city: spec.region,
      },
    })
    log('venue', `${spec.slug} created`)
  }

  const venues = await prisma.venue.findMany({ where: { organizationId: org.id }, select: { id: true, slug: true } })

  // Assigning a corporate item to a branch with the CREATE decision needs a
  // local category to put the product in. A branch cloned from a template
  // carries no menu rows, so without this the assignment step dead-ends on a
  // field the operator has no way to fill.
  for (const venue of venues) {
    if (dryRun) {
      log('categoría', `${venue.slug} tendría "Abarrotes"`)
      continue
    }
    const already = await prisma.menuCategory.findFirst({ where: { venueId: venue.id } })
    if (already) continue
    await prisma.menuCategory.create({ data: { venueId: venue.id, name: 'Abarrotes', slug: 'abarrotes', displayOrder: 1 } })
    log('categoría', `${venue.slug} → Abarrotes`)
  }

  // --- staff access: org-level OWNER is what opens the corporate catalog ---
  for (const person of staff) {
    if (!dryRun) {
      await prisma.staffOrganization.upsert({
        where: { staffId_organizationId: { staffId: person.id, organizationId: org.id } },
        update: { role: 'OWNER', isActive: true, leftAt: null },
        create: { staffId: person.id, organizationId: org.id, role: 'OWNER', isActive: true },
      })
      for (const venue of venues) {
        await prisma.staffVenue.upsert({
          where: { staffId_venueId: { staffId: person.id, venueId: venue.id } },
          update: { active: true },
          create: { staffId: person.id, venueId: venue.id, role: 'OWNER', active: true },
        })
      }
    }
    log('staff', `${person.email} → OWNER of the organization and its ${venues.length} venues`)
  }

  // --- the three switches the catalog needs: entitlement, module, config ---
  if (!dryRun) {
    await prisma.organizationEntitlement.upsert({
      where: { organizationId_featureCode: { organizationId: org.id, featureCode: FEATURE_CODE } },
      update: { status: OrganizationEntitlementStatus.ACTIVE, endsAt: null },
      create: {
        organizationId: org.id,
        featureCode: FEATURE_CODE,
        status: OrganizationEntitlementStatus.ACTIVE,
        source: OrganizationEntitlementSource.CUSTOM,
        grantedById: actor.id,
        reason: 'Demo organization for the corporate master catalog. Not a customer grant.',
      },
    })

    // ADVISORY, never ENFORCED: enforcing would start rejecting legacy product
    // creation, and no client build translates that rejection yet.
    await prisma.organizationModule.upsert({
      where: { organizationId_moduleId: { organizationId: org.id, moduleId: moduleDef.id } },
      update: {
        enabled: true,
        config: {
          schemaVersion: 1,
          catalogCoreEnabled: true,
          identifiersEnabled: false,
          regionalPricingEnabled: false,
          governanceMode: 'ADVISORY',
        },
      },
      create: {
        organizationId: org.id,
        moduleId: moduleDef.id,
        enabled: true,
        enabledBy: actor.id,
        config: {
          schemaVersion: 1,
          catalogCoreEnabled: true,
          identifiersEnabled: false,
          regionalPricingEnabled: false,
          governanceMode: 'ADVISORY',
        },
      },
    })
  }
  log('catalog switches', 'entitlement ACTIVE + module enabled + catalogCoreEnabled true (governance ADVISORY)')

  // --- reference data, so the create-product form is not a set of empty pickers ---
  if (!dryRun) {
    for (const name of BRANDS) {
      await prisma.catalogBrand
        .create({
          data: {
            organizationId: org.id,
            name,
            normalizedName: normalize(name),
            status: CatalogReferenceStatus.ACTIVE,
            createdById: actor.id,
            updatedById: actor.id,
          },
        })
        .catch(() => undefined)
    }
    for (const name of MANUFACTURERS) {
      await prisma.catalogManufacturer
        .create({
          data: {
            organizationId: org.id,
            name,
            normalizedName: normalize(name),
            status: CatalogReferenceStatus.ACTIVE,
            createdById: actor.id,
            updatedById: actor.id,
          },
        })
        .catch(() => undefined)
    }
    for (const family of FAMILIES) {
      const parent = await prisma.catalogFamily
        .create({
          data: {
            organizationId: org.id,
            name: family.name,
            normalizedName: normalize(family.name),
            status: CatalogReferenceStatus.ACTIVE,
            createdById: actor.id,
            updatedById: actor.id,
          },
        })
        .catch(() => null)
      if (!parent) continue
      for (const child of family.children) {
        await prisma.catalogFamily
          .create({
            data: {
              organizationId: org.id,
              name: child,
              normalizedName: normalize(child),
              parentId: parent.id,
              status: CatalogReferenceStatus.ACTIVE,
              createdById: actor.id,
              updatedById: actor.id,
            },
          })
          .catch(() => undefined)
      }
    }
  }
  log('reference data', `${BRANDS.length} marcas, ${MANUFACTURERS.length} fabricantes, ${FAMILIES.length} familias con subfamilias`)

  console.log('')
  console.log('Listo. Para el demo:')
  console.log(`  organizationId : ${org.id}`)
  console.log(`  catálogo       : https://dashboard.avoqado.io/organizations/${org.id}/master-catalog`)
  console.log(`  sucursales     : ${venues.map(v => v.slug).join(', ')}`)
}

async function main() {
  try {
    if (teardown) await removeEverything()
    else await run()
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
