import { Prisma } from '@prisma/client'
import {
  canonicalJsonV1,
  hashCanonicalJsonV1,
  hashCatalogManagedFieldsV1,
} from '../../../../src/services/master-catalog/catalogHash.service'

// Hard-coded canonical strings and digests are derived outside production code,
// so a serializer or namespace mutation cannot make both sides pass together.
describe('catalogHash.service', () => {
  it('sorts object keys recursively, preserves array order, and NFC-normalizes strings', () => {
    expect(canonicalJsonV1({ z: 'e\u0301', a: [true, null, { b: 2, a: 'x' }] })).toBe('{"a":[true,null,{"a":"x","b":2}],"z":"é"}')
  })

  it('orders non-ASCII keys by ordinal code units rather than host ICU collation', () => {
    expect(canonicalJsonV1({ ä: 2, z: 1 })).toBe('{"z":1,"ä":2}')
  })

  it('orders integer-index keys ordinally at every object depth', () => {
    // WHY: JSON.stringify reorders integer-index own keys numerically, so this
    // vector pins the wire representation rather than only insertion order.
    expect(canonicalJsonV1({ '2': 'two', '10': { '2': 'nested-two', '10': 'nested-ten' } })).toBe(
      '{"10":{"10":"nested-ten","2":"nested-two"},"2":"two"}',
    )
  })

  it.each(['top-level', 'nested'])('rejects %s sparse arrays instead of aliasing holes to null', scope => {
    // WHY: A missing array slot is not a supported JSON value; materializing it
    // as null would make two different runtime payloads share one managed hash.
    const sparse: unknown[] = []
    sparse.length = 2
    sparse[1] = 1

    expect(() => canonicalJsonV1(scope === 'top-level' ? sparse : { nested: sparse })).toThrow('CATALOG_CANONICAL_JSON_INVALID')
    expect(canonicalJsonV1([null])).toBe('[null]')
  })

  it('preserves magic own JSON keys without prototype-setter collisions', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"constructor":2,"prototype":3,"a":2}')

    expect(canonicalJsonV1(value)).toBe('{"__proto__":{"x":1},"a":2,"constructor":2,"prototype":3}')
    expect(canonicalJsonV1(value)).not.toBe(canonicalJsonV1({ a: 2, constructor: 2, prototype: 3 }))
  })

  it('produces the frozen SHA-256 digest for namespace:v1 plus canonical JSON', () => {
    expect(hashCanonicalJsonV1('catalog-managed', { z: 'e\u0301', a: [true, null, { b: 2, a: 'x' }] })).toBe(
      'b02e40eb40aa95b278f6672ec52f12e79ffe2ab62e5fb8b38f806df74f971902',
    )
  })

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-safe-integer JSON numbers before their representation becomes ambiguous: %p',
    value => {
      expect(() => canonicalJsonV1({ value })).toThrow('CATALOG_CANONICAL_JSON_INVALID')
    },
  )

  it.each([undefined, BigInt(1), new Date('2026-08-08T00:00:00.000Z'), new Prisma.Decimal('1.20')])(
    'rejects unsupported runtime values so decimals and dates must arrive as typed strings: %p',
    value => {
      expect(() => canonicalJsonV1({ value })).toThrow('CATALOG_CANONICAL_JSON_INVALID')
    },
  )

  it('deduplicates and sorts the field mask while preserving fixed decimal scale', () => {
    expect(
      hashCatalogManagedFieldsV1({
        hashVersion: 1,
        fieldMask: ['type', 'price', 'active', 'price'],
        values: { active: true, price: '12.3', type: 'REGULAR', stock: 999 },
        decimalScales: { price: 2 },
      }),
    ).toEqual({
      hashVersion: 1,
      fieldMask: ['active', 'price', 'type'],
      hash: '94eb5f17e8308c5804609890fc7d84fa37d4c3ca626666bcb6b755546b51727b',
    })
  })

  it('ignores unrelated Product fields but changes when a managed field changes', () => {
    const base = {
      hashVersion: 1 as const,
      fieldMask: ['name', 'price'],
      decimalScales: { price: 2 },
    }
    const first = hashCatalogManagedFieldsV1({ ...base, values: { name: 'Café', price: '10.00', stock: 1 } })
    const unrelated = hashCatalogManagedFieldsV1({ ...base, values: { name: 'Café', price: '10.00', stock: 999 } })
    const managed = hashCatalogManagedFieldsV1({ ...base, values: { name: 'Café', price: '11.00', stock: 1 } })

    expect(unrelated).toEqual(first)
    expect(managed.hash).not.toBe(first.hash)
  })

  it('rejects missing managed values, an empty mask, precision loss, and unknown hash versions', () => {
    expect(() => hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: ['name'], values: {} })).toThrow('CATALOG_HASH_FIELD_MISSING')
    expect(() => hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: [], values: {} })).toThrow('CATALOG_HASH_FIELD_MASK_INVALID')
    expect(() =>
      hashCatalogManagedFieldsV1({
        hashVersion: 1,
        fieldMask: ['price'],
        values: { price: '1.234' },
        decimalScales: { price: 2 },
      }),
    ).toThrow('CATALOG_DECIMAL_INVALID')
    expect(() => hashCatalogManagedFieldsV1({ hashVersion: 2, fieldMask: ['name'], values: { name: 'x' } })).toThrow(
      'CATALOG_HASH_VERSION_UNSUPPORTED',
    )
  })

  it('rejects field-mask aliases that collide only after NFC normalization', () => {
    expect(() =>
      hashCatalogManagedFieldsV1({
        hashVersion: 1,
        fieldMask: ['é', 'e\u0301'],
        values: { é: 'first', 'e\u0301': 'second' },
      }),
    ).toThrow('CATALOG_HASH_FIELD_MASK_INVALID')
  })

  it('hashes __proto__ as an own managed field instead of changing the accumulator prototype', () => {
    const firstValues = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>
    const secondValues = JSON.parse('{"__proto__":{"x":2}}') as Record<string, unknown>

    const first = hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: ['__proto__'], values: firstValues })
    const second = hashCatalogManagedFieldsV1({ hashVersion: 1, fieldMask: ['__proto__'], values: secondValues })

    expect(first.fieldMask).toEqual(['__proto__'])
    expect(first.hash).not.toBe(second.hash)
  })

  it.each(['__proto__', 'constructor', 'toString'])('ignores inherited decimal scale for magic field %s', field => {
    // WHY: A plain scale map inherits Object.prototype names; only explicit
    // scale declarations may reinterpret managed values as decimals.
    expect(() =>
      hashCatalogManagedFieldsV1({
        hashVersion: 1,
        fieldMask: [field],
        values: Object.defineProperty({}, field, { value: 'display', enumerable: true }),
        decimalScales: {},
      }),
    ).not.toThrow()
  })
})
