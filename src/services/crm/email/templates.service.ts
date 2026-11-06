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
import { classifyUndeliverable } from '../../../utils/undeliverableEmail'
import { platformUnsubscribeUrl } from '../../../utils/platformUnsubscribeToken'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import emailService from '../../email.service'
import type { BloqueCampana } from '../../marketing/campaignBlocks'
import { renderizarBloques } from '../../marketing/campaignRenderer'
import { scopeWhere, type CrmAccess } from '../access.service'
import { miembrosConCorreo } from '../teamVenue.service'
import { cabecerasDeBaja, pieDeCampana } from './footer'
import { isBlocked, type Bloqueo } from './optOut.service'
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
// Sólo dice lo de ESTE intento: un rechazo no prueba que no saliera una prueba anterior igual (respuesta perdida y luego, p. ej., la
// credencial revocada). La pantalla lo pinta como «Este intento no salió: …».
const NO_SE_PUDO_MANDAR_LA_PRUEBA = 'si ya habías pedido una prueba igual, revisa tu correo: esa pudo haber llegado'
/** Resend no confirmó y la prueba PUDO haber salido: no se dice «no salió». Pedirla otra vez con lo mismo es la misma llave. */
const NO_SABEMOS_SI_SALIO_LA_PRUEBA =
  'Resend no confirmó. Revisa tu correo antes de pedirla otra vez; con el mismo contenido no llega dos veces'
/**
 * Lo que dice que Resend pudo haberla mandado: sin respuesta (sin código), un 5xx, o la llave ya usada / en vuelo. Lo demás (429,
 * validación, sin configurar, demo) es un «no» que se sabe.
 */
/** El bloqueo en palabras: la pantalla lo pinta tal cual, «Este intento no salió: …». */
const motivoDeBloqueo = (bloqueo: Bloqueo, propio: boolean): string => {
  const de = propio ? 'tu correo' : 'ese correo'
  return {
    BAJA: `${de} se dio de baja de los correos de Avoqado`,
    REBOTE: `${de} rebotó: ya no le mandamos nada`,
    QUEJA: `${de} marcó un envío como spam: ya no le mandamos nada`,
  }[bloqueo]
}
/** La razón verdadera cuando el correo no puede recibir (placeholder, dominio de ejemplo…): se dice antes que cualquier otra. */
export const NO_PUEDE_RECIBIR = 'Ese correo no puede recibir: mándala a alguien del equipo'
/** Qué resultado vuelve de una prueba: campos nuevos opcionales (una pantalla vieja los ignora). */
export type ResultadoDePrueba = { ok: boolean; motivo?: string; incierto?: true; repetida?: true; destino?: { nombre: string } }
export type EntradaDePrueba = { subject: string; blocks: BloqueCampana[]; destinoStaffId?: string }
const ACCIONES_DE_PRUEBA = ['CRM_CAMPAIGN_TEST_SENT', 'CRM_EMAIL_TEMPLATE_TEST_SENT']
const VENTANA_DE_PRUEBA_MS = 24 * 60 * 60 * 1000

/** crm-prueba:<quien la pide>[:<otra persona>]:<huella>. Sin destino, la de siempre; lleva sólo ids, nunca un correo. */
export function llaveDePrueba(actorStaffId: string, destinoStaffId: string | null, huella: string): string {
  return ['crm-prueba', actorStaffId, ...(destinoStaffId ? [destinoStaffId] : []), huella].join(':')
}

/**
 * ¿Ya salió una prueba con esta llave en las últimas 24 h? Lo dice la bitácora (sólo se escribe si salió). Si la consulta falla
 * se contesta «no»: se va a Resend con la MISMA llave y Resend no duplica.
 */
export async function pruebaYaSalio(actorStaffId: string, llave: string, ahora: Date): Promise<boolean> {
  try {
    const fila = await prisma.activityLog.findFirst({
      where: {
        staffId: actorStaffId,
        action: { in: ACCIONES_DE_PRUEBA },
        createdAt: { gte: new Date(ahora.getTime() - VENTANA_DE_PRUEBA_MS) },
        data: { path: ['llave'], equals: llave },
      },
      select: { id: true },
    })
    return !!fila
  } catch (error) {
    logger.warn('[CRM] The test email log could not be checked', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
const PUDO_SALIR = new Set([
  'application_error',
  'internal_server_error',
  'service_unavailable',
  'invalid_idempotent_request',
  'concurrent_idempotent_requests',
])

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

/** El nombre de quien manda, para `{{vendedor}}` (y el «De» del Gmail del vendedor). */
export async function nombreDelActor(staffId: string): Promise<string | null> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { firstName: true, lastName: true } })
  return staff ? `${staff.firstName} ${staff.lastName}`.trim() || null : null
}

/**
 * Una cuenta (y uno de sus contactos) sólo si cae dentro del alcance de «Ver» de quien pide: si no, 404, igual que si no
 * existiera. Sin `contactId`, el principal (o ninguno). La MISMA lectura para la vista previa y para lo que sale por Gmail,
 * así lo que se ve es lo que se manda.
 */
export async function cuentaYContactoEnAlcance(actor: CrmAccess, accountId: string, contactId?: string) {
  const account = await prisma.crmAccount.findFirst({
    where: { AND: [{ id: accountId }, scopeWhere(actor, 'ver')] },
    select: {
      name: true,
      contacts: {
        where: contactId ? { id: contactId } : {},
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { id: true, name: true, email: true },
      },
    },
  })
  if (!account) throw new NotFoundError('Ese negocio no existe', 'CRM_CUENTA_NOT_FOUND')
  const contact = account.contacts[0] ?? null
  if (contactId && !contact) throw new NotFoundError('Ese contacto no existe', 'CRM_CONTACTO_NOT_FOUND')
  return { account: { name: account.name }, contact }
}

/** Los datos REALES del contexto de la vista previa. Sin ningún contacto, `nombre` cae en el negocio. */
async function varsDelContexto(actor: CrmAccess, contexto: { accountId: string; contactId?: string }): Promise<Vars> {
  const { account, contact } = await cuentaYContactoEnAlcance(actor, contexto.accountId, contexto.contactId)
  return { nombre: contact?.name ?? null, negocio: account.name }
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
 * «Envíame una prueba»: el correo, con el pie y las cabeceras de baja de uno de verdad, al `Staff.email` de quien lo pide o,
 * si se elige, de otra persona del equipo del CRM. Nunca truena por lo que pasa al mandar: lo que no sale vuelve como
 * `{ ok: false, motivo }`, y lo que pudo haber salido además con `incierto: true`. Devuelve también la llave usada, para que
 * quien llama deje su bitácora.
 */
export async function enviarPrueba(actor: CrmAccess, input: EntradaDePrueba): Promise<{ resultado: ResultadoDePrueba; llave?: string }> {
  const otro = input.destinoStaffId && input.destinoStaffId !== actor.staffId ? input.destinoStaffId : null
  let destino: { nombre: string } | undefined
  let to: string
  const staff = await prisma.staff.findUnique({
    where: { id: actor.staffId },
    select: { email: true, firstName: true, lastName: true },
  })
  if (otro) {
    // 🔴 Se valida en el servidor: sólo una persona del equipo (no se confía en lo que manda la pantalla).
    const miembro = (await miembrosConCorreo()).find(m => m.staffId === otro)
    if (!miembro) throw new BadRequestError('Esa persona no es del equipo del CRM', 'CRM_PRUEBA_DESTINO_INVALIDO')
    to = miembro.email.trim().toLowerCase()
    destino = { nombre: miembro.name }
  } else {
    if (!staff?.email) return { resultado: { ok: false, motivo: 'No encontramos tu correo' } }
    to = staff.email.trim().toLowerCase()
  }
  const conEco = (r: ResultadoDePrueba): ResultadoDePrueba => (destino ? { ...r, destino } : r)

  // La razón más de fondo primero: a un correo que no puede recibir no le sirve ninguna lista.
  if (classifyUndeliverable(to)) return { resultado: conEco({ ok: false, motivo: NO_PUEDE_RECIBIR }) }

  // 🔴 Fuera de producción sólo sale a la lista de prueba.
  if (!puedeMandarFueraDeProduccion(to)) return { resultado: conEco({ ok: false, motivo: MOTIVO_FUERA_DE_LA_LISTA }) }

  // 🔴 Quien se dio de baja, rebotó o se quejó no recibe ni la prueba: así «Envíame una prueba» tampoco habilita el envío a
  // una dirección que ya no debe recibir nada de Avoqado. Si la base falla, la prueba no sale (nunca un error por «libre»).
  try {
    const bloqueo = await isBlocked(to)
    if (bloqueo) return { resultado: conEco({ ok: false, motivo: motivoDeBloqueo(bloqueo, !otro) }) }
  } catch (error) {
    logger.error('[CRM] The test email could not check the suppression lists', {
      staffId: actor.staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { resultado: conEco({ ok: false, motivo: NO_SE_PUDO_MANDAR_LA_PRUEBA }) }
  }

  const vendedor = staff ? `${staff.firstName} ${staff.lastName}`.trim() || null : null
  // Dos toques seguidos con lo mismo son UNA prueba (Resend recuerda la llave 24 h). El vendedor entra en la huella porque
  // es parte de lo que sale: Resend rechaza una llave repetida con otro contenido.
  const huella = createHash('sha256')
    .update(contentHash(input.subject, input.blocks) + (vendedor ?? ''))
    .digest('hex')
  const llave = llaveDePrueba(actor.staffId, otro, huella)

  // Ya salió igual en las últimas 24 h: no se llama a Resend (y no se anuncia como nueva).
  if (await pruebaYaSalio(actor.staffId, llave, new Date())) return { resultado: conEco({ ok: true, repetida: true }), llave }

  const urlDeBaja = platformUnsubscribeUrl(to)
  const correo = armarCorreo(input.subject, input.blocks, { ...EJEMPLO, vendedor }, pieDeCampana('PROSPECTO', null, urlDeBaja))
  try {
    const result = await emailService.sendEmailWithResult({
      to,
      subject: correo.subject,
      html: correo.html,
      text: correo.text,
      from: env.CRM_CAMPAIGN_FROM,
      replyTo: env.CRM_CAMPAIGN_REPLY_TO,
      headers: cabecerasDeBaja(urlDeBaja),
      idempotencyKey: llave,
    })
    if (result.ok) return { resultado: conEco({ ok: true }), llave }
    logger.warn('[CRM] The test email did not go out', { staffId: actor.staffId, error: result.errorCode ?? 'not sent' })
    if (result.errorCode === 'UNDELIVERABLE_RECIPIENT') return { resultado: conEco({ ok: false, motivo: NO_PUEDE_RECIBIR }) }
    if (!result.errorCode || PUDO_SALIR.has(result.errorCode)) {
      return { resultado: conEco({ ok: false, incierto: true, motivo: NO_SABEMOS_SI_SALIO_LA_PRUEBA }) }
    }
    return { resultado: conEco({ ok: false, motivo: NO_SE_PUDO_MANDAR_LA_PRUEBA }) }
  } catch (error) {
    logger.error('[CRM] The test email could not be sent', {
      staffId: actor.staffId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { resultado: conEco({ ok: false, incierto: true, motivo: NO_SABEMOS_SI_SALIO_LA_PRUEBA }) }
  }
}

export async function sendTestToSelf(actor: CrmAccess, input: EntradaDePrueba): Promise<ResultadoDePrueba> {
  return (await enviarPrueba(actor, input)).resultado
}

/** La prueba de una plantilla: igual, y si SALIÓ de verdad (no repetida) deja su bitácora, con la llave y sin correo. */
export async function sendTemplateTest(actor: CrmAccess, input: EntradaDePrueba): Promise<ResultadoDePrueba> {
  const { resultado, llave } = await enviarPrueba(actor, input)
  if (resultado.ok && !resultado.repetida) {
    void logAction({
      staffId: actor.staffId,
      venueId: null,
      action: 'CRM_EMAIL_TEMPLATE_TEST_SENT',
      entity: 'CrmEmailTemplate',
      data: { para: input.destinoStaffId ?? actor.staffId, llave },
    })
  }
  return resultado
}
