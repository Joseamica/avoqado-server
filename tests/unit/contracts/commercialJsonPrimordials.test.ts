import { canonicalJsonV2, parseJsonTextV2Strict } from '@/services/commercial/commercialCanonicalJsonV2.service'
import { materializeCommercialContractV2Json } from '@/services/commercial/commercialContractV2Materialization.service'

describe('commercial JSON runtime primordials', () => {
  it('ignores a context-sensitive JSON.parse replacement installed after module import', () => {
    const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, 'parse')
    if (!parseDescriptor || !('value' in parseDescriptor)) throw new Error('JSON.parse primordial missing')
    const originalParse = parseDescriptor.value as typeof JSON.parse
    const document = '{"label":"value","amount":12}'
    let parseCallbacks = 0
    let parsed: unknown

    try {
      Object.defineProperty(JSON, 'parse', {
        ...parseDescriptor,
        value(text: string) {
          parseCallbacks += 1
          if (text === document) return { forged: true }
          return originalParse(text)
        },
      })
      parsed = parseJsonTextV2Strict(document)
    } finally {
      Object.defineProperty(JSON, 'parse', parseDescriptor)
    }

    expect(parseCallbacks).toBe(0)
    expect(parsed).toEqual({ label: 'value', amount: 12 })
  })

  it('ignores a JSON.stringify replacement across canonicalization and materialization', () => {
    const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify')
    if (!stringifyDescriptor || !('value' in stringifyDescriptor)) throw new Error('JSON.stringify primordial missing')
    const originalStringify = stringifyDescriptor.value as typeof JSON.stringify
    let stringifyCallbacks = 0
    let canonical: string | undefined
    let materialized: unknown

    try {
      Object.defineProperty(JSON, 'stringify', {
        ...stringifyDescriptor,
        value(value: unknown) {
          stringifyCallbacks += 1
          return originalStringify(value)
        },
      })
      canonical = canonicalJsonV2({ label: 'value', amount: 12 })
      materialized = materializeCommercialContractV2Json({ label: 'value', amount: 12 })
    } finally {
      Object.defineProperty(JSON, 'stringify', stringifyDescriptor)
    }

    expect(stringifyCallbacks).toBe(0)
    expect(canonical).toBe('{"amount":12,"label":"value"}')
    expect(materialized).toEqual({ label: 'value', amount: 12 })
  })
})
