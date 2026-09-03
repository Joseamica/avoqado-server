import { BirthdayAutomationStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { BadRequestError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import { bloquesCampanaSchema, type BloqueCampana } from './campaignBlocks'
import { renderizarBloques, dominiosDeLosBloques } from './campaignRenderer'

/**
 * Configuración de la felicitación automática de cumpleaños.
 *
 * 🔴 Existe para que el switch NO sea un `UPDATE` en Postgres. La regla del workspace es
 * explícita: un feature cuyo único interruptor es un cambio a mano en la base está
 * incompleto — deja al founder de switch humano para cada cliente que lo pida.
 */

/** Tope de antelación. Un año es absurdo, pero es lo que evita un catch-up desbocado. */
export const MAX_DAYS_BEFORE = 30

export interface GuardarAutomatizacionParams {
  venueId: string
  subject: string
  bloques: unknown
  daysBefore: number
  /** `true` la enciende; `false` la pausa. */
  activa: boolean
  actorStaffId?: string
}

/**
 * Devuelve la configuración del venue, o `null` si nunca se ha guardado.
 *
 * 🔴 NO se crea una fila vacía al leer: una automatización que existe es una decisión que
 * alguien tomó. Crearla al abrir la pantalla llenaría la tabla de filas fantasma y haría
 * imposible distinguir «lo configuró y lo pausó» de «nunca lo tocó».
 */
export async function obtenerAutomatizacion(venueId: string) {
  return prisma.birthdayAutomation.findUnique({
    where: { venueId },
    select: {
      id: true,
      status: true,
      subject: true,
      contentBlocks: true,
      daysBefore: true,
      lastEvaluatedLocalDate: true,
      createdAt: true,
      updatedAt: true,
    },
  })
}

export async function guardarAutomatizacion(p: GuardarAutomatizacionParams) {
  const subject = p.subject?.trim() ?? ''
  if (!subject) throw new BadRequestError('El asunto del correo es requerido.')
  if (subject.length > 200) throw new BadRequestError('El asunto es demasiado largo.')

  if (!Number.isInteger(p.daysBefore) || p.daysBefore < 0 || p.daysBefore > MAX_DAYS_BEFORE) {
    throw new BadRequestError(`Los días de antelación deben ser un número entre 0 y ${MAX_DAYS_BEFORE}.`)
  }

  const parsed = bloquesCampanaSchema.safeParse(p.bloques)
  if (!parsed.success) {
    throw new BadRequestError('El contenido del correo no es válido.')
  }
  const bloques: BloqueCampana[] = parsed.data

  // El SERVIDOR renderiza. Nadie escribe HTML, así que no hay nada que sanitizar.
  const { html, text } = renderizarBloques(bloques)
  const linkDomains = dominiosDeLosBloques(bloques)

  const estado = p.activa ? BirthdayAutomationStatus.ACTIVE : BirthdayAutomationStatus.PAUSED

  const guardada = await prisma.birthdayAutomation.upsert({
    where: { venueId: p.venueId },
    create: {
      venueId: p.venueId,
      status: estado,
      subject,
      contentBlocks: bloques as any,
      htmlBody: html,
      textBody: text,
      linkDomains,
      daysBefore: p.daysBefore,
      createdByStaffId: p.actorStaffId ?? null,
      // 🔴 `lastEvaluatedLocalDate` se queda NULL al crear: el primer barrido evalúa sólo
      // HOY. Encenderla no puede disparar felicitaciones retroactivas de toda la historia.
    },
    update: {
      status: estado,
      subject,
      contentBlocks: bloques as any,
      htmlBody: html,
      textBody: text,
      linkDomains,
      daysBefore: p.daysBefore,
      // El cursor NO se toca al editar: si se reiniciara, un cambio de asunto volvería a
      // felicitar a quien ya recibió su correo (el dedupeKey lo frenaría, pero dependería
      // de él en vez de no producir el trabajo).
    },
    select: { id: true, status: true },
  })

  // Fuera de la transacción y sin encadenar: si la bitácora falla, guardar no falla.
  void logAction({
    action: p.activa ? 'BIRTHDAY_AUTOMATION_ENABLED' : 'BIRTHDAY_AUTOMATION_DISABLED',
    entity: 'BirthdayAutomation',
    entityId: guardada.id,
    staffId: p.actorStaffId,
    venueId: p.venueId,
    data: { daysBefore: p.daysBefore, subject },
  }).catch(() => {})

  return guardada
}
