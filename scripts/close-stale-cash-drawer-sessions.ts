/**
 * Cierra las sesiones de caja que quedaron colgadas ANTES de que existiera el
 * auto-cierre.
 *
 * ── Por qué existe este script ────────────────────────────────────────────────
 *
 * El job `cash-drawer-auto-close` sólo empieza a barrer cuando el backend con ese
 * cambio ya esté desplegado. Las sesiones que hoy llevan meses abiertas en
 * PRODUCCIÓN (3 al 2026-08-16, la más vieja desde el 2026-04-28) las cerraría el
 * job en su primera pasada, pero eso pasaría sin que nadie lo vea venir y sobre
 * dinero de tres meses. Este script hace exactamente lo MISMO, con la MISMA
 * marca, pero cuando el founder lo decida y con un dry-run enfrente.
 *
 * 🔴 Llama a `autoCloseStaleDrawerSessions`, la misma función del cron. No hay
 * una segunda implementación: si algún día cambia la marca, cambia en los dos a
 * la vez. Eso es lo que garantiza que las sesiones viejas y las nuevas se vean
 * idénticas en el historial.
 *
 * ── Qué NO hace ───────────────────────────────────────────────────────────────
 *
 *   · No inventa un conteo: `actualAmount` y `overShort` se quedan en NULL.
 *   · No borra ni altera un solo `CashDrawerEvent`.
 *   · No cierra una caja del día de negocio en curso, ni una con movimientos
 *     recientes (mismas reglas que el cron).
 *   · Correrlo dos veces no hace daño: el CAS `status: 'OPEN'` lo hace idempotente.
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *
 *   # 1. DRY-RUN (default): enseña qué cerraría y no escribe nada
 *   npx tsx scripts/close-stale-cash-drawer-sessions.ts
 *
 *   # 2. Aplicar
 *   npx tsx scripts/close-stale-cash-drawer-sessions.ts --execute
 *
 *   # Contra producción (el DATABASE_URL local apunta a la base local):
 *   DATABASE_URL="<url-de-produccion>" npx tsx scripts/close-stale-cash-drawer-sessions.ts
 *   DATABASE_URL="<url-de-produccion>" npx tsx scripts/close-stale-cash-drawer-sessions.ts --execute
 *
 *   # Acotar a un venue o a sesiones puntuales (se pueden repetir las banderas)
 *   npx tsx scripts/close-stale-cash-drawer-sessions.ts --venue <venueId>
 *   npx tsx scripts/close-stale-cash-drawer-sessions.ts --session <sessionId> --execute
 *
 *   # Mover los umbrales (por default: corte 04:00 hora del venue, 2 h sin movimientos)
 *   npx tsx scripts/close-stale-cash-drawer-sessions.ts --business-day-start-hour 6 --idle-grace-hours 12
 */

import logger from '../src/config/logger'
import {
  autoCloseStaleDrawerSessions,
  BUSINESS_DAY_START_HOUR,
  IDLE_GRACE_HOURS,
  MAX_SESSIONS_PER_PASS,
} from '../src/services/shared/cashDrawerAutoClose'
import prisma from '../src/utils/prismaClient'

interface Args {
  execute: boolean
  venueIds: string[]
  sessionIds: string[]
  businessDayStartHour: number
  idleGraceHours: number
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const collect = (flag: string): string[] => {
    const values: string[] = []
    argv.forEach((arg, index) => {
      if (arg === flag && argv[index + 1]) values.push(argv[index + 1])
    })
    return values
  }
  const num = (flag: string, fallback: number): number => {
    const index = argv.indexOf(flag)
    if (index < 0 || !argv[index + 1]) return fallback
    const parsed = Number(argv[index + 1])
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Valor inválido para ${flag}: ${argv[index + 1]}`)
    return parsed
  }

  return {
    execute: argv.includes('--execute'),
    venueIds: collect('--venue'),
    sessionIds: collect('--session'),
    businessDayStartHour: num('--business-day-start-hour', BUSINESS_DAY_START_HOUR),
    idleGraceHours: num('--idle-grace-hours', IDLE_GRACE_HOURS),
  }
}

async function main() {
  const args = parseArgs()
  const mode = args.execute ? 'EXECUTE' : 'DRY-RUN'

  console.log('\n=== Cierre de sesiones de caja colgadas ===')
  console.log(`modo=${mode}  corte=${args.businessDayStartHour}:00 (hora del venue)  gracia=${args.idleGraceHours} h sin movimientos`)
  if (args.venueIds.length) console.log(`venues: ${args.venueIds.join(', ')}`)
  if (args.sessionIds.length) console.log(`sesiones: ${args.sessionIds.join(', ')}`)

  // Siempre se corre primero en seco, incluso con --execute: así el listado que
  // se imprime es el mismo que se va a aplicar, y no "lo que quedó después".
  const preview = await autoCloseStaleDrawerSessions({
    dryRun: true,
    businessDayStartHour: args.businessDayStartHour,
    idleGraceHours: args.idleGraceHours,
    venueIds: args.venueIds.length ? args.venueIds : undefined,
    sessionIds: args.sessionIds.length ? args.sessionIds : undefined,
    maxSessions: MAX_SESSIONS_PER_PASS,
  })

  console.log(`\nsesiones ABIERTAS revisadas: ${preview.scanned}`)
  console.log(`se cerrarían: ${preview.closed}   se dejan como están: ${preview.skipped}   errores: ${preview.errors}`)

  if (preview.closed === 0) {
    console.log('\nNada que cerrar. (Una caja del día en curso, o con movimientos recientes, NO se toca a propósito.)')
    await prisma.$disconnect()
    return
  }

  console.log('\n--- SE CERRARÍAN ---')
  for (const s of preview.closedSessions) {
    console.log(`\n· ${s.venueName} (${s.venueId})`)
    console.log(`  sesión:  ${s.sessionId}`)
    console.log(`  abierta: ${s.openedAt} por ${s.openedByName ?? '—'}${s.deviceName ? ` · ${s.deviceName}` : ''}`)
    console.log(`  lleva:   ${s.hoursOpen} h abierta, ${s.hoursIdle} h sin movimientos`)
    console.log(`  corte:   ${s.businessDayEndedAt}`)
    console.log(`  nota:    ${s.note}`)
  }

  console.log('\nQuedarán con actualAmount = NULL y overShort = NULL: NO es un arqueo, es "nadie la cerró".')
  console.log('Los movimientos (CashDrawerEvent) NO se tocan.')

  if (!args.execute) {
    console.log('\n[DRY-RUN] Nada se escribió. Vuelve a correrlo con --execute para aplicarlo.\n')
    await prisma.$disconnect()
    return
  }

  console.log('\n[EXECUTE] Aplicando...')
  const applied = await autoCloseStaleDrawerSessions({
    businessDayStartHour: args.businessDayStartHour,
    idleGraceHours: args.idleGraceHours,
    venueIds: args.venueIds.length ? args.venueIds : undefined,
    sessionIds: args.sessionIds.length ? args.sessionIds : undefined,
    maxSessions: MAX_SESSIONS_PER_PASS,
  })

  console.log(`\nCerradas: ${applied.closed}   sin tocar: ${applied.skipped}   errores: ${applied.errors}`)
  console.log('\nPara verificar:')
  console.log(
    '  SELECT id, "venueId", "openedAt", "closedAt", "closedByName", "actualAmount", "overShort"\n' +
      '  FROM "CashDrawerSession" WHERE status = \'CLOSED\' AND "actualAmount" IS NULL ORDER BY "closedAt" DESC;\n',
  )

  await prisma.$disconnect()
}

main().catch(async error => {
  logger.error('[CLOSE-STALE-DRAWERS] Falló:', error)
  await prisma.$disconnect().catch(() => undefined)
  process.exit(1)
})
