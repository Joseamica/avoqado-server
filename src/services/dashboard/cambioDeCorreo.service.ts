/**
 * Cambiar el correo de una cuenta, demostrando que el correo NUEVO es de quien lo pide.
 *
 * 🔴 Por qué no se cambia al instante (Codex gpt-6-astra, 24-sep): el perfil reemplazaba el correo
 * conservando `emailVerified` y la contraseña. Un intruso ponía en SU cuenta el correo, aún libre,
 * de otra persona; cuando ésta entraba con Google, el login la encontraba por ese correo, la veía
 * verificada y conservaba la contraseña del intruso — los dos acababan en la misma cuenta.
 *
 * Flujo: pedir el cambio manda un enlace al correo NUEVO; el correo cambia sólo al abrirlo.
 *
 * 🔴 El enlace es un JWT firmado con una llave DERIVADA, nunca con la de las sesiones: con la misma
 * llave, `authenticateTokenMiddleware` lo aceptaría como sesión (trae `sub`). Sin tablas nuevas: el
 * enlace lleva quién, de qué correo a cuál y hasta cuándo, y confirmar revalida todo contra la base.
 */
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import prisma from '../../utils/prismaClient'
import emailService from '../email.service'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { logAction } from './activity-log.service'

const VIGENCIA = '1h'
const PROPOSITO = 'avoqado:cambio-de-correo'

interface EnlaceDeCambio {
  sub: string
  correoAnterior: string
  correoNuevo: string
  proposito: typeof PROPOSITO
}

function llaveDelEnlace(): string {
  const base = process.env.ACCESS_TOKEN_SECRET
  if (!base) throw new Error('ACCESS_TOKEN_SECRET no está configurada')
  return crypto.createHmac('sha256', base).update(PROPOSITO).digest('hex')
}

const normalizar = (correo: string) => correo.trim().toLowerCase()

async function correoOcupadoPorOtra(correo: string, staffId: string): Promise<boolean> {
  const duena = await prisma.staff.findUnique({ where: { email: correo }, select: { id: true } })
  return !!duena && duena.id !== staffId
}

/** Manda el enlace al correo nuevo. NO cambia nada todavía. */
export async function solicitarCambioDeCorreo(staffId: string, correoPedido: string): Promise<{ correoNuevo: string }> {
  const correoNuevo = normalizar(correoPedido)
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, email: true, firstName: true } })
  if (!staff) throw new NotFoundError('Usuario no encontrado.')
  if (correoNuevo === staff.email) return { correoNuevo }
  if (await correoOcupadoPorOtra(correoNuevo, staffId)) {
    throw new ConflictError('El correo electrónico ya está en uso por otro usuario.', 'EMAIL_IN_USE')
  }

  const payload: EnlaceDeCambio = { sub: staff.id, correoAnterior: staff.email, correoNuevo, proposito: PROPOSITO }
  const token = jwt.sign(payload, llaveDelEnlace(), { algorithm: 'HS256', expiresIn: VIGENCIA })
  const frontend = process.env.FRONTEND_URL || 'http://localhost:3000'
  const enlace = `${frontend}/auth/confirm-email-change?token=${encodeURIComponent(token)}`

  await emailService.sendEmail({
    to: correoNuevo,
    subject: 'Confirma tu nuevo correo en Avoqado',
    html: `<p>Hola${staff.firstName ? ` ${staff.firstName}` : ''}:</p>
<p>Pediste usar este correo en tu cuenta de Avoqado. Para confirmarlo, abre este enlace (vale 1 hora):</p>
<p><a href="${enlace}">Confirmar mi nuevo correo</a></p>
<p>Si no fuiste tú, ignora este mensaje: tu cuenta no cambia.</p>`,
  })
  logger.info('Cambio de correo pedido: enlace enviado al correo nuevo', { staffId })
  return { correoNuevo }
}

/** Abre el enlace: revalida todo contra la base y recién entonces cambia el correo. */
export async function confirmarCambioDeCorreo(token: string): Promise<{ correoNuevo: string }> {
  let enlace: EnlaceDeCambio
  try {
    enlace = jwt.verify(token, llaveDelEnlace(), { algorithms: ['HS256'] }) as EnlaceDeCambio
  } catch {
    throw new BadRequestError('El enlace no es válido o ya venció. Pide el cambio de correo otra vez.', 'EMAIL_CHANGE_LINK_INVALID')
  }
  if (enlace.proposito !== PROPOSITO) {
    throw new BadRequestError('El enlace no es válido o ya venció. Pide el cambio de correo otra vez.', 'EMAIL_CHANGE_LINK_INVALID')
  }

  const staff = await prisma.staff.findUnique({ where: { id: enlace.sub }, select: { id: true, email: true, active: true } })
  // Un enlace de ANTES de otro cambio ya no describe la cuenta: no se reusa.
  if (!staff || !staff.active || staff.email !== enlace.correoAnterior) {
    throw new BadRequestError('Este enlace ya no es válido. Pide el cambio de correo otra vez.', 'EMAIL_CHANGE_LINK_STALE')
  }
  if (await correoOcupadoPorOtra(enlace.correoNuevo, staff.id)) {
    throw new ConflictError('El correo electrónico ya está en uso por otro usuario.', 'EMAIL_IN_USE')
  }

  // CAS sobre el correo anterior: dos pestañas con el mismo enlace cambian una sola vez.
  const { count } = await prisma.staff.updateMany({
    where: { id: staff.id, email: enlace.correoAnterior },
    data: { email: enlace.correoNuevo, emailVerified: true },
  })
  if (count === 0) {
    throw new BadRequestError('Este enlace ya no es válido. Pide el cambio de correo otra vez.', 'EMAIL_CHANGE_LINK_STALE')
  }

  void logAction({
    staffId: staff.id,
    action: 'STAFF_EMAIL_CHANGED',
    entity: 'Staff',
    entityId: staff.id,
    data: { correoAnterior: enlace.correoAnterior, correoNuevo: enlace.correoNuevo, via: 'enlace-al-correo-nuevo' },
  })
  return { correoNuevo: enlace.correoNuevo }
}
