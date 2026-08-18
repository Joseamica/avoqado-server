import crypto from 'crypto'
import { verifyUberSignature } from '@/services/delivery-channels/providers/uber-eats/uber.signature'

// [supuesto declarado en la spec]: header X-Uber-Signature = HMAC-SHA256 hex
// minúsculas del body crudo. La LLAVE está en disputa (dashboard: Signing Key;
// doc: client secret) ⇒ el módulo recibe la llave por parámetro y NO decide.
describe('uber.signature', () => {
  const KEY = 'k-de-prueba'
  const body = Buffer.from(JSON.stringify({ event_id: 'e1' }))
  const firma = (b: Buffer, k: string) => crypto.createHmac('sha256', k).update(b).digest('hex')

  it('acepta la firma correcta (hex minúsculas)', () => {
    expect(verifyUberSignature(body, firma(body, KEY), KEY)).toBe(true)
  })

  it('rechaza firma de otra llave, header ausente, vacío o longitud inválida', () => {
    expect(verifyUberSignature(body, firma(body, 'otra'), KEY)).toBe(false)
    expect(verifyUberSignature(body, undefined, KEY)).toBe(false)
    expect(verifyUberSignature(body, '', KEY)).toBe(false)
    expect(verifyUberSignature(body, 'abc123', KEY)).toBe(false) // ≠ 64 hex
    expect(verifyUberSignature(body, 'z'.repeat(64), KEY)).toBe(false) // 64 chars pero no-hex
    expect(verifyUberSignature(body, firma(body, KEY), '')).toBe(false) // llave vacía
    expect(verifyUberSignature('no-buffer' as unknown as Buffer, firma(body, KEY), KEY)).toBe(false)
  })

  it('acepta hex en MAYÚSCULAS normalizando (no falla por casing)', () => {
    expect(verifyUberSignature(body, firma(body, KEY).toUpperCase(), KEY)).toBe(true)
  })

  it('un byte distinto en el body ⇒ rechaza', () => {
    const otro = Buffer.from(JSON.stringify({ event_id: 'e2' }))
    expect(verifyUberSignature(otro, firma(body, KEY), KEY)).toBe(false)
  })
})
