import prisma from '@/utils/prismaClient'
import {
  cleanupCommercialAcquisitionContexts,
  type CommercialAcquisitionContextCleanupOptions,
  type CommercialAcquisitionContextCleanupResult,
} from '@/services/commercial/commercialAcquisitionContextCleanup.service'

const DEFAULTS: Required<CommercialAcquisitionContextCleanupOptions> = {
  execute: false,
  pageSize: 50,
  maxScanned: 500,
  maxRuntimeMs: 5_000,
}

interface CommercialAcquisitionContextCleanupCliDependencies {
  cleanup(options: CommercialAcquisitionContextCleanupOptions): Promise<CommercialAcquisitionContextCleanupResult>
  disconnect(): Promise<void>
  write(text: string): void
}

function invalidArgument(): never {
  throw new Error('COMMERCIAL_ACQUISITION_CLEANUP_CLI_ARGUMENT_INVALID')
}

function boundedValue(argument: string, prefix: string, maximum: number): number {
  const raw = argument.slice(prefix.length)
  if (!/^[1-9]\d*$/.test(raw)) return invalidArgument()
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximum) return invalidArgument()
  return value
}

export function parseCommercialAcquisitionContextCleanupCliArgs(
  argv: readonly string[],
): Required<CommercialAcquisitionContextCleanupOptions> {
  const parsed = { ...DEFAULTS }
  const seen = new Set<string>()
  for (const argument of argv) {
    const key = argument === '--execute' ? '--execute' : argument.split('=', 1)[0]
    if (seen.has(key)) return invalidArgument()
    seen.add(key)
    if (argument === '--execute') parsed.execute = true
    else if (argument.startsWith('--page-size=')) parsed.pageSize = boundedValue(argument, '--page-size=', 100)
    else if (argument.startsWith('--max-scanned=')) parsed.maxScanned = boundedValue(argument, '--max-scanned=', 1_000)
    else if (argument.startsWith('--max-runtime-ms=')) parsed.maxRuntimeMs = boundedValue(argument, '--max-runtime-ms=', 10_000)
    else return invalidArgument()
  }
  return parsed
}

const defaultDependencies: CommercialAcquisitionContextCleanupCliDependencies = {
  cleanup: cleanupCommercialAcquisitionContexts,
  disconnect: () => prisma.$disconnect(),
  write: text => {
    process.stdout.write(text)
  },
}

export async function runCommercialAcquisitionContextCleanupCli(
  argv: readonly string[],
  dependencies: CommercialAcquisitionContextCleanupCliDependencies = defaultDependencies,
): Promise<CommercialAcquisitionContextCleanupResult> {
  try {
    const options = parseCommercialAcquisitionContextCleanupCliArgs(argv)
    const result = await dependencies.cleanup(options)
    dependencies.write(`${JSON.stringify(result)}\n`)
    return result
  } finally {
    await dependencies.disconnect()
  }
}

if (require.main === module) {
  void runCommercialAcquisitionContextCleanupCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('COMMERCIAL_ACQUISITION_CLEANUP_FAILED\n')
    process.exitCode = 1
  })
}
