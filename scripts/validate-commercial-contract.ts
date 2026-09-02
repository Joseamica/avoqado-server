import { COMMERCIAL_CONTRACT_HASH } from '@/contracts/commercial/contractHash'

const HASH = /^[0-9a-f]{64}$/

export function validateDeclaredCommercialContractHash(declaredHash: string): string {
  if (!HASH.test(declaredHash)) throw new Error('Declared commercial contract hash must be 64 lowercase hexadecimal characters')
  if (declaredHash !== COMMERCIAL_CONTRACT_HASH) {
    throw new Error(`Commercial contract hash mismatch: declared=${declaredHash} canonical=${COMMERCIAL_CONTRACT_HASH}`)
  }
  return COMMERCIAL_CONTRACT_HASH
}

function expectedFromArgv(argv: string[]): string | undefined {
  const index = argv.indexOf('--expected')
  return index >= 0 ? argv[index + 1] : undefined
}

export function runCommercialContractValidator(argv: string[] = process.argv.slice(2)): string {
  const declared = expectedFromArgv(argv) ?? process.env.COMMERCIAL_CONTRACT_HASH
  return declared ? validateDeclaredCommercialContractHash(declared) : COMMERCIAL_CONTRACT_HASH
}

if (require.main === module) {
  try {
    process.stdout.write(`${runCommercialContractValidator()}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Commercial contract validation failed'}\n`)
    process.exitCode = 1
  }
}
