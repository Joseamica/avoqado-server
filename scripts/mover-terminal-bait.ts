/**
 * Mueve una terminal (TPV) de una tienda a otra DENTRO de la misma organización. Dry-run por
 * defecto.
 *
 *   npx tsx scripts/mover-terminal-bait.ts --org-id=<id> --serial=<AVQD-...> --a-venue="<nombre>"          # dry-run
 *   npx tsx scripts/mover-terminal-bait.ts --org-id=<id> --serial=<AVQD-...> --a-venue="<nombre>" \
 *     --apply --actor-staff-id=<id>                                                                        # escribe
 *
 * 🔴 REUTILIZA el mecanismo existente en vez de reimplementarlo: `migratePreflight` /
 * `migrateExecute` (src/services/dashboard/terminal-migration.service.ts), que a su vez delega el
 * re-parent + el "blindar" (auto-encolar el borrado de fábrica) a `updateTerminal`
 * (src/services/dashboard/terminals.superadmin.service.ts). Ahí vive el orden que no se negocia:
 *
 *   1. El re-parent va ANTES del borrado de fábrica — `updateTerminal` cambia venueId y sólo
 *      DESPUÉS encola el FACTORY_RESET. Al revés, el aparato regresa a la tienda vieja al
 *      reiniciar (el factory reset restaura el venue leyéndolo del server).
 *   2. El borrado se encola con la TTL LARGA de migración (`MIGRATION_WIPE_TTL_MS`, 7 días, no
 *      la TTL corta de 30 min por defecto) — ya está resuelto dentro de `updateTerminal`, este
 *      script no toca esa constante ni la reimplementa.
 *
 * Este script llama a `migrateExecute` con `migrateMerchant=false`: la terminal NUNCA se lleva el
 * comercio de origen, siempre adopta el comercio configurado en el venue DESTINO (ver la
 * comprobación previa "config de pago en destino"). Por eso la comparación de comercio de abajo es
 * información para el operador, no una bandera que cambie el comportamiento.
 *
 * `ActivityLog` por terminal movida: se REUTILIZA la del propio `updateTerminal`
 * (acción `TERMINAL_UPDATED`, dos filas — una por el cambio de venueId+wipe, otra por el cambio de
 * assignedMerchantIds) — no se duplica aquí un log propio del script.
 *
 * Comprobaciones previas que se reportan ANTES de escribir (si alguna falla, --apply aborta):
 *   - Origen y destino pertenecen a la misma organización.
 *   - El venue destino tiene configuración de pago (si no, la TPV llegaría sin poder cobrar).
 *   - El venue destino tiene al menos una persona con PIN (si no, nadie podría iniciar sesión).
 *   - Comparación explícita del comercio de origen contra el de destino: si son distintos, aviso
 *     en rojo de que las credenciales de cobro cambian; si son el mismo, se dice también.
 *   - Si la terminal ya tiene una migración (borrado de fábrica) en vuelo.
 */
import prisma from '../src/utils/prismaClient'
import { migratePreflight, migrateExecute, resolveOriginPayment } from '../src/services/dashboard/terminal-migration.service'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1]

const VALID_FLAG_PREFIXES = ['--org-id=', '--serial=', '--a-venue=', '--actor-staff-id=']
const VALID_FLAG_EXACT = ['--apply']

function validarBanderas(argv: string[]): void {
  const desconocidas = argv.filter(
    a => a.startsWith('--') && !VALID_FLAG_EXACT.includes(a) && !VALID_FLAG_PREFIXES.some(prefix => a.startsWith(prefix)),
  )
  if (desconocidas.length) {
    throw new Error(
      `Bandera(s) no reconocida(s): ${desconocidas.join(', ')}.\n` + `Válidas: ${[...VALID_FLAG_EXACT, ...VALID_FLAG_PREFIXES].join(', ')}`,
    )
  }
}

const ORG_ID = arg('org-id')
const SERIAL = arg('serial')
const A_VENUE = arg('a-venue')
const APPLY = process.argv.includes('--apply')

/** Busca la terminal por serial, tolerante al prefijo AVQD- que usa el hardware Android. */
async function findTerminalBySerial(serial: string) {
  const trimmed = serial.trim()
  const variantes = [trimmed, trimmed.replace(/^AVQD-/i, ''), trimmed.startsWith('AVQD-') ? trimmed : `AVQD-${trimmed}`]
  for (const variante of variantes) {
    const terminal = await prisma.terminal.findFirst({
      where: { serialNumber: { equals: variante, mode: 'insensitive' } },
    })
    if (terminal) return terminal
  }
  return null
}

async function main() {
  validarBanderas(process.argv.slice(2))

  if (!ORG_ID) throw new Error('Falta --org-id=<id de la organización>')
  if (!SERIAL) throw new Error('Falta --serial=<serial de la terminal>')
  if (!A_VENUE) throw new Error('Falta --a-venue="<nombre del venue destino>"')

  console.log(`\n=== Mover terminal BAIT (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`)

  const org = await prisma.organization.findUnique({ where: { id: ORG_ID }, select: { id: true, name: true } })
  if (!org) throw new Error(`No encontré la organización ${ORG_ID}`)
  console.log(`Organización: ${org.name} (${org.id})`)

  const terminal = await findTerminalBySerial(SERIAL)
  if (!terminal) throw new Error(`No encontré ninguna terminal con serial "${SERIAL}" (probé con y sin el prefijo AVQD-).`)

  const originVenue = await prisma.venue.findUnique({ where: { id: terminal.venueId } })
  if (!originVenue) throw new Error(`La terminal ${terminal.id} apunta a un venue (${terminal.venueId}) que ya no existe.`)

  // Misma organización, siempre — antes de cualquier otra cosa. migratePreflight/migrateExecute NO
  // exigen esto por sí solos (su guardia cross-org sólo se activa con migrateMerchant=true, que
  // este script nunca pasa), así que el candado vive aquí.
  if (originVenue.organizationId !== org.id) {
    throw new Error(
      `La terminal ${terminal.serialNumber} pertenece al venue "${originVenue.name}", de la organización ${originVenue.organizationId} — ` +
        `NO de "${org.name}" (${org.id}). Abortado: origen y destino deben ser de la misma organización.`,
    )
  }

  const candidatosVenue = await prisma.venue.findMany({
    where: { organizationId: org.id, name: { equals: A_VENUE, mode: 'insensitive' } },
    select: { id: true, name: true, organizationId: true },
  })
  if (candidatosVenue.length === 0) {
    const sugerencias = await prisma.venue.findMany({
      where: { organizationId: org.id, name: { contains: A_VENUE, mode: 'insensitive' } },
      select: { name: true },
      take: 5,
    })
    throw new Error(
      `No encontré ningún venue llamado "${A_VENUE}" en "${org.name}".` +
        (sugerencias.length ? ` ¿Quisiste decir: ${sugerencias.map(v => `"${v.name}"`).join(', ')}?` : ''),
    )
  }
  if (candidatosVenue.length > 1) {
    throw new Error(
      `"${A_VENUE}" es ambiguo dentro de "${org.name}": coincide con ${candidatosVenue.length} venues (${candidatosVenue.map(v => `${v.name} [${v.id}]`).join(', ')}). Usa el nombre completo.`,
    )
  }
  const targetVenue = candidatosVenue[0]

  console.log(`Terminal: ${terminal.serialNumber ?? terminal.id} (${terminal.id})`)
  console.log(`Origen:  ${originVenue.name} (${originVenue.id})`)
  console.log(`Destino: ${targetVenue.name} (${targetVenue.id})\n`)

  // migrateMerchant=false a propósito: nunca forzamos que la terminal se lleve el comercio de
  // origen — la política de este script es que el destino cobre con SU PROPIO comercio ya
  // configurado (por eso NO_PAYMENT_CONFIG sí es bloqueante aquí).
  const pre = await migratePreflight(terminal.id, targetVenue.id, false)

  // --- comparación explícita de comercio (origen vs. lo que la terminal usaría en destino) ---
  const origin = await resolveOriginPayment(
    { venueId: terminal.venueId, assignedMerchantIds: terminal.assignedMerchantIds ?? [] },
    originVenue.organizationId,
  )
  const originMerchantId = origin.merchantIds[0] ?? null
  const destPaymentConfig = await prisma.venuePaymentConfig.findUnique({
    where: { venueId: targetVenue.id },
    select: { primaryAccountId: true },
  })
  const destMerchantId = destPaymentConfig?.primaryAccountId ?? null
  const idsAConsultar = [originMerchantId, destMerchantId].filter((id): id is string => !!id)
  const merchants = idsAConsultar.length
    ? await prisma.merchantAccount.findMany({ where: { id: { in: idsAConsultar } }, select: { id: true, displayName: true } })
    : []
  const nombreMerchant = (id: string | null) => (id ? (merchants.find(m => m.id === id)?.displayName ?? id) : '(ninguno)')

  console.log('— Comprobaciones previas —')
  console.log(`  · Config de pago en destino: ${pre.blockers.some(b => b.code === 'NO_PAYMENT_CONFIG') ? 'NO 🔴 (bloqueante)' : 'sí'}`)
  console.log(
    `  · Venue destino con al menos una persona con PIN: ${pre.blockers.some(b => b.code === 'NO_STAFF_PIN') ? 'NO 🔴 (bloqueante)' : 'sí'}`,
  )
  console.log(
    `  · Migración ya en vuelo para esta terminal: ${pre.blockers.some(b => b.code === 'MIGRATION_IN_PROGRESS') ? 'SÍ 🔴 (bloqueante)' : 'no'}`,
  )
  if (!originMerchantId || !destMerchantId) {
    console.log(
      `  · Comercio: origen=${nombreMerchant(originMerchantId)} · destino=${nombreMerchant(destMerchantId)} — falta uno de los dos, no se puede comparar todavía`,
    )
  } else if (originMerchantId === destMerchantId) {
    console.log(`  · Comercio: MISMO (${nombreMerchant(originMerchantId)}) — las credenciales de cobro NO cambian`)
  } else {
    console.log(
      `  · Comercio: 🔴 DISTINTO — origen cobra con "${nombreMerchant(originMerchantId)}", destino cobrará con "${nombreMerchant(destMerchantId)}". Las credenciales de cobro SÍ cambian.`,
    )
  }
  console.log()

  if (pre.blockers.length) {
    console.log(`— Bloqueantes (${pre.blockers.length}) —`)
    for (const b of pre.blockers) console.log(`  ⨯ [${b.code}] ${b.message}`)
    console.log()
  }
  if (pre.warnings.length) {
    console.log('— Avisos —')
    for (const w of pre.warnings) console.log(`  ! [${w.code}] ${w.message}`)
    console.log()
  }

  if (!APPLY) {
    console.log('Dry-run: no se modificó nada. Corre con --apply para escribir.')
    return
  }

  const actorId = arg('actor-staff-id')
  if (!actorId) throw new Error('Falta --actor-staff-id=<id> — la migración necesita saber quién la ejecutó')

  const actor = await prisma.staff.findFirst({
    where: { id: actorId, organizations: { some: { organizationId: org.id } } },
    select: { id: true, firstName: true, lastName: true },
  })
  if (!actor) {
    throw new Error(
      `--actor-staff-id=${actorId} no corresponde a una persona de la organización "${org.name}" (${org.id}). ` +
        `Verifica el id antes de reintentar.`,
    )
  }

  if (!pre.canProceed) {
    throw new Error(
      `El plan tiene ${pre.blockers.length} bloqueante(s), no se puede aplicar: ${pre.blockers.map(b => b.code).join(', ')}. ` +
        `Resuélvelos antes de reintentar.`,
    )
  }

  const result = await migrateExecute(terminal.id, targetVenue.id, { staffId: actor.id, staffName: `${actor.firstName} ${actor.lastName}` })

  console.log(
    `\n✅ Terminal reasignada a "${targetVenue.name}". commandId=${result.commandId}. ` +
      `El borrado de fábrica quedó encolado con la TTL larga de migración — se aplicará cuando el aparato reconecte.`,
  )
}

main()
  .catch(error => {
    console.error(error)
    // process.exitCode (no process.exit): ver la misma nota en conciliar-estructura-bait.ts — deja
    // que el .finally() de abajo desconecte Prisma antes de que Node salga.
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
