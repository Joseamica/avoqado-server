import {
  CATALOG_VALIDATION_RULE_JSON_MAX_BYTES,
  CATALOG_VALIDATION_RULE_JSON_MAX_NODES,
  assertCatalogValidationRuleJsonV1,
  walkCatalogValidationRuleJsonV1,
} from '@/services/master-catalog/catalogValidationRuleJson.service'

describe('catalog validation-rule JSON V1 boundary', () => {
  it('accepts the exact node boundary and supports cooperative traversal', async () => {
    const value = { x: Array.from({ length: CATALOG_VALIDATION_RULE_JSON_MAX_NODES - 2 }, () => true) }
    expect(() => assertCatalogValidationRuleJsonV1(value)).not.toThrow()

    let visited = 0
    for (const node of walkCatalogValidationRuleJsonV1(value)) {
      void node
      visited += 1
      if (visited % 128 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(visited).toBe(CATALOG_VALIDATION_RULE_JSON_MAX_NODES)
  })

  it('rejects oversized, sparse, cyclic, unsafe, exotic, and NFC-colliding JSON', () => {
    const sparse = new Array(2)
    sparse[1] = true
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const collision = { '\u00e9': true, 'e\u0301': false }
    const malformed = [
      { x: Array.from({ length: CATALOG_VALIDATION_RULE_JSON_MAX_NODES - 1 }, () => true) },
      { x: 'a'.repeat(CATALOG_VALIDATION_RULE_JSON_MAX_BYTES) },
      sparse,
      cycle,
      { unsafe: Number.MAX_SAFE_INTEGER + 1 },
      { exotic: new Date() },
      collision,
    ]

    for (const value of malformed) {
      expect(() => assertCatalogValidationRuleJsonV1(value)).toThrow('CATALOG_VALIDATION_RULE_JSON_INVALID')
    }
  })
})
