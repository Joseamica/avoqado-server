import { parseWritableStoreIds, assertStoreWritable, UberStoreWriteBlockedError } from '@/services/delivery-channels/providers/uber-eats/uber.storeAllowlist'

// Candado §5.0/paso 1 de la spec: el sandbox de Uber escribe en tiendas REALES
// (verificado 2026-08-17, Doña Simona). Default-deny: sin lista, cero escrituras.
describe('uber.storeAllowlist', () => {
  const REAL = '78cf8848-5cea-48f5-9f44-5bf42d303153'
  const TEST_STORE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000'

  describe('parseWritableStoreIds', () => {
    it('env vacío o ausente ⇒ conjunto vacío (default-deny)', () => {
      expect(parseWritableStoreIds(undefined).size).toBe(0)
      expect(parseWritableStoreIds('').size).toBe(0)
      expect(parseWritableStoreIds('  ').size).toBe(0)
    })
    it('parsea CSV con espacios y normaliza a minúsculas', () => {
      const s = parseWritableStoreIds(` ${TEST_STORE.toUpperCase()} , otra-tienda `)
      expect(s.has(TEST_STORE)).toBe(true)
      expect(s.has('otra-tienda')).toBe(true)
      expect(s.size).toBe(2)
    })
  })

  describe('assertStoreWritable', () => {
    it('tienda en la lista ⇒ pasa (case-insensitive)', () => {
      const allow = parseWritableStoreIds(TEST_STORE)
      expect(() => assertStoreWritable(TEST_STORE.toUpperCase(), allow, 'SANDBOX')).not.toThrow()
    })
    it('lista vacía ⇒ bloquea SIEMPRE (el estado de arranque es seguro)', () => {
      expect(() => assertStoreWritable(REAL, parseWritableStoreIds(undefined), 'SANDBOX')).toThrow(UberStoreWriteBlockedError)
    })
    it('tienda fuera de la lista ⇒ bloquea y el mensaje nombra la env var y la tienda', () => {
      const allow = parseWritableStoreIds(TEST_STORE)
      try {
        assertStoreWritable(REAL, allow, 'SANDBOX')
        fail('debió bloquear')
      } catch (e) {
        const err = e as UberStoreWriteBlockedError
        expect(err).toBeInstanceOf(UberStoreWriteBlockedError)
        expect(err.message).toContain(REAL)
        expect(err.message).toContain('UBER_WRITABLE_STORE_IDS_SANDBOX')
      }
    })
    it('storeId vacío o no-string ⇒ bloquea (nunca adivinar)', () => {
      const allow = parseWritableStoreIds(TEST_STORE)
      expect(() => assertStoreWritable('', allow, 'PRODUCTION')).toThrow(UberStoreWriteBlockedError)
      expect(() => assertStoreWritable(undefined as unknown as string, allow, 'PRODUCTION')).toThrow(UberStoreWriteBlockedError)
    })
  })
})
