/**
 * DELETE AFTER USE — no aplica: este script se queda commiteado como bitácora re-corrible,
 * igual que `temp-cambaceo-migration.ts` (patrón del founder para fixes de datos de PlayTelecom).
 *
 * Crea el venue "ACTIVACIÓN SLP" (Asana 1217556190300772), clonando el venue-molde
 * "Cubre Descanso": mismo type/timezone/currency/country, VenuePaymentConfig, y los
 * VenueModule (SERIALIZED_INVENTORY + COMMISSIONS). A diferencia de "Cambaceo", este venue
 * NO tiene StaffVenue — es un destino contable, nadie hace login ahí.
 *
 * ⚠️ ESCRIBE EN PRODUCCIÓN. Por defecto corre en DRY-RUN (no escribe nada).
 *    Para ejecutar de verdad: CONFIRM=EJECUTAR npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-create-activacion-slp.ts
 *    Dry-run (preview):                          npx ts-node -r tsconfig-paths/register -r dotenv/config scripts/temp-create-activacion-slp.ts
 *
 * Después de correr esto en prod, el job `playtelecomEventSimReassignment` (que ya corre
 * cada 15 min) encuentra el venue por slug SOLO — no hace falta reiniciar el server.
 */
import { PrismaClient } from '@prisma/client'

const url = process.env.RENDER_DATABASE_URL
if (!url) {
  console.error('❌ RENDER_DATABASE_URL missing — aborting.')
  process.exit(1)
}
const prisma = new PrismaClient({ datasources: { db: { url } } })

const DRY_RUN = process.env.CONFIRM !== 'EJECUTAR'

// ── Constantes ──────────────────────────────────────────────────────────
const TEMPLATE_VENUE_ID = 'cmnv_cubredescanso_playtelecom' // molde "Cubre Descanso"
const NEW_VENUE_NAME = 'ACTIVACIÓN SLP'
const NEW_VENUE_SLUG = 'activacion-slp'
const ACTOR_STAFF_ID = 'cmliew9si001epx28q93w9vq2' // Isaac real (auditoría)

const strip = (o: any, keys: string[]) => {
  const c = { ...o }
  keys.forEach(k => delete c[k])
  return c
}
const now = new Date()

async function main() {
  console.log(`\n${DRY_RUN ? '🟡 DRY-RUN (no escribe)' : '🔴 EJECUTANDO ESCRITURAS EN PROD'}\n`)

  const existingSlug = await prisma.venue.findUnique({ where: { slug: NEW_VENUE_SLUG }, select: { id: true, name: true } })
  if (existingSlug) {
    console.error(`❌ Ya existe un venue con slug "${NEW_VENUE_SLUG}" (${existingSlug.name} [${existingSlug.id}]). Abortando.`)
    return
  }

  const tmpl = await prisma.venue.findUnique({ where: { id: TEMPLATE_VENUE_ID } })
  if (!tmpl) {
    console.error('❌ No se encontró el venue molde "Cubre Descanso". Abortando.')
    return
  }
  const tmplPc = await prisma.venuePaymentConfig.findUnique({ where: { venueId: TEMPLATE_VENUE_ID } })
  const tmplMods = await prisma.venueModule.findMany({ where: { venueId: TEMPLATE_VENUE_ID } })

  console.log('PLAN:')
  console.log(
    `  1. CREAR venue "${NEW_VENUE_NAME}" (slug ${NEW_VENUE_SLUG}, type ${tmpl.type}, tz ${tmpl.timezone}, ${tmpl.currency}/${tmpl.country}, org ${tmpl.organizationId})`,
  )
  console.log(`  2. CREAR VenuePaymentConfig → primaryAccountId ${tmplPc?.primaryAccountId ?? '(molde sin pc!)'}`)
  console.log(`  3. CLONAR ${tmplMods.length} VenueModule del molde: ${tmplMods.map(m => m.moduleId).join(', ')}`)
  console.log(`  4. SIN StaffVenue — nadie hace login en este venue`)
  console.log(`  5. ActivityLog por cada mutación (actor ${ACTOR_STAFF_ID})\n`)

  if (DRY_RUN) {
    console.log('🟡 DRY-RUN: no se escribió nada. Re-correr con CONFIRM=EJECUTAR para aplicar.')
    return
  }

  const result = await prisma.$transaction(async tx => {
    const venue = await tx.venue.create({
      data: {
        organizationId: tmpl.organizationId,
        name: NEW_VENUE_NAME,
        slug: NEW_VENUE_SLUG,
        type: tmpl.type,
        timezone: tmpl.timezone,
        currency: tmpl.currency,
        country: tmpl.country,
        state: 'San Luis Potosí',
        active: true,
      },
    })

    if (tmplPc) {
      await tx.venuePaymentConfig.create({ data: { ...strip(tmplPc, ['id', 'venueId', 'createdAt', 'updatedAt']), venueId: venue.id } })
    }

    for (const m of tmplMods) {
      await tx.venueModule.create({
        data: {
          ...strip(m, ['id', 'venueId', 'createdAt', 'updatedAt', 'enabledBy', 'enabledAt']),
          venueId: venue.id,
          enabledBy: ACTOR_STAFF_ID,
          enabledAt: now,
        },
      })
    }

    await tx.activityLog.create({
      data: {
        action: 'VENUE_CREATED',
        entity: 'Venue',
        entityId: venue.id,
        staffId: ACTOR_STAFF_ID,
        venueId: venue.id,
        data: { name: NEW_VENUE_NAME, slug: NEW_VENUE_SLUG, reason: 'Activación SLP (Asana 1217556190300772)' },
      },
    })

    return { venueId: venue.id }
  })

  console.log('✅ HECHO. ACTIVACIÓN SLP creado:', result.venueId)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
