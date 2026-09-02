/**
 * Separa la tienda compartida "Cubre Descanso" en una tienda POR ZONA.
 *
 * Asana 1217743599033214. Propuesta de Isaac Mayoral (1-sep-2026):
 *
 *   BSCBJOSE04  José Lopes          → CUBRE DESCANSO ZONA SUR1    (supervisor: Juan Nájera)
 *   BESDICC9701 Carlos Vicente Díaz → CUBRE DESCANSO ZONA NORTE1  (supervisor: René Cubos)
 *   BSCLOXH0405 Heavan Leigh López  → CUBRE DESCANSO ZONA NORTE2  (supervisor: René Cubos)
 *
 * 🔴 POR QUÉ HACE FALTA: una tienda tiene UN supervisor. Con los tres relevos compartiendo
 * "Cubre Descanso" es imposible que José cuelgue de Juan y los otros dos de René — que es
 * justo lo que Isaac pidió ("Juan 10 tiendas y 1 cubre descanso, René 10 y 2").
 *
 * 🔴 POR QUÉ SE RENOMBRA EN VEZ DE CREAR TRES: la tienda actual NO está vacía — arrastra
 * 360 ventas (José 220 desde el 24-jun y sigue vendiendo; Heavan 140) y 2 terminales.
 * Renombrarla a la zona de José deja quieto al que más vende: conserva sus ventas y su
 * terminal sin tocar nada. Carlos nace limpio (0 ventas, sin terminal).
 *
 * ⚠️ ALCANCE DE ESTE SCRIPT — sólo lo que NO depende de una respuesta pendiente de Isaac:
 *   1. RENOMBRA "Cubre Descanso" → "CUBRE DESCANSO ZONA SUR1"
 *   2. CREA "CUBRE DESCANSO ZONA NORTE1" clonando el molde (VenuePaymentConfig + VenueModule)
 *
 * NO hace la ZONA NORTE2 de Heavan: mover su terminal implica decidir antes qué pasa con sus
 * 140 ventas históricas, y esa respuesta todavía no llega. Se hace en una segunda pasada.
 *
 * 🔴 Las ASIGNACIONES de personal NO se hacen aquí: las hace `conciliar-estructura-bait.ts`
 * a partir del Excel, con su mapa `VENUES_SIN_ID` por número de empleado. Este script sólo
 * deja las tiendas listas.
 *
 * ⚠️ ESCRIBE EN PRODUCCIÓN. Por defecto corre en DRY-RUN (no escribe nada).
 *    Dry-run:   npx tsx scripts/separar-cubre-descanso-zonas.ts
 *    Ejecutar:  CONFIRM=EJECUTAR npx tsx scripts/separar-cubre-descanso-zonas.ts
 */
import { PrismaClient } from '@prisma/client'

const url = process.env.RENDER_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('❌ Falta RENDER_DATABASE_URL (o DATABASE_URL) — abortando.')
  process.exit(1)
}
const prisma = new PrismaClient({ datasources: { db: { url } } })

const DRY_RUN = process.env.CONFIRM !== 'EJECUTAR'

// ── Constantes ──────────────────────────────────────────────────────────
const VENUE_COMPARTIDO_ID = 'cmnv_cubredescanso_playtelecom'
const NOMBRE_SUR1 = 'CUBRE DESCANSO ZONA SUR1'
const NOMBRE_NORTE1 = 'CUBRE DESCANSO ZONA NORTE1'
const SLUG_NORTE1 = 'cubre-descanso-zona-norte1'
const ACTOR_STAFF_ID = 'cmi9cku0c0005pr2d50egxd42' // quien ejecuta (auditoría)

const strip = (o: any, keys: string[]) => {
  const c = { ...o }
  keys.forEach(k => delete c[k])
  return c
}
const now = new Date()

async function main() {
  console.log(`\n${DRY_RUN ? '🟡 DRY-RUN (no escribe)' : '🔴 ESCRIBIENDO EN PRODUCCIÓN'}\n`)

  const molde = await prisma.venue.findUnique({ where: { id: VENUE_COMPARTIDO_ID } })
  if (!molde) {
    console.error(`❌ No encontré el venue ${VENUE_COMPARTIDO_ID}. Abortando.`)
    return
  }

  // Idempotencia: si ya se corrió, no volver a renombrar ni a duplicar.
  const yaRenombrado = molde.name === NOMBRE_SUR1
  const norte1Existente = await prisma.venue.findFirst({
    where: { organizationId: molde.organizationId, name: NOMBRE_NORTE1 },
    select: { id: true, name: true },
  })

  const pc = await prisma.venuePaymentConfig.findUnique({ where: { venueId: VENUE_COMPARTIDO_ID } })
  const mods = await prisma.venueModule.findMany({ where: { venueId: VENUE_COMPARTIDO_ID } })
  const ordenes = await prisma.order.count({ where: { venueId: VENUE_COMPARTIDO_ID } })
  const terminales = await prisma.terminal.count({ where: { venueId: VENUE_COMPARTIDO_ID } })

  console.log(`Molde: "${molde.name}" [${molde.id}] · ${ordenes} órdenes · ${terminales} terminales`)
  console.log(`  VenuePaymentConfig: ${pc ? 'sí' : 'NO (el molde no tiene)'} · VenueModule: ${mods.length}\n`)

  console.log('PLAN:')
  console.log(
    yaRenombrado
      ? `  1. (ya hecho) el venue ya se llama "${NOMBRE_SUR1}"`
      : `  1. RENOMBRAR "${molde.name}" → "${NOMBRE_SUR1}" (conserva sus ${ordenes} órdenes y ${terminales} terminales)`,
  )
  console.log(
    norte1Existente
      ? `  2. (ya hecho) "${NOMBRE_NORTE1}" ya existe [${norte1Existente.id}]`
      : `  2. CREAR "${NOMBRE_NORTE1}" (slug ${SLUG_NORTE1}) clonando config de pago y ${mods.length} módulos`,
  )
  console.log(`  3. ActivityLog por cada mutación (actor ${ACTOR_STAFF_ID})`)
  console.log(`  4. NO se toca la ZONA NORTE2 de Heavan — espera respuesta sobre sus 140 ventas`)
  console.log(`  5. NO se asigna personal — eso lo hace el conciliador desde el Excel\n`)

  if (yaRenombrado && norte1Existente) {
    console.log('✅ Nada que hacer: ya está aplicado.')
    return
  }

  if (DRY_RUN) {
    console.log('🟡 DRY-RUN: no se escribió nada. Re-correr con CONFIRM=EJECUTAR para aplicar.')
    return
  }

  const result = await prisma.$transaction(async tx => {
    let norte1Id = norte1Existente?.id ?? null

    if (!yaRenombrado) {
      await tx.venue.update({ where: { id: VENUE_COMPARTIDO_ID }, data: { name: NOMBRE_SUR1 } })
      await tx.activityLog.create({
        data: {
          action: 'VENUE_UPDATED',
          entity: 'Venue',
          entityId: VENUE_COMPARTIDO_ID,
          staffId: ACTOR_STAFF_ID,
          venueId: VENUE_COMPARTIDO_ID,
          data: {
            campo: 'name',
            de: molde.name,
            a: NOMBRE_SUR1,
            motivo: 'Separar los cubre descanso por zona para que cada uno cuelgue de su supervisor (Asana 1217743599033214)',
          },
        },
      })
    }

    if (!norte1Id) {
      const nuevo = await tx.venue.create({
        data: {
          organizationId: molde.organizationId,
          name: NOMBRE_NORTE1,
          slug: SLUG_NORTE1,
          type: molde.type,
          timezone: molde.timezone,
          currency: molde.currency,
          country: molde.country,
          state: molde.state,
          city: molde.city,
          status: 'ACTIVE',
          active: true,
        },
      })
      norte1Id = nuevo.id

      if (pc) {
        await tx.venuePaymentConfig.create({
          data: { ...strip(pc, ['id', 'venueId', 'createdAt', 'updatedAt']), venueId: nuevo.id },
        })
      }

      for (const m of mods) {
        await tx.venueModule.create({
          data: {
            ...strip(m, ['id', 'venueId', 'createdAt', 'updatedAt', 'enabledBy', 'enabledAt']),
            venueId: nuevo.id,
            enabledBy: ACTOR_STAFF_ID,
            enabledAt: now,
          },
        })
      }

      await tx.activityLog.create({
        data: {
          action: 'VENUE_CREATED',
          entity: 'Venue',
          entityId: nuevo.id,
          staffId: ACTOR_STAFF_ID,
          venueId: nuevo.id,
          data: {
            name: NOMBRE_NORTE1,
            slug: SLUG_NORTE1,
            molde: VENUE_COMPARTIDO_ID,
            modulos: mods.length,
            motivo: 'Cubre descanso por zona — Carlos Vicente Díaz (Asana 1217743599033214)',
          },
        },
      })
    }

    return { norte1Id }
  })

  console.log(`✅ HECHO.`)
  console.log(`   "${NOMBRE_SUR1}" → ${VENUE_COMPARTIDO_ID}`)
  console.log(`   "${NOMBRE_NORTE1}" → ${result.norte1Id}`)
  console.log(`\n🔴 SIGUIENTE: actualizar VENUES_SIN_ID en scripts/conciliar-estructura-bait.ts y correr el conciliador.`)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
