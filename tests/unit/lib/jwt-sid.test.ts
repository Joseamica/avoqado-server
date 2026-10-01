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

/**
 * IVA por producto (spec planes 6-7, §5.5): el token del POS móvil lleva una marca FIRMADA `origen: 'POS'`. Sin ella, nada
 * distingue un token del POS de uno del dashboard, y el plan 6b no puede saber si un negocio usa una app vieja.
 */
describe('origen en los tokens', () => {
  it('el POS (pos: true) lleva origen POS', () => {
    const t = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.CASHIER, undefined, { sid: 'sess1', pos: true })
    expect(verifyAccessToken(t).origen).toBe('POS')
  })

  it('el dashboard (sin pos) no lleva origen', () => {
    const t = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.ADMIN, true, { sid: 'sess1' })
    expect(verifyAccessToken(t).origen).toBeUndefined()
  })

  it('un token legacy sin opts no lleva origen', () => {
    expect(verifyAccessToken(generateAccessToken('staff1', 'org1', 'venue1', StaffRole.CASHIER)).origen).toBeUndefined()
  })
})
