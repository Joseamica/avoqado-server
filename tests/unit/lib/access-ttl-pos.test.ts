import { generateAccessToken, verifyAccessToken } from '@/jwt.service'
import { StaffRole } from '@prisma/client'

const dur = (t: string) => {
  const p = verifyAccessToken(t)
  return p.exp! - p.iat!
}

describe('vida del access token', () => {
  it('una sesion POS dura 10 minutos', () => {
    const t = generateAccessToken('st1', 'org1', 'v1', StaffRole.CASHIER, undefined, { sid: 's1', pos: true })
    expect(dur(t)).toBe(600)
  })

  it('🔴 el dashboard NO cambia de duracion (sin pos)', () => {
    const t = generateAccessToken('st1', 'org1', 'v1', StaffRole.ADMIN, undefined, { sid: 's1' })
    expect(dur(t)).toBeGreaterThan(600)
  })

  it('🔴 un token LEGACY (sin opts) NO cambia de duracion', () => {
    const t = generateAccessToken('st1', 'org1', 'v1', StaffRole.ADMIN)
    expect(dur(t)).toBeGreaterThan(600)
  })

  it('`pos` no altera el resto del payload', () => {
    const p = verifyAccessToken(generateAccessToken('st1', 'org1', 'v1', StaffRole.CASHIER, undefined, { sid: 's1', pos: true }))
    expect(p.sub).toBe('st1')
    expect(p.venueId).toBe('v1')
    expect(p.sid).toBe('s1')
    expect(p.v).toBe(1)
  })

  it('`rememberMe` sigue funcionando cuando NO es POS', () => {
    const conMemoria = generateAccessToken('st1', 'org1', 'v1', StaffRole.ADMIN, true, { sid: 's1' })
    const sinMemoria = generateAccessToken('st1', 'org1', 'v1', StaffRole.ADMIN, false, { sid: 's1' })
    expect(dur(conMemoria)).toBeGreaterThan(dur(sinMemoria))
  })

  it('🔴 POS gana sobre rememberMe: no se puede pedir un token POS de 30 dias', () => {
    const t = generateAccessToken('st1', 'org1', 'v1', StaffRole.CASHIER, true, { sid: 's1', pos: true })
    expect(dur(t)).toBe(600)
  })
})
