import { heartbeatSchema } from '../../../src/schemas/tpv.schema'

describe('heartbeat con telemetría de autorización', () => {
  const base = {
    body: { terminalId: 'AVQD-2841548417', timestamp: new Date().toISOString(), status: 'ACTIVE' },
  }

  it('acepta el lote de intentos y lo conserva', () => {
    const r = heartbeatSchema.safeParse({
      ...base,
      body: { ...base.body, authAttempts: [{ code: 'N400', durationMs: 12400, rail: 'BLUMON' }] },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body.authAttempts?.[0].code).toBe('N400')
  })

  it('un cliente viejo sin el campo sigue pasando', () => {
    // Nunca romper APKs instaladas: el campo es opcional.
    expect(heartbeatSchema.safeParse(base).success).toBe(true)
  })

  it('rechaza un lote absurdamente grande', () => {
    const many = Array.from({ length: 5000 }, () => ({ code: 'N400', durationMs: 1000, rail: 'BLUMON' }))
    const r = heartbeatSchema.safeParse({ ...base, body: { ...base.body, authAttempts: many } })
    expect(r.success).toBe(false)
  })
})
