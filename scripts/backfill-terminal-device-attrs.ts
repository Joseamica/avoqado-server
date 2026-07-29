// scripts/backfill-terminal-device-attrs.ts

/**
 * Rellena `formFactor`, `modelIdentifier` y `osVersion` de las terminales que ya
 * existían antes del device registry (2026-07-28).
 *
 * De dónde salen los datos: las PAX ya mandan `manufacturer`, `model`, `osVersion` y
 * `appVersion` en cada heartbeat de `TerminalHealth`. O sea que la información YA está
 * en la base; sólo hay que subirla al renglón de `Terminal` para que la lista del
 * dashboard pueda mostrar tipo de aparato y filtrar por él.
 *
 * Por eso `avoqado-tpv` NO necesita ningún cambio ni release: cero riesgo sobre el cobro.
 *
 * ── Garantías ─────────────────────────────────────────────────────────────────────
 * · IDEMPOTENTE — sólo toca renglones con `formFactor` en null. Correrlo dos veces da
 *   el mismo resultado. Se puede interrumpir y reanudar sin dejar nada a medias.
 * · NO PISA NADA — jamás sobreescribe un valor que ya exista, ni toca `name`,
 *   `selfRegistered`, `status` ni `deviceUid`.
 * · SIN HEARTBEAT → `UNKNOWN` — una terminal que nunca reportó salud queda marcada como
 *   desconocida, no se adivina. Es honesto y el dashboard lo muestra como tal.
 *
 * Uso — el `NODE_OPTIONS` NO es opcional: sin él, ts-node type-chequea todo el proyecto
 * y revienta con "JavaScript heap out of memory" antes de ejecutar una sola línea.
 * Mismo patrón que `assistant:audit` en package.json.
 *
 *   NODE_OPTIONS='--max-old-space-size=8192' npx ts-node -r tsconfig-paths/register \
 *     scripts/backfill-terminal-device-attrs.ts --dry-run
 *
 *   NODE_OPTIONS='--max-old-space-size=8192' npx ts-node -r tsconfig-paths/register \
 *     scripts/backfill-terminal-device-attrs.ts
 */

import { DeviceFormFactor } from '@prisma/client'

import prisma from '../src/utils/prismaClient'
import { resolveDeviceModel } from '../src/config/deviceCatalog'

const DRY_RUN = process.argv.includes('--dry-run')
const BATCH_SIZE = 200

interface BackfillStats {
  scanned: number
  updated: number
  unknown: number
  skipped: number
}

/**
 * Decide el form factor de una terminal ya existente.
 *
 * Sin heartbeat no hay nada que deducir: `UNKNOWN`. Con heartbeat, `resolveDeviceModel`
 * hace el trabajo — incluido el default por fabricante, que es lo que hace que una PAX o
 * un Sunmi caigan en su categoría de POS aunque el modelo exacto no esté catalogado.
 */
export function deriveFromHealth(health: { manufacturer: string; model: string; osVersion: string } | null): {
  formFactor: DeviceFormFactor
  modelIdentifier: string | null
  osVersion: string | null
} {
  if (!health) {
    return { formFactor: DeviceFormFactor.UNKNOWN, modelIdentifier: null, osVersion: null }
  }

  const resolved = resolveDeviceModel(health.manufacturer, health.model)
  return {
    formFactor: resolved.formFactor,
    modelIdentifier: health.model || null,
    osVersion: health.osVersion || null,
  }
}

async function backfill(): Promise<BackfillStats> {
  const stats: BackfillStats = { scanned: 0, updated: 0, unknown: 0, skipped: 0 }

  // Paginamos por cursor en vez de traer todo: un fleet grande no cabe cómodo en memoria
  // y así el script se puede interrumpir sin perder lo ya hecho (es idempotente).
  let cursor: string | undefined

  for (;;) {
    const terminals = await prisma.terminal.findMany({
      where: { formFactor: null },
      select: { id: true, name: true, venueId: true, modelIdentifier: true, osVersion: true },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    if (terminals.length === 0) break
    cursor = terminals[terminals.length - 1].id

    for (const terminal of terminals) {
      stats.scanned++

      const health = await prisma.terminalHealth.findFirst({
        where: { terminalId: terminal.id },
        orderBy: { createdAt: 'desc' },
        select: { manufacturer: true, model: true, osVersion: true },
      })

      const derived = deriveFromHealth(health)
      if (derived.formFactor === DeviceFormFactor.UNKNOWN) stats.unknown++

      // Nunca pisamos un valor que ya exista: `?? undefined` deja el campo intacto.
      const data = {
        formFactor: derived.formFactor,
        modelIdentifier: terminal.modelIdentifier ?? derived.modelIdentifier ?? undefined,
        osVersion: terminal.osVersion ?? derived.osVersion ?? undefined,
      }

      if (DRY_RUN) {
        console.log(`  [dry-run] ${terminal.name} (${terminal.id}) → ${derived.formFactor} / ${data.modelIdentifier ?? '—'}`)
        stats.skipped++
        continue
      }

      await prisma.terminal.update({ where: { id: terminal.id }, data })
      stats.updated++
    }

    console.log(`… ${stats.scanned} terminales revisadas`)
  }

  return stats
}

async function main(): Promise<void> {
  console.log(`\n📱 Backfill de atributos de dispositivo${DRY_RUN ? ' (DRY RUN — no escribe nada)' : ''}\n`)

  const stats = await backfill()

  console.log('\n─────────────────────────────────────')
  console.log(`Revisadas:      ${stats.scanned}`)
  console.log(`Actualizadas:   ${stats.updated}`)
  console.log(`Sin heartbeat:  ${stats.unknown} (quedaron en UNKNOWN)`)
  if (DRY_RUN) console.log(`Omitidas:       ${stats.skipped} (dry run)`)
  console.log('─────────────────────────────────────\n')
}

// Sólo corre si se invoca directo; importarlo desde un test no dispara nada.
if (require.main === module) {
  main()
    .catch(error => {
      console.error('❌ El backfill falló:', error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
