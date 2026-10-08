// src/services/dashboard/staffPay/recibos.persona.ts — el nombre visible de la persona de un recibo (fase 3, B5 r1; sacado de
// `recibos.service.ts` en B11 para que ése no crezca).
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { NotFoundError } from '../../../errors/AppError'
import { nombreGuardadoSql, PERSONA_DADA_DE_BAJA } from './fuentesVenta'

const nombreDe = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`.trim()

/**
 * Nombre visible de la persona del recibo, sólo si trabaja o trabajó en esta organización (nunca el de alguien de otro
 * negocio). Mismo permiso de sedes que siempre: eso lo decide `alcanceEnLaFoto`.
 * «Trabajó» sin sede viva (la expulsión dura borra su StaffVenue; le sobreviven comisiones, propinas, clases y recibos)
 * lo acredita, sólo con búsquedas por persona que tienen índice (B5 r1):
 *   - un devengo suyo en la organización (Codex bloque A #4) — `ServiceEarning (organizationId, staffId)`;
 *   - su membresía de la organización, activa o no — `StaffOrganization (staffId, organizationId)` único; la expulsión no
 *     la borra, y es lo que cubre a quien sólo tiene propinas en vivo (`Order.servedById` y `Payment.processedById` no
 *     tienen índice: no se recorren los cobros del negocio);
 *   - una clase suya en una sede de la organización — `ClassSession (assignedStaffId, …)`.
 *   (`CommissionCalculation` no se consulta: sin membresía guardada, sus comisiones en vivo se ven en su recibo en
 *   cuanto el cierre las congela como devengo.)
 * Si la borraron físicamente, el nombre que guardó (`nombreGuardadoSql`, la misma regla que el reporte) y, si no hay
 * ninguno, «Persona dada de baja» con sus montos intactos (spec fase 3 §6.1, Codex r1-17, r2-17).
 */
export async function personaDelRecibo(organizationId: string, staffId: string): Promise<string> {
  const select = { firstName: true, lastName: true } as const
  const viva = await prisma.staff.findFirst({ where: { id: staffId, venues: { some: { venue: { organizationId } } } }, select })
  if (viva) return nombreDe(viva)
  const [devengo, membresia, clase] = await Promise.all([
    prisma.serviceEarning.findFirst({ where: { organizationId, staffId }, select: { id: true } }),
    prisma.staffOrganization.findUnique({ where: { staffId_organizationId: { staffId, organizationId } }, select: { id: true } }),
    prisma.classSession.findFirst({ where: { assignedStaffId: staffId, venue: { organizationId } }, select: { id: true } }),
  ])
  if (!devengo && !membresia && !clase) throw new NotFoundError('Persona no encontrada')
  const fila = await prisma.staff.findUnique({ where: { id: staffId }, select })
  if (fila) return nombreDe(fila)
  const [guardado] = await prisma.$queryRaw<Array<{ persona: string | null }>>`
    SELECT ${nombreGuardadoSql(organizationId, Prisma.sql`${staffId}`)} AS persona`
  return guardado?.persona ?? PERSONA_DADA_DE_BAJA
}
