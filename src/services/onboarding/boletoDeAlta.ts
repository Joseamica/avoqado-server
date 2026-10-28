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
  /**
   * D10 (28-oct, Codex r3): la hora EXACTA del cambio de contraseña que autorizó este boleto («Crear contraseña y entrar»
   * desde el correo). El canje exige que la cuenta siga con ESE cambio: un cambio o una revocación que se guarden después
   * de firmar —aunque su hora sea anterior a la firma— lo invalidan. El boleto del alta con código no la lleva.
   */
  cambioMs?: number
  /** Huella (sha256) del hash de la contraseña que dejó ese cambio. Nunca la contraseña ni su hash (Codex r4). */
  huella?: string
  proposito: typeof PROPOSITO
}

function llaveDelBoleto(): string {
  const base = process.env.ACCESS_TOKEN_SECRET
  if (!base) throw new Error('ACCESS_TOKEN_SECRET no está configurada')
  return crypto.createHmac('sha256', base).update(PROPOSITO).digest('hex')
}

/** D10: qué cambio de contraseña autorizó el boleto. Con él, el canje exige la cuenta EXACTAMENTE en ese estado. */
export interface AutorizacionDelBoleto {
  cambioMs: number
  huella: string
}

/** sha256 del hash bcrypt: distingue una contraseña de otra sin poner en el boleto nada que sirva para entrar. */
export function huellaDeContrasena(hash: string): string {
  return crypto.createHash('sha256').update(hash).digest('hex')
}

export function firmarBoletoDeAlta(staffId: string, email: string, autorizacion?: AutorizacionDelBoleto): string {
  const payload: Boleto = {
    sub: staffId,
    email,
    emitidoMs: Date.now(),
    ...(autorizacion ? { cambioMs: autorizacion.cambioMs, huella: autorizacion.huella } : {}),
    proposito: PROPOSITO,
  }
  return jwt.sign(payload, llaveDelBoleto(), { algorithm: 'HS256', expiresIn: VIGENCIA })
}

/** Lanza `AuthenticationError` si está vencido, alterado o es de otro propósito. */
export function leerBoletoDeAlta(boleto: string): {
  staffId: string
  email: string
  emitidoMs: number
  autorizacion?: AutorizacionDelBoleto
} {
  let b: Boleto
  try {
    b = jwt.verify(boleto, llaveDelBoleto(), { algorithms: ['HS256'] }) as Boleto
  } catch {
    throw new AuthenticationError('El boleto no es válido o ya venció.')
  }
  if (b.proposito !== PROPOSITO || !b.sub || !b.email) throw new AuthenticationError('El boleto no es válido o ya venció.')
  const autorizacion =
    typeof b.cambioMs === 'number' && typeof b.huella === 'string' ? { cambioMs: b.cambioMs, huella: b.huella } : undefined
  return { staffId: b.sub, email: b.email, emitidoMs: b.emitidoMs, ...(autorizacion ? { autorizacion } : {}) }
}
