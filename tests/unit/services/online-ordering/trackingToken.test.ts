import { generateTrackingToken, TRACKING_TOKEN_PATTERN } from '@/services/online-ordering/trackingToken'

describe('generateTrackingToken', () => {
  it('es base64url de 32 caracteres y no se repite', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateTrackingToken()))
    expect(tokens.size).toBe(200)
    for (const t of tokens) expect(t).toMatch(TRACKING_TOKEN_PATTERN)
  })
})
