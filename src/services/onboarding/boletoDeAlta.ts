/**
 * Boleto de alta: la credencial de 5 minutos que el SERVIDOR entrega a la landing cuando alguien
 * verifica su código y crea su contraseña, y que el DASHBOARD canjea por una sesión (`#boleto=` en la URL).
 *
 * 🔴 Se firma con una llave DERIVADA (igual que el enlace de cambio de correo), nunca con la de las
 * sesiones: con la misma llave, `authenticateTokenMiddleware` lo aceptaría como sesión. Es una credencial:
 * no se escribe en logs.
 */
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { AuthenticationError } from '@/errors/AppError'

const PROPOSITO = 'avoqado:boleto-de-alta'
const VIGENCIA = '5m'

interface Boleto {
  sub: string
  email: string
  emitidoMs: number
  proposito: typeof PROPOSITO
}

function llaveDelBoleto(): string {
  const base = process.env.ACCESS_TOKEN_SECRET
  if (!base) throw new Error('ACCESS_TOKEN_SECRET no está configurada')
  return crypto.createHmac('sha256', base).update(PROPOSITO).digest('hex')
}

export function firmarBoletoDeAlta(staffId: string, email: string): string {
  const payload: Boleto = { sub: staffId, email, emitidoMs: Date.now(), proposito: PROPOSITO }
  return jwt.sign(payload, llaveDelBoleto(), { algorithm: 'HS256', expiresIn: VIGENCIA })
}

/** Lanza `AuthenticationError` si está vencido, alterado o es de otro propósito. */
export function leerBoletoDeAlta(boleto: string): { staffId: string; email: string; emitidoMs: number } {
  let b: Boleto
  try {
    b = jwt.verify(boleto, llaveDelBoleto(), { algorithms: ['HS256'] }) as Boleto
  } catch {
    throw new AuthenticationError('El boleto no es válido o ya venció.')
  }
  if (b.proposito !== PROPOSITO || !b.sub || !b.email) throw new AuthenticationError('El boleto no es válido o ya venció.')
  return { staffId: b.sub, email: b.email, emitidoMs: b.emitidoMs }
}
