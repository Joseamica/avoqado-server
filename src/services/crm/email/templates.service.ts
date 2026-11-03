/**
 * Plantillas de correo del equipo de ventas (spec 2026-10-30 §5.6, fase 2): asunto y bloques con las variables
 * `{{nombre}}`, `{{negocio}}` y `{{vendedor}}`, la vista previa y «Envíame una prueba».
 *
 * 🔴 Nadie escribe HTML: el contenido son BLOQUES (`bloqueCampanaSchema`, el mismo catálogo que las campañas de los negocios)
 * y el servidor arma el HTML escapando todo lo que viene de una persona o de la base (`renderizarBloques`).
 */
import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { env } from '../../../config/env'
import logger from '../../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { platformUnsubscribeUrl } from '../../../utils/platformUnsubscribeToken'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import emailService from '../../email.service'
import type { BloqueCampana } from '../../marketing/campaignBlocks'
import { renderizarBloques } from '../../marketing/campaignRenderer'
import { scopeWhere, type CrmAccess } from '../access.service'
import { cabecerasDeBaja, pieDeCampana } from './footer'
import { isBlocked } from './optOut.service'
import { MOTIVO_FUERA_DE_LA_LISTA, puedeMandarFueraDeProduccion } from './testAllowlist'
import { aplicarVariables, variablesDesconocidasEn, type Vars } from './templateVars'

const DEFAULT_PAGE = 50
const MAX_PAGE = 100

const TEMPLATE_SELECT = {
  id: true,
  name: true,
  subject: true,
  blocks: true,
  archivedAt: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CrmEmailTemplateSelect

/** Los datos de ejemplo de la vista previa y de la prueba: no son de nadie. */
const EJEMPLO = { nombre: 'Ana', negocio: 'Cafetería La Esquina' } as const

const notFound = () => new NotFoundError('Esa plantilla no existe', 'CRM_PLANTILLA_NOT_FOUND')

/** Lo único que se le dice a quien pidió la prueba cuando algo falla por nuestro lado (la causa va al log). */
const NO_SE_PUDO_MANDAR_LA_PRUEBA = 'No se pudo mandar la prueba. Intenta de nuevo en un momento'

// ── Leer ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ListTemplatesQuery {
  cursor?: string
  limit?: number
  /** true = sólo las archivadas; si no, sólo las vivas. */
  archivadas?: boolean
}

export async function listTemplates(q: ListTemplatesQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)
  const where: Prisma.CrmEmailTemplateWhereInput = { archivedAt: q.archivadas ? { not: null } : null }
  const [found, total] = await Promise.all([
    prisma.crmEmailTemplate.findMany({
      where,
      select: TEMPLATE_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      // Una de más dice si hay página siguiente.
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
    prisma.crmEmailTemplate.count({ where }),
  ])
  const rows = found.slice(0, limit)
  return { rows, nextCursor: found.length > limit ? rows[rows.length - 1].id : null, total }
}

export async function getTemplate(id: string) {
  const template = await prisma.crmEmailTemplate.findUnique({ where: { id }, select: TEMPLATE_SELECT })
  if (!template) throw notFound()
  return template
}

// ── Escribir ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Una variable fuera de la lista cerrada se rechaza AL GUARDAR: «Variable desconocida: {{precio}}». También la campaña. */
export function assertSinVariablesDesconocidas(asunto: string, bloques: BloqueCampana[]): void {
  const desconocidas = variablesDesconocidasEn(asunto, bloques)
  if (!desconocidas.length) return
  const lista = desconocidas.map(nombre => `{{${nombre}}}`).join(', ')
  throw new BadRequestError(
    `${desconocidas.length === 1 ? 'Variable desconocida' : 'Variables desconocidas'}: ${lista}`,
    'CRM_PLANTILLA_VARIABLE_DESCONOCIDA',
    { variables: desconocidas },
  )
}

export async function createTemplate(actor: CrmAccess, input: { name: string; subject: string; blocks: BloqueCampana[] }) {
  assertSinVariablesDesconocidas(input.subject, input.blocks)
  const template = await prisma.crmEmailTemplate.create({
    data: {
      name: input.name,
      subject: input.subject,
      blocks: input.blocks as unknown as Prisma.InputJsonValue,
      createdById: actor.staffId,
      updatedById: actor.staffId,
    },
    select: TEMPLATE_SELECT,
  })
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_EMAIL_TEMPLATE_CREATED',
    entity: 'CrmEmailTemplate',
    entityId: template.id,
    data: { name: template.name },
  })
  return template
}

export async function updateTemplate(actor: CrmAccess, id: string, input: { name?: string; subject?: string; blocks?: BloqueCampana[] }) {
  const before = await getTemplate(id)
  // Una plantilla archivada no se edita: se desarchiva primero (así lo que ya no se usa no cambia a escondidas).
  if (before.archivedAt) throw new ConflictError('Esa plantilla está archivada: desarchívala para editarla', 'CRM_PLANTILLA_ARCHIVADA')

  // Se revisa lo que queda DESPUÉS del cambio: el asunto nuevo con los bloques de siempre, o al revés.
  const subject = input.subject ?? before.subject
  const blocks = input.blocks ?? (before.blocks as unknown as BloqueCampana[])
  assertSinVariablesDesconocidas(subject, blocks)

  const template = await prisma.crmEmailTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.blocks !== undefined ? { blocks: input.blocks as unknown as Prisma.InputJsonValue } : {}),
      updatedById: actor.staffId,
    },
    select: TEMPLATE_SELECT,
  })
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_EMAIL_TEMPLATE_UPDATED',
    entity: 'CrmEmailTemplate',
    entityId: id,
    data: { cambios: Object.keys(input) },
  })
  return template
}

/** Archivar y desarchivar: idempotentes (la segunda vez devuelve la plantilla como está) y sin borrar nada. */
async function setArchived(actor: CrmAccess, id: string, archived: boolean) {
  const { count } = await prisma.crmEmailTemplate.updateMany({
    where: { id, archivedAt: archived ? null : { not: null } },
    data: { archivedAt: archived ? new Date() : null, updatedById: actor.staffId },
  })
  if (count === 1) {
    void logAction({
      staffId: actor.staffId,
      venueId: null,
      action: archived ? 'CRM_EMAIL_TEMPLATE_ARCHIVED' : 'CRM_EMAIL_TEMPLATE_UNARCHIVED',
      entity: 'CrmEmailTemplate',
      entityId: id,
    })
  }
  return getTemplate(id)
}

export const archiveTemplate = (actor: CrmAccess, id: string) => setArchived(actor, id, true)
export const unarchiveTemplate = (actor: CrmAccess, id: string) => setArchived(actor, id, false)

// ── Armar el correo: vista previa y prueba ──────────────────────────────────────────────────────────────────────────

/** sha256 de asunto + bloques: lo que identifica «esta versión» del correo (la prueba de una campaña se compara con él). */
export function contentHash(subject: string, blocks: BloqueCampana[]): string {
  return createHash('sha256')
    .update(subject + JSON.stringify(blocks))
    .digest('hex')
}

/**
 * El correo ya con las variables puestas y el HTML armado. Sin pie: lo agrega quien manda (la prueba, la campaña). Es el
 * MISMO armado para la vista previa y para lo que sale, para que lo que se ve sea lo que se manda.
 */
export function armarCorreo(subject: string, blocks: BloqueCampana[], vars: Vars, pie?: { html: string; text: string }) {
  const aplicado = aplicarVariables(blocks, subject, vars)
  const cuerpo = renderizarBloques(aplicado.bloques)
  return {
    subject: aplicado.asunto,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">\n${cuerpo.html}${pie?.html ?? ''}\n</div>`,
    text: `${cuerpo.text}${pie?.text ?? ''}`,
  }
}

/** El nombre de quien manda, para `{{vendedor}}`. */
async function nombreDelActor(staffId: string): Promise<string | null> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } })
  return staff ? `${staff.firstName} ${staff.lastName}`.trim() || null : null
}

/**
 * Los datos REALES de una cuenta (y de uno de sus contactos), sólo si cae dentro del alcance de quien pide: si no, 404, igual
 * que si no existiera. Sin contacto, el principal; sin ninguno, `nombre` cae en el negocio.
 */
async function varsDelContexto(actor: CrmAccess, contexto: { accountId: string; contactId?: string }): Promise<Vars> {
  const account = await prisma.crmAccount.findFirst({
    where: { AND: [{ id: contexto.accountId }, scopeWhere(actor, 'ver')] },
    select: {
      name: true,
      contacts: {
        where: contexto.contactId ? { id: contexto.contactId } : {},
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { name: true },
      },
    },
  })
  if (!account) throw new NotFoundError('Ese negocio no existe', 'CRM_CUENTA_NOT_FOUND')
  if (contexto.contactId && !account.contacts.length) throw new NotFoundError('Ese contacto no existe', 'CRM_CONTACTO_NOT_FOUND')
  return { nombre: account.contacts[0]?.name ?? null, negocio: account.name }
}

export async function previewTemplate(
  input: { subject: string; blocks: BloqueCampana[]; contexto?: { accountId: string; contactId?: string } },
  actor: CrmAccess,
): Promise<{ subject: string; html: string; text: string }> {
  const datos = input.contexto ? await varsDelContexto(actor, input.contexto) : EJEMPLO
  const vendedor = await nombreDelActor(actor.staffId)
  return armarCorreo(input.subject, input.blocks, { ...datos, vendedor })
}

/**
 * «Envíame una prueba»: el correo, con el pie y las cabeceras de baja de uno de verdad, al `Staff.email` de quien lo pide.
 * Nunca truena: lo que no sale vuelve como `{ ok: false, motivo }`.
 */
export async function sendTestToSelf(
  actor: CrmAccess,
  input: { subject: string; blocks: BloqueCampana[] },
): Promise<{ ok: boolean; motivo?: string }> {
  const staff = await prisma.staff.findUnique({
    where: { id: actor.staffId },
    select: { email: true, firstName: true, lastName: true },
  })
  if (!staff?.email) return { ok: false, motivo: 'No encontramos tu correo' }
  const to = staff.email.trim().toLowerCase()

  // 🔴 Fuera de producción sólo sale a la lista de prueba.
  if (!puedeMandarFueraDeProduccion(to)) return { ok: false, motivo: MOTIVO_FUERA_DE_LA_LISTA }

  // 🔴 Quien se dio de baja, rebotó o se quejó no recibe ni la prueba: así «Envíame una prueba» tampoco habilita el envío a
  // una dirección que ya no debe recibir nada de Avoqado. Si la base falla, la prueba no sale (nunca un error por «libre»).
  try {
    const bloqueo = await isBlocked(to)
    if (bloqueo) return { ok: false, motivo: bloqueo }
  } catch (error) {
    logger.error('[CRM] The test email could not check the suppression lists', {
      staffId: actor.staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, motivo: NO_SE_PUDO_MANDAR_LA_PRUEBA }
  }

  const vendedor = `${staff.firstName} ${staff.lastName}`.trim() || null
  const urlDeBaja = platformUnsubscribeUrl(to)
  const correo = armarCorreo(input.subject, input.blocks, { ...EJEMPLO, vendedor }, pieDeCampana('PROSPECTO', null, urlDeBaja))
  // Dos toques seguidos con lo mismo son UNA prueba (Resend recuerda la llave 24 h). El vendedor entra en la huella porque
  // es parte de lo que sale: Resend rechaza una llave repetida con otro contenido.
  const huella = createHash('sha256')
    .update(contentHash(input.subject, input.blocks) + (vendedor ?? ''))
    .digest('hex')

  try {
    const result = await emailService.sendEmailWithResult({
      to,
      subject: correo.subject,
      html: correo.html,
      text: correo.text,
      from: env.CRM_CAMPAIGN_FROM,
      replyTo: env.CRM_CAMPAIGN_REPLY_TO,
      headers: cabecerasDeBaja(urlDeBaja),
      idempotencyKey: `crm-prueba:${actor.staffId}:${huella}`,
    })
    if (result.ok) return { ok: true }
    logger.warn('[CRM] The test email did not go out', { staffId: actor.staffId, error: result.errorCode ?? 'not sent' })
    return { ok: false, motivo: NO_SE_PUDO_MANDAR_LA_PRUEBA }
  } catch (error) {
    logger.error('[CRM] The test email could not be sent', {
      staffId: actor.staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, motivo: NO_SE_PUDO_MANDAR_LA_PRUEBA }
  }
}
