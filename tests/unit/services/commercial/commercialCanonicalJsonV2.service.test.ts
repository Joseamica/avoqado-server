import { COMMERCIAL_CONTRACT_HASH } from '@/contracts/commercial/contractHash'
import {
  COMMERCIAL_JSON_TEXT_V2_MAX_BYTES,
  COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH,
  COMMERCIAL_V2_DOMAINS,
} from '@/contracts/commercial/commercialContractV2.constants'
import adversarialVectors from '@/contracts/commercial/vectors/v2/rfc8785-adversarial.json'
import officialVectors from '@/contracts/commercial/vectors/v2/rfc8785-official.json'
import {
  canonicalJsonBytesV2,
  canonicalJsonV2,
  hashCanonicalJsonV2,
  parseJsonTextV2Strict,
} from '@/services/commercial/commercialCanonicalJsonV2.service'

describe('commercialCanonicalJsonV2', () => {
  describe('new RFC 8785 behavior', () => {
    it('matches the official RFC 8785 primitive serialization vector', () => {
      expect(canonicalJsonV2(officialVectors.serialization.input)).toBe(officialVectors.serialization.canonical)
    })

    it('matches the official RFC 8785 raw UTF-16 property-order vector', () => {
      expect(canonicalJsonV2(officialVectors.propertyOrder.input)).toBe(officialVectors.propertyOrder.canonical)
    })

    it.each(adversarialVectors.valid)('canonicalizes adversarial vector $id', vector => {
      expect(canonicalJsonV2(vector.input)).toBe(vector.canonical)
    })

    it('does not normalize composed and decomposed Unicode', () => {
      expect(canonicalJsonV2('\u00e9')).toBe('"\u00e9"')
      expect(canonicalJsonV2('e\u0301')).toBe('"e\u0301"')
      expect(canonicalJsonBytesV2('\u00e9').equals(canonicalJsonBytesV2('e\u0301'))).toBe(false)
    })

    it('uses ECMAScript number serialization including negative zero', () => {
      expect(canonicalJsonV2([-0, Number('333333333.33333329'), 1e30, 0.000001, 1e-7])).toBe('[0,333333333.3333333,1e+30,0.000001,1e-7]')
    })

    it('accepts null-prototype objects and emits magic keys as data', () => {
      const value = Object.create(null) as Record<string, unknown>
      value['constructor'] = 2
      value['__proto__'] = 1

      expect(canonicalJsonV2(value)).toBe('{"__proto__":1,"constructor":2}')
    })

    it.each([NaN, Infinity, -Infinity, 1n, undefined, Symbol('x'), () => 1])('rejects a non-I-JSON primitive %#', value => {
      expect(() => canonicalJsonV2(value)).toThrow('COMMERCIAL_JCS_V2_INVALID')
    })

    it.each([new Date(0), new Map(), new Set(), new (class ContractValue {})(), { toJSON: () => ({ ok: true }) }])(
      'rejects a non-materialized JSON object %#',
      value => {
        expect(() => canonicalJsonV2(value)).toThrow('COMMERCIAL_JCS_V2_INVALID')
      },
    )

    it('rejects lone surrogates in both values and property names', () => {
      expect(() => canonicalJsonV2('\ud800')).toThrow('COMMERCIAL_JCS_V2_INVALID')
      expect(() => canonicalJsonV2({ ['\udfff']: true })).toThrow('COMMERCIAL_JCS_V2_INVALID')
    })

    it('rejects sparse arrays, cycles, extra array properties, and symbol properties', () => {
      const sparse = new Array(3) as unknown[]
      sparse[0] = 1
      sparse[2] = 3
      const cyclic: unknown[] = []
      cyclic.push(cyclic)
      const withExtra = [1] as unknown[] & { metadata?: string }
      withExtra.metadata = 'not JSON array data'
      const withSymbol = { ok: true, [Symbol('secret')]: false }

      for (const value of [sparse, cyclic, withExtra, withSymbol]) {
        expect(() => canonicalJsonV2(value)).toThrow('COMMERCIAL_JCS_V2_INVALID')
      }
    })

    it('normalizes hostile Proxy trap failures across every exported canonicalization boundary', () => {
      const prototypeLeak = new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('GET_PROTOTYPE_OF_CALLER_INPUT_LEAK')
          },
        },
      )
      const ownKeysLeak = new Proxy([], {
        ownKeys: () => {
          throw new Error('OWN_KEYS_CALLER_INPUT_LEAK')
        },
      })
      const descriptorLeak = new Proxy(
        { secret: true },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('DESCRIPTOR_CALLER_INPUT_LEAK')
          },
        },
      )

      expect(() => canonicalJsonV2(prototypeLeak)).toThrow(/^COMMERCIAL_JCS_V2_INVALID$/)
      expect(() => canonicalJsonBytesV2(ownKeysLeak)).toThrow(/^COMMERCIAL_JCS_V2_INVALID$/)
      expect(() => hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, descriptorLeak)).toThrow(/^COMMERCIAL_JCS_V2_INVALID$/)
    })

    it('rejects every successful Proxy disguise before invoking reflection traps', () => {
      const plainObjectProxy = new Proxy({ amount: 1 }, {})
      const arrayProxy = new Proxy([1, 2], {})
      const maskedDate = new Proxy(new Date(0), {
        getPrototypeOf: () => Object.prototype,
        ownKeys: () => [],
      })

      for (const value of [plainObjectProxy, arrayProxy, maskedDate]) {
        expect(() => canonicalJsonV2(value)).toThrow(/^COMMERCIAL_JCS_V2_INVALID$/)
      }
    })

    it('rejects a stateful descriptor Proxy without reading caller-controlled descriptors', () => {
      let descriptorReads = 0
      const movingValue = new Proxy(
        {},
        {
          getPrototypeOf: () => Object.prototype,
          ownKeys: () => ['amount'],
          getOwnPropertyDescriptor: () => ({
            configurable: true,
            enumerable: true,
            writable: true,
            value: ++descriptorReads,
          }),
        },
      )

      expect(() => canonicalJsonV2(movingValue)).toThrow(/^COMMERCIAL_JCS_V2_INVALID$/)
      expect(descriptorReads).toBe(0)
    })

    it('keeps the textual parser stable error distinct from canonicalization failures', () => {
      expect(() => parseJsonTextV2Strict('{"callerInput":1,"callerInput":2}')).toThrow(/^COMMERCIAL_JSON_TEXT_V2_INVALID$/)
    })

    it('strictly parses complete JSON while preserving valid magic keys', () => {
      const parsed = parseJsonTextV2Strict('{"__proto__":1,"constructor":{"prototype":2}}') as Record<string, unknown>

      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true)
      expect(canonicalJsonV2(parsed)).toBe('{"__proto__":1,"constructor":{"prototype":2}}')
    })

    it.each(['{"a":1,"a":2}', '{"outer":{"a":1,"a":2}}', '{"a":1,"\\u0061":2}', '{"a":1} trailing', '{"a":1,}', '[1,]', '"\\x20"', '01'])(
      'rejects duplicate or malformed JSON text without leaking it: %s',
      text => {
        expect(() => parseJsonTextV2Strict(text)).toThrow('COMMERCIAL_JSON_TEXT_V2_INVALID')
      },
    )

    it('enforces explicit parser depth and UTF-8 byte limits', () => {
      const tooDeep = `${'['.repeat(COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH + 1)}0${']'.repeat(COMMERCIAL_JSON_TEXT_V2_MAX_DEPTH + 1)}`
      const tooLarge = `"${'x'.repeat(COMMERCIAL_JSON_TEXT_V2_MAX_BYTES)}"`

      expect(() => parseJsonTextV2Strict(tooDeep)).toThrow('COMMERCIAL_JSON_TEXT_V2_INVALID')
      expect(() => parseJsonTextV2Strict(tooLarge)).toThrow('COMMERCIAL_JSON_TEXT_V2_INVALID')
    })

    it('hashes the real NUL-framed ASCII domain and canonical UTF-8 bytes', () => {
      const domain = COMMERCIAL_V2_DOMAINS.QUOTE
      const domainBytes = Buffer.from(domain, 'ascii')

      expect(domainBytes[domainBytes.length - 1]).toBe(0)
      expect(hashCanonicalJsonV2(domain, { z: 1, a: 2 })).toBe('b0a3d5ebd883959d3cdf9929a27e22928e451e8a058171880fd447329a97b978')
      expect(canonicalJsonBytesV2({ z: 1, a: 2 }).toString('hex')).toBe('7b2261223a322c227a223a317d')
    })

    it('separates equal canonical bytes across v2 domains', () => {
      expect(hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE, { a: 1 })).not.toBe(
        hashCanonicalJsonV2(COMMERCIAL_V2_DOMAINS.QUOTE_SELECTION, { a: 1 }),
      )
    })
  })

  describe('regression guardrails', () => {
    it('keeps the v1 commercial contract bundle byte-identical', () => {
      expect(COMMERCIAL_CONTRACT_HASH).toBe('aaee77e19f7cf51bcd9087c6e4f043bef759fa53857b80f3ee2d84a20317eb12')
    })

    it('preserves array order while recursively sorting object properties', () => {
      expect(
        canonicalJsonV2([
          { z: 1, a: 2 },
          { b: 3, a: 4 },
        ]),
      ).toBe('[{"a":2,"z":1},{"a":4,"b":3}]')
    })
  })
})
