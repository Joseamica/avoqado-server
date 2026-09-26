/**
 * 🔴 Revisión independiente (26-sep), P2: el `iat` del token del dashboard va en SEGUNDOS (redondeado hacia abajo). Tras
 * cambiar la contraseña, el dashboard emite una sesión nueva EN EL MISMO SEGUNDO del cambio: su `iat*1000` queda ≤ al
 * corte y la conexión de un clic del MCP (que hereda la hora de esa sesión) se rechazaba como «sesión cortada».
 * El token lleva ahora `emitidoMs`, que `emisionDelToken` prefiere al `iat`.
 */
import jwt from 'jsonwebtoken'
import { generateAccessToken } from '@/jwt.service'
import { emisionDelToken } from '@/utils/passwordChangeGuard'
import { StaffRole } from '@prisma/client'

describe('el token del dashboard lleva su hora de emisión en milisegundos', () => {
  it('🔴 `emitidoMs` con la hora real (no redondeada al segundo)', () => {
    const antes = Date.now()
    const token = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.OWNER)
    const despues = Date.now()
    const p = jwt.decode(token) as { emitidoMs?: number; iat?: number }
    expect(typeof p.emitidoMs).toBe('number')
    expect(p.emitidoMs!).toBeGreaterThanOrEqual(antes)
    expect(p.emitidoMs!).toBeLessThanOrEqual(despues)
  })

  it('`emisionDelToken` usa esa hora exacta, no el segundo redondeado', () => {
    const token = generateAccessToken('staff1', 'org1', 'venue1', StaffRole.OWNER)
    const p = jwt.decode(token) as { emitidoMs: number; iat: number }
    expect(emisionDelToken(p)).toEqual(new Date(p.emitidoMs))
  })
})
