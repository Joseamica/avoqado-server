/**
 * Repairs self-registered POS rows that the legacy TPV heartbeat monitor marked
 * INACTIVE. Dry-run is the default; only an explicit --apply can write.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/remediate-pos-terminal-status.ts
 *   npx ts-node -r tsconfig-paths/register scripts/remediate-pos-terminal-status.ts --apply
 */

import { ActivityActorType, Prisma, TerminalStatus, TerminalType } from '@prisma/client'

import prisma from '../src/utils/prismaClient'

export const POS_REMEDIATION_BATCH_SIZE = 100
export const POS_REMEDIATION_MAX_PRINTED_IDS = 20

export const POS_REMEDIATION_SELECTOR: Prisma.TerminalWhereInput = {
  selfRegistered: true,
  type: { in: [TerminalType.POS_ANDROID, TerminalType.POS_IOS, TerminalType.POS_DESKTOP] },
  activatedAt: null,
  status: TerminalStatus.INACTIVE,
}

const REMEDIATION_ACTION = 'POS_TERMINAL_STATUS_REMEDIATED'
const REMEDIATION_SERVICE_PRINCIPAL = 'POS_TERMINAL_STATUS_REMEDIATION'
const REMEDIATION_REASON = 'Corrección de estado lifecycle contaminado por el monitor de heartbeat TPV.'

interface PosCandidate {
  id: string
  venueId: string
}

interface PosRemediationTransaction {
  terminal: {
    updateMany(args: { where: Prisma.TerminalWhereInput; data: { status: TerminalStatus } }): Promise<{ count: number }>
  }
  activityLog: {
    create(args: {
      data: {
        action: string
        entity: string
        entityId: string
        venueId: string | null
        actorType: ActivityActorType
        servicePrincipalId: string
        data: {
          oldStatus: TerminalStatus
          newStatus: TerminalStatus
          reason: string
        }
      }
    }): Promise<unknown>
  }
}

export interface PosRemediationDb {
  terminal: {
    findMany(args: {
      where: Prisma.TerminalWhereInput
      select: { id: true; venueId: true }
      orderBy: { id: 'asc' }
      take: number
      cursor?: { id: string }
      skip?: number
    }): Promise<PosCandidate[]>
  }
  $transaction<T>(callback: (tx: PosRemediationTransaction) => Promise<T>): Promise<T>
}

export interface PosRemediationStats {
  selected: number
  updated: number
  skipped: number
}

export function parseRemediationArgs(argv: string[]): { apply: boolean } {
  const unknown = argv.filter(argument => argument !== '--apply')
  if (unknown.length > 0) {
    throw new Error('Bandera o argumento no reconocido. La única bandera válida es --apply.')
  }

  return { apply: argv.includes('--apply') }
}

export async function runPosTerminalStatusRemediation(options?: {
  db?: PosRemediationDb
  apply?: boolean
  log?: (message: string) => void
}): Promise<PosRemediationStats> {
  const db = options?.db ?? (prisma as unknown as PosRemediationDb)
  const apply = options?.apply ?? false
  const log = options?.log ?? console.log
  const stats: PosRemediationStats = { selected: 0, updated: 0, skipped: 0 }
  const printedIds: string[] = []
  let cursor: string | undefined

  log(`Modo: ${apply ? 'APPLY' : 'DRY-RUN'}`)

  for (;;) {
    const candidates = await db.terminal.findMany({
      where: POS_REMEDIATION_SELECTOR,
      select: { id: true, venueId: true },
      orderBy: { id: 'asc' },
      take: POS_REMEDIATION_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })

    if (candidates.length === 0) break

    cursor = candidates[candidates.length - 1].id
    stats.selected += candidates.length
    for (const candidate of candidates) {
      if (printedIds.length < POS_REMEDIATION_MAX_PRINTED_IDS) printedIds.push(candidate.id)

      if (!apply) {
        stats.skipped++
        continue
      }

      const updated = await db.$transaction(async tx => {
        const result = await tx.terminal.updateMany({
          where: { ...POS_REMEDIATION_SELECTOR, id: candidate.id, venueId: candidate.venueId },
          data: { status: TerminalStatus.ACTIVE },
        })

        if (result.count !== 1) return false

        await tx.activityLog.create({
          data: {
            action: REMEDIATION_ACTION,
            entity: 'Terminal',
            entityId: candidate.id,
            venueId: candidate.venueId,
            actorType: ActivityActorType.SERVICE,
            servicePrincipalId: REMEDIATION_SERVICE_PRINCIPAL,
            data: {
              oldStatus: TerminalStatus.INACTIVE,
              newStatus: TerminalStatus.ACTIVE,
              reason: REMEDIATION_REASON,
            },
          },
        })

        return true
      })

      if (updated) stats.updated++
      else stats.skipped++
    }

    if (candidates.length < POS_REMEDIATION_BATCH_SIZE) break
  }

  log(`Seleccionadas: ${stats.selected}`)
  log(`IDs seleccionados (máximo ${POS_REMEDIATION_MAX_PRINTED_IDS}): ${printedIds.length > 0 ? printedIds.join(', ') : '(ninguno)'}`)
  log(`Resultado: selected=${stats.selected} updated=${stats.updated} skipped=${stats.skipped}`)

  return stats
}

async function main(): Promise<void> {
  const { apply } = parseRemediationArgs(process.argv.slice(2))
  await runPosTerminalStatusRemediation({ apply })
}

// Importing this module must never query, write, print or open/close a DB connection.
if (require.main === module) {
  main()
    .catch(error => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
