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
 * ALCANCE:
 *   1. RENOMBRA "Cubre Descanso" → "CUBRE DESCANSO ZONA SUR1"
 *   2. CREA "ZONA NORTE1" y "ZONA NORTE2" clonando el molde (VenuePaymentConfig + VenueModule)
 *   3. MUEVE la terminal de Heavan a su ZONA NORTE2
 *
 * 🔴 LAS VENTAS HISTÓRICAS NO SE TOCAN, y no es una omisión — lo contestó Isaac el 4-sep:
 * «son 2 cosas distintas, las ventas por promotor y las ventas a nivel tienda». Medido contra
 * la base: las 183 SIMs vendidas de Heavan conservan su `assignedPromoterId` en el 100% de los
 * casos, repartidas en 8 tiendas. O sea que el eje PROMOTOR ya la sigue a donde vaya, sin mover
 * un solo registro; el eje TIENDA se queda donde ocurrió la venta, que es lo correcto. Reasignar
 * ventas entre tiendas es el proceso aparte que el propio Isaac reconoce pendiente.
 *
 * 🔴 LA TERMINAL SÍ se mueve, y es lo único que de verdad hacía falta: mientras siga parentada
 * en SUR1, las ventas NUEVAS de Heavan seguirían cayendo en la tienda de José — el problema que
 * ella reportó, repitiéndose mañana. Sólo cambia `Terminal.venueId`: las órdenes ya creadas
 * llevan su propio `venueId` y no se recalculan.
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
const NOMBRE_NORTE2 = 'CUBRE DESCANSO ZONA NORTE2'
const SLUG_NORTE2 = 'cubre-descanso-zona-norte2'

// La terminal de Heavan Leigh (BSCLOXH0405). Identificada por sus ventas, no por su nombre:
// las dos terminales de la tienda compartida se llaman igual que su serial, y confundirlas
// mandaría las ventas de José a la zona equivocada. Medido el 4-sep: 148 ventas suyas con
// ésta y 233 de José con AVQD-2841653399, sin un solo cruce.
const TERMINAL_HEAVAN = 'AVQD-2840744203'
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
  const norte2Existente = await prisma.venue.findFirst({
    where: { organizationId: molde.organizationId, name: NOMBRE_NORTE2 },
    select: { id: true, name: true },
  })
  const terminalHeavan = await prisma.terminal.findFirst({
    where: { serialNumber: TERMINAL_HEAVAN },
    select: { id: true, venueId: true, serialNumber: true },
  })
  const terminalYaMovida = terminalHeavan !== null && terminalHeavan.venueId !== VENUE_COMPARTIDO_ID

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
  console.log(
    norte2Existente
      ? `  3. (ya hecho) "${NOMBRE_NORTE2}" ya existe [${norte2Existente.id}]`
      : `  3. CREAR "${NOMBRE_NORTE2}" (slug ${SLUG_NORTE2}) clonando config de pago y ${mods.length} módulos`,
  )
  console.log(
    !terminalHeavan
      ? `  4. ⚠️ NO encontré la terminal ${TERMINAL_HEAVAN} — se omite el traslado`
      : terminalYaMovida
        ? `  4. (ya hecho) la terminal ${TERMINAL_HEAVAN} ya salió de la tienda compartida`
        : `  4. MOVER la terminal ${TERMINAL_HEAVAN} → "${NOMBRE_NORTE2}" (las ventas ya creadas no se recalculan)`,
  )
  console.log(`  5. ActivityLog por cada mutación (actor ${ACTOR_STAFF_ID})`)
  console.log(`  6. NO se tocan las ventas históricas — decisión de Isaac (4-sep): promotor y tienda son ejes distintos`)
  console.log(`  7. NO se asigna personal — eso lo hace el conciliador desde el Excel\n`)

  if (yaRenombrado && norte1Existente && norte2Existente && (terminalYaMovida || !terminalHeavan)) {
    console.log('✅ Nada que hacer: ya está aplicado.')
    return
  }

  if (DRY_RUN) {
    console.log('🟡 DRY-RUN: no se escribió nada. Re-correr con CONFIRM=EJECUTAR para aplicar.')
    return
  }

  const result = await prisma.$transaction(async tx => {
    let norte1Id = norte1Existente?.id ?? null
    let norte2Id = norte2Existente?.id ?? null

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

    // Crear una zona clonando el molde. Se extrajo para que NORTE1 y NORTE2 nazcan
    // idénticas: dos copias del mismo bloque divergen en cuanto alguien toca una sola.
    const crearZona = async (nombre: string, slug: string, quien: string): Promise<string> => {
      const nuevo = await tx.venue.create({
        data: {
          organizationId: molde.organizationId,
          name: nombre,
          slug,
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
            name: nombre,
            slug,
            molde: VENUE_COMPARTIDO_ID,
            modulos: mods.length,
            motivo: `Cubre descanso por zona — ${quien} (Asana 1217743599033214)`,
          },
        },
      })

      return nuevo.id
    }

    if (!norte1Id) norte1Id = await crearZona(NOMBRE_NORTE1, SLUG_NORTE1, 'Carlos Vicente Díaz')
    if (!norte2Id) norte2Id = await crearZona(NOMBRE_NORTE2, SLUG_NORTE2, 'Heavan Leigh López')

    // 🔴 La terminal es lo que decide en qué tienda cae una venta NUEVA. Sin moverla, las
    // ventas futuras de Heavan seguirían contándose en la tienda de José.
    if (terminalHeavan && !terminalYaMovida) {
      await tx.terminal.update({ where: { id: terminalHeavan.id }, data: { venueId: norte2Id } })
      await tx.activityLog.create({
        data: {
          action: 'TERMINAL_VENUE_CHANGED',
          entity: 'Terminal',
          entityId: terminalHeavan.id,
          staffId: ACTOR_STAFF_ID,
          venueId: norte2Id,
          data: {
            serialNumber: terminalHeavan.serialNumber,
            de: VENUE_COMPARTIDO_ID,
            a: norte2Id,
            promotor: 'Heavan Leigh López (BSCLOXH0405)',
            motivo: 'Cubre descanso por zona: sus ventas nuevas deben caer en SU tienda (Asana 1217743599033214)',
            ventasHistoricas: 'no se recalculan — conservan el venueId con el que se crearon',
          },
        },
      })
    }

    return { norte1Id, norte2Id }
  })

  console.log(`✅ HECHO.`)
  console.log(`   "${NOMBRE_SUR1}" → ${VENUE_COMPARTIDO_ID}`)
  console.log(`   "${NOMBRE_NORTE1}" → ${result.norte1Id}`)
  console.log(`   "${NOMBRE_NORTE2}" → ${result.norte2Id}`)
  console.log(`\n🔴 SIGUIENTE: actualizar VENUES_SIN_ID en scripts/conciliar-estructura-bait.ts y correr el conciliador.`)
}

main()
  .catch(e => {
    console.error('Error:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
