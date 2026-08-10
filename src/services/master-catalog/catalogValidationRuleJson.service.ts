export const CATALOG_VALIDATION_RULE_JSON_MAX_NODES = 4_096
export const CATALOG_VALIDATION_RULE_JSON_MAX_BYTES = 256 * 1_024

interface RuleJsonBudget {
  nodes: number
  bytes: number
  seen: WeakSet<object>
}

function invalidRuleJson(): never {
  throw new Error('CATALOG_VALIDATION_RULE_JSON_INVALID')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function addBytes(budget: RuleJsonBudget, value: string | number): void {
  budget.bytes += typeof value === 'number' ? value : Buffer.byteLength(value, 'utf8')
  if (budget.bytes > CATALOG_VALIDATION_RULE_JSON_MAX_BYTES) invalidRuleJson()
}

export function* walkCatalogValidationRuleJsonV1(root: unknown): Generator<void> {
  const budget: RuleJsonBudget = { nodes: 0, bytes: 0, seen: new WeakSet() }
  const pending: unknown[] = [root]
  while (pending.length) {
    const value = pending.pop()
    budget.nodes += 1
    if (budget.nodes > CATALOG_VALIDATION_RULE_JSON_MAX_NODES) invalidRuleJson()

    if (value === null) addBytes(budget, 4)
    else if (typeof value === 'boolean') addBytes(budget, value ? 4 : 5)
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) invalidRuleJson()
      addBytes(budget, String(value))
    } else if (typeof value === 'string') {
      addBytes(budget, JSON.stringify(value.normalize('NFC')))
    } else if (Array.isArray(value)) {
      if (budget.seen.has(value)) invalidRuleJson()
      budget.seen.add(value)
      addBytes(budget, 2 + Math.max(0, value.length - 1))
      for (let index = value.length - 1; index >= 0; index -= 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) invalidRuleJson()
        pending.push(value[index])
      }
    } else {
      if (!isPlainRecord(value) || budget.seen.has(value)) invalidRuleJson()
      budget.seen.add(value)
      const entries = Object.entries(value)
      addBytes(budget, 2 + Math.max(0, entries.length - 1))
      const normalizedKeys = new Set<string>()
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, nested] = entries[index] as [string, unknown]
        const normalizedKey = key.normalize('NFC')
        if (normalizedKeys.has(normalizedKey)) invalidRuleJson()
        normalizedKeys.add(normalizedKey)
        addBytes(budget, `${JSON.stringify(normalizedKey)}:`)
        pending.push(nested)
      }
    }
    // WHY: The iterable exposes one checkpoint per JSON node so import
    // revalidation can yield, while Task 6 can consume the identical policy
    // synchronously before canonicalization and persistence.
    yield
  }
}

export function assertCatalogValidationRuleJsonV1(value: unknown): void {
  // WHY: One bounded policy rejects exotic/sparse/cyclic JSON, unsafe numbers,
  // oversized rule trees, and NFC key collisions at every producer/consumer.
  for (const _ of walkCatalogValidationRuleJsonV1(value)) {
    // Consuming the iterator performs validation; no derived payload is kept.
  }
}
