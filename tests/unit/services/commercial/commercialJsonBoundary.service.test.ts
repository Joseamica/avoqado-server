import type { Prisma } from '@prisma/client'

type JsonBoundaryModule = {
  assertCommercialJsonValue(value: unknown): Prisma.InputJsonValue
}

function loadBoundary(): JsonBoundaryModule {
  // Runtime loading lets the first TDD observation fail as an assertion while the module is intentionally absent.
  return require('@/services/commercial/commercialJsonBoundary.service') as JsonBoundaryModule
}

describe('commercial JSON boundary', () => {
  it('materializes a detached I-JSON graph with null-prototype objects', () => {
    const source = { event: 'COMMERCIAL_QUOTE_CREATED', nested: { amount: '24900' }, lines: [1, true, null, 'MXN'] }
    const { assertCommercialJsonValue } = loadBoundary()

    const result = assertCommercialJsonValue(source) as unknown as Record<string, unknown>

    expect(result).toEqual(source)
    expect(result).not.toBe(source)
    expect(Object.getPrototypeOf(result)).toBeNull()
    expect(Object.getPrototypeOf(result.nested as object)).toBeNull()
    expect(result.lines).not.toBe(source.lines)

    source.nested.amount = '1'
    expect((result.nested as Record<string, unknown>).amount).toBe('24900')
  })

  it.each([1n, undefined, Symbol('secret'), () => 'secret', Number.NaN, Infinity, -Infinity])(
    'rejects a non-I-JSON primitive without coercion: %#',
    value => {
      const { assertCommercialJsonValue } = loadBoundary()

      expect(() => assertCommercialJsonValue({ nested: [value] })).toThrow(/^COMMERCIAL_JSON_VALUE_INVALID$/)
    },
  )

  it('rejects sparse arrays, cycles, dates, buffers, classes and non-plain prototypes', () => {
    const { assertCommercialJsonValue } = loadBoundary()
    const sparse = Array(2)
    sparse[1] = 'value'
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    class SecretBox {
      value = 'secret'
    }

    for (const value of [sparse, cycle, new Date(0), Buffer.from('secret'), new SecretBox(), Object.create({ inherited: true })]) {
      expect(() => assertCommercialJsonValue(value)).toThrow(/^COMMERCIAL_JSON_VALUE_INVALID$/)
    }
  })

  it('rejects accessors and hidden or symbolic keys without invoking their values', () => {
    const { assertCommercialJsonValue } = loadBoundary()
    let reads = 0
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        reads += 1
        return 'leak'
      },
    })
    const hidden = Object.defineProperty({ visible: true }, 'secret', { enumerable: false, value: 'leak' })
    const symbolic = { visible: true, [Symbol('secret')]: 'leak' }

    for (const value of [accessor, hidden, symbolic]) {
      expect(() => assertCommercialJsonValue(value)).toThrow(/^COMMERCIAL_JSON_VALUE_INVALID$/)
    }
    expect(reads).toBe(0)
  })

  it('rejects proxies before invoking reflective traps', () => {
    const { assertCommercialJsonValue } = loadBoundary()
    let trapReads = 0
    const proxy = new Proxy(
      { safe: true },
      {
        ownKeys() {
          trapReads += 1
          return ['safe']
        },
      },
    )

    expect(() => assertCommercialJsonValue(proxy)).toThrow(/^COMMERCIAL_JSON_VALUE_INVALID$/)
    expect(trapReads).toBe(0)
  })
})
