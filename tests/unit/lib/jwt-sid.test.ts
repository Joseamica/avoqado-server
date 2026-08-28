import { generateAccessToken, verifyAccessToken, generateRefreshToken, verifyRefreshToken } from '@/jwt.service'
import { StaffRole } from '@prisma/client'

describe('sid en los tokens', () => {
  it('el access token lleva sid y v cuando se le pasan', () => {
    // opts es el parámetro FINAL (6º) de generateAccessToken — va después de
    // `rememberMe` para no romper a los ~15 llamadores existentes que pasan
    // un boolean en esa posición. Ver task-2-report.md para el detalle.
    const t = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.CASHIER, undefined, { sid: 'sess1' })
    const p = verifyAccessToken(t)
    expect(p.sid).toBe('sess1')
    expect(p.v).toBe(1)
  })

  it('un token SIN sid sigue siendo válido (legacy)', () => {
    const t = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.CASHIER)
    const p = verifyAccessToken(t)
    expect(p.sub).toBe('staff1')
    expect(p.sid).toBeUndefined()
    expect(p.v).toBeUndefined()
  })

  it('el refresh token también lleva sid', () => {
    const t = generateRefreshToken('staff1', 'org1', false, 'venue1', { sid: 'sess1' })
    expect(verifyRefreshToken(t).sid).toBe('sess1')
  })
})
