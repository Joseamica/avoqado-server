import { COMMERCIAL_CONTRACT_HASH } from '@/contracts/commercial/contractHash'
import { validateDeclaredCommercialContractHash } from '../../../scripts/validate-commercial-contract'

describe('commercial contract workspace validator', () => {
  it('accepts the canonical hash and returns it for manifest evidence', () => {
    expect(validateDeclaredCommercialContractHash(COMMERCIAL_CONTRACT_HASH)).toBe(COMMERCIAL_CONTRACT_HASH)
  })

  it('rejects a repository declaration that drifted from the frozen contract', () => {
    expect(() => validateDeclaredCommercialContractHash('0'.repeat(64))).toThrow(
      `Commercial contract hash mismatch: declared=${'0'.repeat(64)} canonical=${COMMERCIAL_CONTRACT_HASH}`,
    )
  })
})
