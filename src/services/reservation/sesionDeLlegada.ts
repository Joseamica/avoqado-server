/**
 * Asistencia verificada (16-nov-2026): qué prueba la sesión de la alumna al registrar su llegada con su celular.
 *
 * La comparten los DOS caminos del QR (el firmado por el kiosco y el reto de la fase 5): Codex r2 #1 encontró que el reto
 * viejo seguía aceptando una sesión sin contacto probado.
 */
import { ReservationCheckInMethod } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { UnauthorizedError } from '@/errors/AppError'
import { utcTs } from '@/utils/sqlDates'
import type { ContactoProbado } from '@/jwt.service'

/** Si una persona del personal cambió el contacto con el que la alumna entró en estos días, la llegada es «a mano por» ella. */
export const CONTACTO_CAMBIADO_DIAS = 30
export const CHECK_IN_NEEDS_CODE = 'CHECK_IN_NEEDS_CODE' as const

export interface SesionDeLlegada {
  tipo: string
  contactos: ContactoProbado[]
}

/**
 * 🔴 Codex r1 #1: una contraseña vieja (el alta con contraseña dejaba ponérsela a la ficha de otra) o el token de «tus
 * reservas de hoy» prueban la ficha, no el celular. Sólo cuenta una sesión que probó un contacto con código o Google.
 */
export function exigirSesionProbada(sesion: SesionDeLlegada | null | undefined): void {
  if (!sesion || sesion.tipo !== 'SESION' || sesion.contactos.length === 0) {
    throw new UnauthorizedError('Entra con el código que te mandamos para registrar tu llegada.', CHECK_IN_NEEDS_CODE)
  }
}

/**
 * 🔴 Codex r1 #1 y r2 #2: quien puede editar clientes podría poner SU correo o teléfono en la ficha de la alumna, recibir ahí
 * el código y entrar como ella. La llegada no se niega (la alumna real también pudo pedir que le corrigieran el número),
 * pero no se presenta como «con celular»: queda «a mano por» quien cambió el contacto.
 *
 * El filtro por campo va EN la consulta, antes del tope: con un tope sobre los últimos N cambios, veinte ediciones de notas
 * escondían el cambio de teléfono (r2 #2). Un renglón viejo sin lista de campos cuenta como posible cambio de contacto.
 */
export async function metodoDeLaSesion(args: {
  venueId: string
  customerId: string
  sesion: SesionDeLlegada
  now: Date
}): Promise<{ method: ReservationCheckInMethod; byStaffId?: string }> {
  const campos = [...new Set(args.sesion.contactos.map(c => (c.tipo === 'PHONE' ? 'phone' : 'email')))]
  const desde = new Date(args.now.getTime() - CONTACTO_CAMBIADO_DIAS * 24 * 60 * 60_000)
  const filas = await prisma.$queryRaw<Array<{ staffId: string }>>`
    SELECT a."staffId"
    FROM "ActivityLog" a
    WHERE a."entity" = 'Customer' AND a."entityId" = ${args.customerId} AND a."venueId" = ${args.venueId}
      AND a."action" = 'CUSTOMER_UPDATED' AND a."staffId" IS NOT NULL
      AND a."createdAt" >= ${utcTs(desde)}
      AND (a."data" IS NULL OR NOT (a."data" ? 'fields') OR jsonb_typeof(a."data"->'fields') <> 'array'
           OR a."data"->'fields' ?| ${campos}::text[])
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT 1`
  return filas[0] ? { method: 'STAFF', byStaffId: filas[0].staffId } : { method: 'QR' }
}
