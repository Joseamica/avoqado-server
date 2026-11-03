/**
 * Las campañas masivas del CRM (spec 2026-10-30 §5.6, fase 2): crear desde una plantilla, editar en BORRADOR, ver a cuántos
 * les llega, mandarse la prueba, confirmar y encolar, y cancelar.
 *
 * 🔴 Lo que no se negocia:
 *  - Nunca sale un contenido que no se probó ni se confirmó. «Envíame una prueba» deja la huella de ESA versión
 *    (`testSentHash`) y la vista previa firma contenido + público + conteo (token de 15 min); el encolado revisa las dos
 *    cosas con la fila de la campaña BLOQUEADA, así que una edición que llega a la vez espera y luego ya no la encuentra en
 *    BORRADOR (o el envío encuentra el contenido cambiado y da 409).
 *  - El encolado es UNA transacción: o quedan la campaña en ENVIANDO y TODAS sus deliveries, o nada. El remitente nunca ve
 *    una campaña a medias.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type { Prisma } from '@prisma/client'
import { ACCESS_TOKEN_SECRET } from '../../../config/env'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { audienciaSchema, type Audiencia } from '../../../schemas/crm.schema'
import prisma from '../../../utils/prismaClient'
import { logAction } from '../../dashboard/activity-log.service'
import { campanasPausadasPorCupo } from '../../email/resendQuota'
import type { BloqueCampana } from '../../marketing/campaignBlocks'
import type { CrmAccess } from '../access.service'
import { contarAudiencia, recorrerAudiencia } from './audience.service'
import { PUDO_SALIR_EN_UN_INTENTO_ANTERIOR } from './campaignSender.service'
import { assertSinVariablesDesconocidas, contentHash, sendTestToSelf } from './templates.service'

export type EstadoDeCampana = 'BORRADOR' | 'ENVIANDO' | 'ENVIADA' | 'CANCELADA'

const DEFAULT_PAGE = 50
const MAX_PAGE = 100

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  templateId: true,
  subject: true,
  blocks: true,
  audience: true,
  status: true,
  testSentHash: true,
  total: true,
  createdById: true,
  enqueuedAt: true,
  finishedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CrmCampaignSelect

type Fila = Prisma.CrmCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>

const notFound = () => new NotFoundError('Esa campaña no existe', 'CRM_CAMPANA_NOT_FOUND')
const yaSeManda = () => new ConflictError('La campaña ya se está mandando', 'CRM_CAMPANA_NO_EDITABLE')

/** Por qué una campaña que no está en BORRADOR ya no se edita ni se manda. */
function noEditable(status: string): ConflictError {
  if (status === 'ENVIADA') return new ConflictError('La campaña ya se mandó', 'CRM_CAMPANA_NO_EDITABLE')
  if (status === 'CANCELADA') return new ConflictError('La campaña está cancelada', 'CRM_CAMPANA_NO_EDITABLE')
  return yaSeManda()
}

const bloquesDe = (fila: { blocks: Prisma.JsonValue }) => fila.blocks as unknown as BloqueCampana[]

/** El público guardado, con la misma forma que pide la ruta. Un BORRADOR recién creado todavía no tiene ninguno. */
function audienciaDe(raw: Prisma.JsonValue): Audiencia {
  const parsed = audienciaSchema.safeParse(raw)
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Elige a quién le mandas', 'CRM_CAMPANA_SIN_PUBLICO')
  }
  return parsed.data
}

/** La huella del público: zod devuelve las llaves en el orden del esquema, así que el mismo público da la misma huella. */
const audienceHash = (audiencia: Audiencia) => createHash('sha256').update(JSON.stringify(audiencia)).digest('hex')

// ── El token de confirmación (mismo patrón que `marketing/campaignConfirmToken.ts`) ─────────────────────────────────────
// Llave derivada de ACCESS_TOKEN_SECRET con una etiqueta PROPIA (un token de otro carril nunca vale aquí), cuerpo en base64url
// y firma HMAC-SHA256 comparada en tiempo constante. No se guarda nada: se firma y se verifica al vuelo.

const CONFIRM_KEY_LABEL = 'avoqado-crm-campaign-confirm-v1'
/** Lo que dura una vista previa antes de exigir que se vuelva a revisar. */
const VIGENCIA_MS = 15 * 60 * 1000

interface Confirmacion {
  v: 1
  campaignId: string
  contentHash: string
  audienceHash: string
  total: number
  exp: number
}

const llave = () => createHmac('sha256', ACCESS_TOKEN_SECRET).update(CONFIRM_KEY_LABEL).digest()
const firma = (cuerpo: string) => createHmac('sha256', llave()).update(cuerpo).digest('base64url')

function firmarConfirmacion(p: Omit<Confirmacion, 'v'>): string {
  const cuerpo = Buffer.from(JSON.stringify({ v: 1, ...p })).toString('base64url')
  return `${cuerpo}.${firma(cuerpo)}`
}

/** El contenido del token, o null si está alterado, mal formado o es de otro propósito. */
function leerConfirmacion(token: string): Confirmacion | null {
  const punto = token.indexOf('.')
  if (punto <= 0 || punto === token.length - 1) return null
  const cuerpo = token.slice(0, punto)
  const recibida = Buffer.from(token.slice(punto + 1))
  const esperada = Buffer.from(firma(cuerpo))
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf-8')) as Confirmacion
    const forma =
      p?.v === 1 &&
      typeof p.campaignId === 'string' &&
      typeof p.contentHash === 'string' &&
      typeof p.audienceHash === 'string' &&
      Number.isInteger(p.total) &&
      typeof p.exp === 'number'
    return forma ? p : null
  } catch {
    return null
  }
}

// ── Leer ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cuántas deliveries hay en cada estado, de varias campañas en UNA consulta. */
async function contadoresDe(ids: string[]): Promise<Map<string, Record<string, number>>> {
  const porCampana = new Map<string, Record<string, number>>()
  if (!ids.length) return porCampana
  const grupos = await prisma.crmCampaignDelivery.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: ids } },
    _count: { _all: true },
  })
  for (const g of grupos) {
    const cuenta = porCampana.get(g.campaignId) ?? {}
    cuenta[g.status] = g._count._all
    porCampana.set(g.campaignId, cuenta)
  }
  return porCampana
}

/**
 * Lo que ve la pantalla: sin la huella cruda, con «¿ya te mandaste la prueba de esta versión?», los contadores y si la campaña
 * espera al cupo de Resend (`pausadaPorCupo`, campo nuevo y opcional: hasta la medianoche de CDMX, sólo si sigue enviando).
 */
function vista(fila: Fila, contadores: Record<string, number> = {}) {
  const { testSentHash, ...resto } = fila
  return {
    ...resto,
    pruebaVigente: testSentHash === contentHash(fila.subject, bloquesDe(fila)),
    contadores,
    pausadaPorCupo: fila.status === 'ENVIANDO' && campanasPausadasPorCupo(),
  }
}

export interface ListCampaignsQuery {
  cursor?: string
  limit?: number
  status?: EstadoDeCampana
}

export async function listCampaigns(q: ListCampaignsQuery = {}) {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_PAGE, 1), MAX_PAGE)
  const where: Prisma.CrmCampaignWhereInput = q.status ? { status: q.status } : {}
  const [found, total] = await Promise.all([
    prisma.crmCampaign.findMany({
      where,
      select: CAMPAIGN_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Una de más dice si hay página siguiente.
      take: limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }),
    prisma.crmCampaign.count({ where }),
  ])
  const rows = found.slice(0, limit)
  const contadores = await contadoresDe(rows.map(r => r.id))
  return {
    rows: rows.map(r => vista(r, contadores.get(r.id))),
    nextCursor: found.length > limit ? rows[rows.length - 1].id : null,
    total,
  }
}

export async function getCampaign(id: string) {
  const fila = await prisma.crmCampaign.findUnique({ where: { id }, select: CAMPAIGN_SELECT })
  if (!fila) throw notFound()
  return vista(fila, (await contadoresDe([id])).get(id))
}

// ── Escribir el BORRADOR ──────────────────────────────────────────────────────────────────────────────────────────────

/** Copia el asunto y los bloques de la plantilla: editar la plantilla después no cambia la campaña. */
export async function createCampaign(actor: CrmAccess, input: { name: string; templateId: string }) {
  const template = await prisma.crmEmailTemplate.findUnique({ where: { id: input.templateId }, select: { subject: true, blocks: true } })
  if (!template) throw new NotFoundError('Esa plantilla no existe', 'CRM_PLANTILLA_NOT_FOUND')
  const fila = await prisma.crmCampaign.create({
    data: {
      name: input.name,
      templateId: input.templateId,
      subject: template.subject,
      blocks: template.blocks as Prisma.InputJsonValue,
      audience: { segmentos: [] },
      createdById: actor.staffId,
    },
    select: CAMPAIGN_SELECT,
  })
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_CAMPAIGN_CREATED',
    entity: 'CrmCampaign',
    entityId: fila.id,
    data: { name: fila.name, templateId: input.templateId },
  })
  return vista(fila)
}

/** Sólo en BORRADOR, con un CAS: si la campaña ya se encoló (aunque sea un instante antes), 409 y no se toca nada. */
export async function updateCampaign(
  actor: CrmAccess,
  id: string,
  input: { name?: string; subject?: string; blocks?: BloqueCampana[]; audience?: Audiencia },
) {
  const antes = await prisma.crmCampaign.findUnique({ where: { id }, select: { status: true, subject: true, blocks: true } })
  if (!antes) throw notFound()
  if (antes.status !== 'BORRADOR') throw noEditable(antes.status)
  if (input.subject !== undefined || input.blocks !== undefined) {
    assertSinVariablesDesconocidas(input.subject ?? antes.subject, input.blocks ?? bloquesDe(antes))
  }

  const { count } = await prisma.crmCampaign.updateMany({
    where: { id, status: 'BORRADOR' },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.blocks !== undefined ? { blocks: input.blocks as unknown as Prisma.InputJsonValue } : {}),
      ...(input.audience !== undefined ? { audience: input.audience as unknown as Prisma.InputJsonValue } : {}),
    },
  })
  if (!count) throw yaSeManda()
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_CAMPAIGN_UPDATED',
    entity: 'CrmCampaign',
    entityId: id,
    data: { cambios: Object.keys(input) },
  })
  return getCampaign(id)
}

// ── Vista previa, prueba, envío y cancelación ────────────────────────────────────────────────────────────────────────

/** A cuántos les llega ahora mismo, por público, cuántos se quedan fuera por baja, y el token para confirmar ESTO. */
export async function previewSend(_actor: CrmAccess, id: string) {
  const fila = await prisma.crmCampaign.findUnique({ where: { id }, select: { status: true, subject: true, blocks: true, audience: true } })
  if (!fila) throw notFound()
  if (fila.status !== 'BORRADOR') throw noEditable(fila.status)
  const audiencia = audienciaDe(fila.audience)
  const { total, porSegmento, bloqueados } = await contarAudiencia(audiencia)
  const token = firmarConfirmacion({
    campaignId: id,
    contentHash: contentHash(fila.subject, bloquesDe(fila)),
    audienceHash: audienceHash(audiencia),
    total,
    exp: Date.now() + VIGENCIA_MS,
  })
  return { total, porSegmento, bloqueados, token }
}

/**
 * «Envíame una prueba» con el contenido de la campaña. 🔴 Sólo una prueba que SALIÓ (`ok: true`) habilita el envío: una
 * omitida por la lista de prueba o rechazada por Resend no escribe la huella.
 */
export async function sendCampaignTest(actor: CrmAccess, id: string) {
  const fila = await prisma.crmCampaign.findUnique({ where: { id }, select: { subject: true, blocks: true } })
  if (!fila) throw notFound()
  const resultado = await sendTestToSelf(actor, { subject: fila.subject, blocks: bloquesDe(fila) })
  if (resultado.ok) {
    // La huella de lo que se probó, no de lo que haya ahora: si alguien editó mientras tanto, la nueva versión pide su prueba.
    await prisma.crmCampaign.updateMany({ where: { id }, data: { testSentHash: contentHash(fila.subject, bloquesDe(fila)) } })
    void logAction({ staffId: actor.staffId, venueId: null, action: 'CRM_CAMPAIGN_TEST_SENT', entity: 'CrmCampaign', entityId: id })
  }
  return resultado
}

/**
 * Confirma y encola. Todo en una transacción interactiva, con la fila de la campaña bloqueada ANTES de validar:
 * estado → token → prueba de esta versión → BORRADOR a ENVIANDO → deliveries en lotes de 1,000 → total.
 */
export async function enqueueCampaign(actor: CrmAccess, id: string, token: string): Promise<{ total: number }> {
  const total = await prisma.$transaction(
    async tx => {
      // 0. El candado primero: una edición o un segundo envío que llegan a la vez esperan aquí, y luego ya no la encuentran en
      //    BORRADOR o encuentran el contenido cambiado.
      await tx.$queryRaw`SELECT "id" FROM "CrmCampaign" WHERE "id" = ${id} FOR UPDATE`
      const fila = await tx.crmCampaign.findUnique({ where: { id }, select: CAMPAIGN_SELECT })
      if (!fila) throw notFound()
      if (fila.status !== 'BORRADOR') throw noEditable(fila.status)

      const confirmacion = leerConfirmacion(token)
      if (!confirmacion || confirmacion.campaignId !== id) {
        throw new BadRequestError('La confirmación no es válida: vuelve a revisar la campaña', 'CRM_CAMPANA_CONFIRMACION_INVALIDA')
      }
      if (Date.now() > confirmacion.exp) {
        throw new ConflictError('La vista previa venció: revísala y confirma otra vez', 'CRM_CAMPANA_CONFIRMACION_VENCIDA')
      }
      const audiencia = audienciaDe(fila.audience)
      const hash = contentHash(fila.subject, bloquesDe(fila))
      if (confirmacion.contentHash !== hash || confirmacion.audienceHash !== audienceHash(audiencia)) {
        throw new ConflictError('La campaña cambió desde la vista previa: revísala y confirma otra vez', 'CRM_CAMPANA_CAMBIO')
      }
      if (fila.testSentHash !== hash) throw new ConflictError('Mándate la prueba de esta versión antes', 'CRM_CAMPANA_SIN_PRUEBA')
      const confirmado = confirmacion.total
      if (confirmado <= 0) throw new ConflictError('No hay a quién mandarle esta campaña', 'CRM_CAMPANA_SIN_DESTINATARIOS')

      // 1. BORRADOR → ENVIANDO. Bajo el candado no puede fallar; se deja el CAS por si alguien reordena estos pasos.
      const { count } = await tx.crmCampaign.updateMany({
        where: { id, status: 'BORRADOR' },
        data: { status: 'ENVIANDO', enqueuedAt: new Date() },
      })
      if (!count) throw yaSeManda()

      // 2. Las deliveries, por lote (recorrerAudiencia ya junta repetidos y quita bloqueados; `skipDuplicates` es la segunda capa).
      // ponytail: una transacción alcanza hasta ~50 mil destinatarios; más allá, un estado PREPARANDO reanudable.
      let creadas = 0
      await recorrerAudiencia(audiencia, async lote => {
        const { count: n } = await tx.crmCampaignDelivery.createMany({
          data: lote.map(d => ({
            campaignId: id,
            email: d.email,
            name: d.name ?? null,
            reason: d.reason,
            reasonVenueName: d.reasonVenueName ?? null,
            vars: d.vars as Prisma.InputJsonValue,
            accountId: d.accountId ?? null,
          })),
          skipDuplicates: true,
        })
        creadas += n
      })

      // Más de los que se confirmaron: se deshace todo. Menos (alguien se dio de baja) sí sigue.
      if (creadas > confirmado) {
        throw new ConflictError(
          `El público creció (${confirmado} → ${creadas}): revísalo y confirma otra vez`,
          'CRM_CAMPANA_PUBLICO_CRECIO',
          {
            confirmado,
            actual: creadas,
          },
        )
      }
      if (creadas === 0) throw new ConflictError('No hay a quién mandarle esta campaña', 'CRM_CAMPANA_SIN_DESTINATARIOS')

      // 3. El total.
      await tx.crmCampaign.update({ where: { id }, data: { total: creadas } })
      return creadas
    },
    { timeout: 120_000 },
  )

  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_CAMPAIGN_ENQUEUED',
    entity: 'CrmCampaign',
    entityId: id,
    data: { total },
  })
  return { total }
}

/**
 * Lo que nunca se reclamó queda OMITIDO «campaña cancelada»; lo que esperaba otro intento, DESCONOCIDO (pudo haber salido); lo que ya
 * está en manos del remitente lo revisa él al borde.
 */
export async function cancelCampaign(actor: CrmAccess, id: string) {
  const omitidas = await prisma.$transaction(async tx => {
    const { count } = await tx.crmCampaign.updateMany({
      where: { id, status: { in: ['BORRADOR', 'ENVIANDO'] } },
      data: { status: 'CANCELADA', cancelledAt: new Date() },
    })
    if (!count) {
      const actual = await tx.crmCampaign.findUnique({ where: { id }, select: { status: true } })
      if (!actual) throw notFound()
      throw new ConflictError(
        actual.status === 'CANCELADA' ? 'La campaña ya estaba cancelada' : 'La campaña ya se mandó: no se puede cancelar',
        'CRM_CAMPANA_TERMINADA',
      )
    }
    const { count: n } = await tx.crmCampaignDelivery.updateMany({
      where: { campaignId: id, status: 'PENDIENTE' },
      data: { status: 'OMITIDO', skipReason: 'campaña cancelada', nextAttemptAt: null },
    })
    // Una REINTENTO ya tuvo un intento que pudo llegar a Resend (su respuesta se perdió): no es «omitida», es «no sabemos».
    const { count: inciertas } = await tx.crmCampaignDelivery.updateMany({
      where: { campaignId: id, status: 'REINTENTO' },
      data: {
        status: 'DESCONOCIDO',
        skipReason: 'campaña cancelada',
        lastError: PUDO_SALIR_EN_UN_INTENTO_ANTERIOR,
        nextAttemptAt: null,
      },
    })
    return n + inciertas
  })
  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_CAMPAIGN_CANCELLED',
    entity: 'CrmCampaign',
    entityId: id,
    data: { omitidas },
  })
  return getCampaign(id)
}
