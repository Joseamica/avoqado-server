/**
 * Quién NO recibe correo de Avoqado (campañas del CRM, la prueba a sí mismo, el correo uno a uno): la unión de
 *  - `CrmEmailOptOut`: quien pidió no recibir más (la liga de un clic, una queja, o el administrador del CRM), y
 *  - `EmailSuppression`: la supresión GLOBAL por rebote duro o queja de spam (protege la reputación del remitente).
 *
 * 🔴 Los dos se revisan SIEMPRE justo antes de mandar, no sólo al armar la audiencia: una baja puede llegar a media campaña.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import { filtrarSuprimidos, normalizeEmail } from '../../marketing/emailSuppression.service'

export type Bloqueo = 'BAJA' | 'REBOTE' | 'QUEJA'
/** De dónde viene una baja: la liga de un clic, la queja de spam o el administrador desde la ficha. */
export type OrigenDeBaja = 'UN_CLIC' | 'QUEJA' | 'ADMIN'

/**
 * ¿Por qué NO se le escribe a esta dirección? `false` = se puede. Una baja manda sobre un rebote: quien pidió no recibir
 * sigue diciendo «BAJA» aunque además haya rebotado.
 *
 * Si la base falla LANZA: quien manda nunca debe tomar un error por «no está bloqueado». `db` = la transacción de quien
 * reserva el envío (el Gmail la vuelve a correr bajo el candado de su conexión).
 */
export async function isBlocked(email: string, db: Prisma.TransactionClient = prisma): Promise<false | Bloqueo> {
  const [baja, suprimido] = await Promise.all([
    db.crmEmailOptOut.findUnique({ where: { email: normalizeEmail(email) }, select: { id: true } }),
    bloqueoPorReputacion(email, db),
  ])
  return baja ? 'BAJA' : suprimido
}

/**
 * Sólo la supresión por reputación (`EmailSuppression`: rebote duro → «REBOTE», queja → «QUEJA»), SIN mirar la baja. La usan los
 * avisos de trabajo al equipo de ventas (Ruling 9): la baja de marketing no los frena, pero una baja no puede tapar un rebote o
 * una queja (una queja registra las dos). Si la base falla LANZA, igual que `isBlocked`.
 */
export async function bloqueoPorReputacion(email: string, db: Prisma.TransactionClient = prisma): Promise<false | 'REBOTE' | 'QUEJA'> {
  const suprimido = await db.emailSuppression.findUnique({ where: { email: normalizeEmail(email) }, select: { reason: true } })
  if (!suprimido) return false
  return suprimido.reason === 'COMPLAINT' ? 'QUEJA' : 'REBOTE'
}

/**
 * Los bloqueados de una lista, en lote: UNA consulta por tabla (nunca `isBlocked` N veces). Recibe el `tx` de la transacción
 * de quien arma la audiencia o la cola. Devuelve correos NORMALIZADOS: quien compara normaliza también su lado.
 */
export async function filtrarBloqueados(tx: Prisma.TransactionClient, emails: string[]): Promise<Set<string>> {
  const normalizados = [...new Set(emails.map(normalizeEmail))]
  if (normalizados.length === 0) return new Set()

  // `email` es único: a lo más una fila por correo pedido, así que `take` es el tamaño de la lista y no recorta nada.
  const bajas = await tx.crmEmailOptOut.findMany({
    where: { email: { in: normalizados } },
    select: { email: true },
    take: normalizados.length,
  })
  const suprimidos = await filtrarSuprimidos(tx, normalizados)
  return new Set([...bajas.map(b => b.email), ...suprimidos])
}

/**
 * La MISMA regla que `filtrarBloqueados` / `isBlocked`, para usarla dentro de un SQL (quién se puede agregar, «Ver quiénes»): ¿este
 * correo pidió la baja o está suprimido por rebote o queja? Quien la llama pasa el correo ya NORMALIZADO, como lo guardan las dos tablas.
 * 🔴 Alias propios (`bq_o`, `bq_s`): con `o` o `s` taparía a la `Organization` o al `Staff` de la consulta de afuera, y un correo como
 * `s."email"` se compararía contra la propia fila de la baja.
 */
export function sqlBloqueado(email: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(EXISTS (SELECT 1 FROM "CrmEmailOptOut" bq_o WHERE bq_o."email" = ${email}) OR EXISTS (SELECT 1 FROM "EmailSuppression" bq_s WHERE bq_s."email" = ${email}))`
}

/**
 * Da de baja un correo. Idempotente: la llave única de `email` hace de candado y `skipDuplicates` hace que el segundo clic
 * (Gmail y Yahoo reintentan) no truene ni duplique. Sólo la PRIMERA vez deja rastro en la bitácora.
 */
export async function optOut(email: string, source: OrigenDeBaja, actorStaffId?: string): Promise<void> {
  const normalizado = normalizeEmail(email)
  const { count } = await prisma.crmEmailOptOut.createMany({
    data: [{ email: normalizado, source, actorStaffId: actorStaffId ?? null }],
    skipDuplicates: true,
  })
  if (count === 0) return
  void logAction({
    staffId: actorStaffId ?? null,
    venueId: null,
    action: 'CRM_EMAIL_OPT_OUT',
    entity: 'CrmEmailOptOut',
    // 🔴 Sin el correo (D1): la fila de `CrmEmailOptOut` ya dice cuál y cuándo, y el borrado de la persona la limpia ahí.
    data: { source },
  })
}
