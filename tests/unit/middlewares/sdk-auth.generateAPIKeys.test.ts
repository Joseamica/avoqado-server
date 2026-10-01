/**
 * 🔴 Auditoría 2026-09-30: la secreta salía del MISMO aleatorio que la pública. Con la pública (que va en
 * el navegador del comercio) se reconstruía la secreta cambiando `pk_` por `sk_`.
 */
import crypto from 'crypto'
import { generateAPIKeys } from '@/middlewares/sdk-auth.middleware'

describe('generateAPIKeys', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [false, 'live'],
    [true, 'test'],
  ])('cada llave sale de su propia extracción de aleatorios (sandbox=%s)', (sandboxMode, mode) => {
    // Que sean «distintas» no basta: una secreta = hash(pública) también sería distinta y seguiría
    // derivándose. Se exige que cada una venga de SU extracción.
    const spy = jest
      .spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.alloc(32, 0xaa) as any)
      .mockReturnValueOnce(Buffer.alloc(32, 0xbb) as any)

    const { publicKey, secretKey } = generateAPIKeys(sandboxMode)

    expect(spy).toHaveBeenCalledTimes(2)
    expect(publicKey).toBe(`pk_${mode}_${'aa'.repeat(32)}`)
    expect(secretKey).toBe(`sk_${mode}_${'bb'.repeat(32)}`)
  })

  it('conserva el formato que usan los comercios', () => {
    const live = generateAPIKeys(false)
    expect(live.publicKey).toMatch(/^pk_live_[0-9a-f]{64}$/)
    expect(live.secretKey).toMatch(/^sk_live_[0-9a-f]{64}$/)
    const test = generateAPIKeys(true)
    expect(test.publicKey).toMatch(/^pk_test_[0-9a-f]{64}$/)
    expect(test.secretKey).toMatch(/^sk_test_[0-9a-f]{64}$/)
  })
})
