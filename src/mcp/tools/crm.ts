/**
 * The CRM from the MCP (spec 2026-10-30 §5.8, plan task 10): the founder's Claude routine (`seguimiento-prospectos`)
 * writes WhatsApp prospects and their follow-ups here instead of HubSpot.
 *
 * 🔴 SUPERADMIN only, three times over: `server.ts` registers them only for a SUPERADMIN connection, this file registers
 * nothing otherwise, and every handler checks again — then asks `getCrmAccess` for the same keys the CRM screens ask
 * for. Holding `crm:*` never widens `scope.isSuperAdmin`. Free catalog only: they are NOT in `directory/catalog.ts`.
 *
 * Everything goes through the CRM services (they check the scope, lock the row and write the timeline). What is added
 * here: one business per person on WhatsApp (ruling 38), a note only for a message the CRM has not seen (44), empty
 * fields filled and never overwritten (45), «sólo avanza» except to «Perdido» (46), reasons resolved by name, and writes
 * that a re-run of the routine does not repeat.
 *
 * Email (phase 2, plan task 8): two READ-ONLY tools, the templates and the status of the campaigns. Sending a campaign or an
 * email is NOT here on purpose — it is mass and cannot be undone, so only a person does it, from the screens.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { ForbiddenError } from '@/errors/AppError'
import type { CrmKey } from '@/lib/permissions'
import { ACTIVITY_TYPES } from '@/schemas/crm.schema'
import { getCrmAccess, hasCrmKey, scopeWhere, type CrmAccess } from '@/services/crm/access.service'
import {
  addNote,
  findDuplicates,
  getInitialStage,
  getPending,
  listAccounts,
  listLostReasons,
  listStages,
  lose,
  moveStage,
  type AccountRow,
  type MiActividad,
  type Pending,
} from '@/services/crm/accounts.service'
import { addActivity } from '@/services/crm/activities.service'
import { getCampaign, listCampaigns } from '@/services/crm/email/campaigns.service'
import { listTemplates } from '@/services/crm/email/templates.service'
import { deleteAccount, ErasedIdentityError, sameName } from '@/services/crm/erase.service'
import { accountForTx } from '@/services/crm/inbound.service'
import { getReports } from '@/services/crm/reports.service'
import { addEvent } from '@/services/crm/timeline.service'
import { DEFAULT_TIMEZONE, formatInVenueTimezone, venueStartOfDay } from '@/utils/datetime'
import { canonicalPhoneE164 } from '@/utils/phone'
import prisma from '@/utils/prismaClient'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import type { McpScope } from '../scope'
import { text } from '../respond'

const WHATSAPP = 'WHATSAPP'
const FIND_CAP = 20
const SOLO_AVOQADO = 'Sólo el equipo de Avoqado puede usar el CRM de ventas.'
const GANAR = 'Para ganarlo usa la ficha en el SUPERADMIN: pide ligar su negocio de Avoqado.'
const VOLVIO = 'Volvió a escribir por WhatsApp'
const SOLO = 'Sólo para el equipo de Avoqado.'
/** How far ahead of our clock a message's date may be (another device's clock) and still count as a message. */
const FUTURE_SKEW_MS = 5 * 60_000

/** Mexico City, like every date of the CRM. */
const fecha = (date: Date | null, format = 'yyyy-MM-dd HH:mm') => (date ? formatInVenueTimezone(date, DEFAULT_TIMEZONE, format) : null)

/** For matching a name the routine typed: no accents, no capitals, single spaces. */
const normal = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** The one item with that name, or null when none or several match: resolve, never guess. */
function porNombre<T extends { name: string }>(items: T[], name: string | undefined): T | null {
  if (!name) return null
  const matches = items.filter(item => normal(item.name) === normal(name))
  return matches.length === 1 ? matches[0] : null
}

/** One business as the routine reads it. In «Vencidas» and «Hoy» it also says which activity is the caller's (ruling 61). */
function negocio(row: AccountRow & { miActividad?: MiActividad | null }) {
  const mine = row.miActividad
  return {
    id: row.id,
    nombre: row.name,
    giro: row.giro,
    fuente: row.source,
    etapa: row.stage.name,
    dueno: row.owner?.name ?? 'Sin dueño',
    semaforo: row.semaforo,
    estancadoDias: row.estancadoDias,
    proximaActividad: row.nextActivity
      ? { tipo: row.nextActivity.type, titulo: row.nextActivity.title, vence: fecha(row.nextActivity.dueAt) }
      : null,
    yaCobro: row.firstMoneyAt !== null,
    archivado: row.archivedAt !== null,
    ...(mine === undefined ? {} : { miActividad: mine && { tipo: mine.type, titulo: mine.title, vence: fecha(mine.dueAt) } }),
  }
}

/**
 * Every handler: SUPERADMIN, the write grant for a write, the person's CRM keys read now from the database, and the
 * service's refusals written for the operator back as `ok:false` with their code. Anything else is thrown, and
 * `instrument.ts` handles it. With several keys, any one opens it (like the screens' `requireCrm([...])`).
 */
export async function conLlave(scope: McpScope, key: CrmKey | CrmKey[], run: (access: CrmAccess) => Promise<unknown>) {
  if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
  const keys = Array.isArray(key) ? key : [key]
  // «Editar» escribe: aunque venga dentro de una lista, el token necesita mcp:write.
  if (keys.includes('crm:editar')) requireWriteScopeAlways(scope, 'crm:editar', 'escribe en el CRM de ventas')
  const access = await getCrmAccess(scope.staffId)
  if (!access) return text({ ok: false, error: 'Tu usuario no tiene acceso al CRM: está inactivo o ya no es SUPERADMIN.' })
  if (!keys.some(one => hasCrmKey(access, one))) {
    const names = keys.map(one => `«${one}»`)
    return text({
      ok: false,
      error: keys.length === 1 ? `Te falta la llave ${names[0]} del CRM.` : `Te falta una de las llaves del CRM: ${names.join(', ')}.`,
    })
  }
  try {
    return text(await run(access))
  } catch (error) {
    const refusal = error as { isOperational?: unknown; message?: string; code?: string }
    if (typeof error !== 'object' || error === null || refusal.isOperational !== true) throw error
    return text({ ok: false, error: refusal.message, code: refusal.code })
  }
}

type Llenable = 'name' | 'giro' | 'ventasRango'

interface WhatsappInput {
  phone: string
  name?: string
  giro?: string
  ventasRango?: string
  campaign?: string
  ultimoMensajeAt?: Date
}

/** The transaction found another business than the one the ambiguity check verified (Codex autorización H3). */
class ChangedMeanwhile extends Error {}

type Upsert =
  | { ok: true; accountId: string; creado: boolean; yaExistia: boolean; reactivado: boolean; notaNueva: boolean; actualizados: Llenable[] }
  // Without candidates: a prospect the superadmin deleted (D7), which nobody picks among.
  | { ok: false; error: string; candidatos?: Awaited<ReturnType<typeof findDuplicates>> }

/**
 * Ruling 45: what the routine learned fills only what the business still lacks — the name while it is the phone (or
 * empty), the giro and the sales range while they are empty. Never overwrites.
 */
function vacios(row: { name: string; giro: string | null; ventasRango: string | null }, input: WhatsappInput) {
  const isPhone = (value: string) => canonicalPhoneE164(value) === input.phone
  const changes: Array<{ field: Llenable; from: string | null; to: string }> = []
  if (input.name && !isPhone(input.name) && (!row.name.trim() || isPhone(row.name))) {
    changes.push({ field: 'name', from: row.name, to: input.name })
  }
  if (input.giro && !row.giro?.trim()) changes.push({ field: 'giro', from: row.giro, to: input.giro })
  if (input.ventasRango && !row.ventasRango?.trim()) changes.push({ field: 'ventasRango', from: row.ventasRango, to: input.ventasRango })
  return changes
}

/**
 * Rulings 38, 44 and 45, in one transaction.
 *
 * The note «Volvió a escribir» is keyed by the message it is about — `whatsapp:<account>:<ultimoMensajeAt to the
 * minute>` — and the creation takes the same key, so re-reading a chat (the routine reads the last 4 days, every day)
 * writes nothing. Only a NEW note touches the business (it restarts «Estancado») and brings it back from the archive.
 * Without the message: its own WhatsApp business gets no note at all; one from another source gets one in its whole life
 * (`whatsapp:<account>`). Filling the empty fields does not depend on the note and is not a touch.
 */
async function upsertWhatsapp(access: CrmAccess, input: WhatsappInput): Promise<Upsert> {
  const now = new Date()
  const message = input.ultimoMensajeAt?.toISOString().slice(0, 16) // UTC, to the minute
  const keyOf = (accountId: string) => (message ? `whatsapp:${accountId}:${message}` : `whatsapp:${accountId}`)
  const extra = {
    ...(input.campaign ? { campaign: input.campaign } : {}),
    ...(input.ultimoMensajeAt ? { ultimoMensajeAt: input.ultimoMensajeAt.toISOString() } : {}),
  }
  // When what it fills was said (ruling 65 e): the message the routine read, never later than now. Like a landing form's
  // `receivedAt`, it stamps `qualifiedAt`, so an older form the sweep repairs late does not overwrite it.
  const learnedAt = input.ultimoMensajeAt && input.ultimoMensajeAt < now ? input.ultimoMensajeAt : now

  // Resolve, don't guess (the MCP's rule for writes, ruling 46): without its own WhatsApp business, a phone that is in
  // two or more businesses comes back with its candidates. What this check saw is what the transaction must find.
  const own = await prisma.crmAccount.findUnique({
    where: { source_externalKey: { source: WHATSAPP, externalKey: input.phone } },
    select: { id: true },
  })
  let verified: string | null = null
  if (!own) {
    const matches = await findDuplicates(access, { phone: input.phone })
    const ids = matches.flatMap(match => ('id' in match ? [match.id] : []))
    if (matches.length > 1 || ids.length !== matches.length) {
      return { ok: false, error: 'Ese teléfono está en varios negocios del CRM: elige uno y agrégale la nota.', candidatos: matches }
    }
    verified = ids[0] ?? null
  }
  const stageId = (await getInitialStage()).id

  try {
    return await prisma.$transaction(async (tx): Promise<Upsert> => {
      // The person's business by the resolver every writer shares (ruling 65 a): the WhatsApp one of this phone or, from any
      // other source, the one with a person of it — locked. Created only when the CRM has nobody with this phone.
      const name = input.name || input.phone
      const { account, created, via } = await accountForTx(
        tx,
        { emails: [], phones: [input.phone], organizationId: null },
        {
          source: WHATSAPP,
          externalKey: input.phone,
          data: {
            name,
            giro: input.giro || null,
            ventasRango: input.ventasRango || null,
            sourceDetail: input.campaign ? { campaign: input.campaign } : undefined,
            ownerStaffId: null,
            stageId,
            ...(input.giro || input.ventasRango ? { qualifiedAt: learnedAt } : {}),
          },
          contact: { name, phoneE164: input.phone, isPrimary: true },
        },
        // D7: a chat re-read from before the superadmin deleted this business does not create it again; a newer message
        // does. A date in the future proves no new message: it counts as none (Codex r4 H3).
        input.ultimoMensajeAt && input.ultimoMensajeAt.getTime() <= now.getTime() + FUTURE_SKEW_MS ? input.ultimoMensajeAt : undefined,
      )
      // Its own WhatsApp business (by its key) is never ambiguous; anything else must be what the check verified — the one
      // business with this phone, or none. Thrown, so a creation rolls back too.
      if (via !== 'KEY' && (created ? verified !== null : account.id !== verified)) throw new ChangedMeanwhile()
      if (created) {
        await addEvent(tx, {
          accountId: account.id,
          kind: 'SYSTEM',
          actorStaffId: access.staffId,
          sourceKey: keyOf(account.id),
          data: { event: 'CREATED', source: WHATSAPP, ...extra },
        })
        return { ok: true, accountId: account.id, creado: true, yaExistia: false, reactivado: false, notaNueva: false, actualizados: [] }
      }
      const accountId = account.id
      const ownKey = via === 'KEY'

      // Its row lock is the resolver's (two calls on the same business queue there); then the edit scope — everything, for
      // a SUPERADMIN.
      const row = await tx.crmAccount.findFirst({
        where: { AND: [{ id: accountId }, scopeWhere(access, 'editar')] },
        select: {
          name: true,
          giro: true,
          ventasRango: true,
          archivedAt: true,
          lastTouchAt: true,
          qualifiedAt: true,
          stage: { select: { kind: true } },
        },
      })
      if (!row) throw new ForbiddenError('Sólo puedes cambiar tus negocios y los que no tienen dueño', 'CRM_NO_ES_TUYO')

      // Ruling 44: the note is the gate of everything a message does.
      const text = `${VOLVIO}${input.ultimoMensajeAt ? ` el ${fecha(input.ultimoMensajeAt)}` : ''}${input.campaign ? ` (campaña ${input.campaign})` : ''}.`
      const notaNueva =
        !(ownKey && !message) &&
        (await addEvent(tx, {
          accountId,
          kind: 'NOTE',
          actorStaffId: access.staffId,
          sourceKey: keyOf(accountId),
          data: { text, via: WHATSAPP, ...extra },
        }))
      // Rulings 31/33/36: an archived business comes back — not a lost one, which stays lost.
      const reactivado = notaNueva && row.archivedAt !== null && row.stage.kind !== 'PERDIDA'
      const changes = vacios(row, input)

      const data: Prisma.CrmAccountUpdateInput = {}
      // A touch never moves back (ruling 65 e): another writer may have touched it while this call waited for the lock.
      if (notaNueva && row.lastTouchAt < now) data.lastTouchAt = now
      if (reactivado) data.archivedAt = null
      for (const { field, to } of changes) data[field] = to
      if (changes.some(({ field }) => field !== 'name')) {
        data.qualificationAvailable = true
        if (!row.qualifiedAt || row.qualifiedAt < learnedAt) data.qualifiedAt = learnedAt
      }
      if (Object.keys(data).length) await tx.crmAccount.update({ where: { id: accountId }, data })
      if (reactivado) {
        await addEvent(tx, { accountId, kind: 'REACTIVATED', actorStaffId: access.staffId, data: { via: WHATSAPP, ...extra } })
      }
      // Like the landing's qualification changes: by the system, saying where it came from.
      if (changes.length) await addEvent(tx, { accountId, kind: 'FIELD_CHANGE', actorStaffId: null, data: { via: WHATSAPP, changes } })
      return { ok: true, accountId, creado: false, yaExistia: true, reactivado, notaNueva, actualizados: changes.map(({ field }) => field) }
    })
  } catch (error) {
    if (error instanceof ErasedIdentityError) {
      return {
        ok: false,
        error: `Ese prospecto se eliminó del CRM el ${fecha(error.erasedAt)} y no se vuelve a crear con mensajes de antes. Si escribe de nuevo, entra solo; si de verdad es un prospecto, créalo a mano en el SUPERADMIN.`,
      }
    }
    if (!(error instanceof ChangedMeanwhile)) throw error
    // Another business with this phone appeared between the check and the lock (Codex autorización H3): nothing was
    // written, and the routine chooses — never a silent switch to the newest one.
    const candidatos = await findDuplicates(access, { phone: input.phone })
    return { ok: false, error: 'Ese teléfono cambió de negocio mientras se registraba: elige uno y agrégale la nota.', candidatos }
  }
}

/**
 * «Sólo avanza» (ruling 38), except to «Perdido» (spec §5.3-2, ruling 46): «Perdido» works from any open stage, whatever
 * the orders. Everything else only to a higher order, and only an open business; «Ganado» goes through the ficha. The
 * stage it decided from travels to the service, which answers 409 if someone changed it meanwhile — nothing reopened.
 */
async function advance(access: CrmAccess, input: { accountId: string; stageName: string; lostReason?: string; lostNote?: string }) {
  const [stages, account] = await Promise.all([
    listStages(),
    prisma.crmAccount.findFirst({
      where: { AND: [{ id: input.accountId }, scopeWhere(access, 'ver')] },
      select: { id: true, stage: { select: { id: true, name: true, order: true, kind: true } } },
    }),
  ])
  if (!account) return { ok: false, error: 'No encontramos ese negocio.' }
  const target = porNombre(stages, input.stageName)
  if (!target) return { ok: false, error: `No hay una etapa «${input.stageName}».`, etapas: stages.map(stage => stage.name) }
  if (target.kind === 'GANADA') return { ok: false, error: GANAR }
  const current = account.stage
  if (current.kind !== 'ABIERTA') {
    return { ok: false, error: `Está en «${current.name}» y ya se cerró: si hay que reabrirlo, hazlo en su ficha del SUPERADMIN.` }
  }

  if (target.kind === 'PERDIDA') {
    const reasons = (await listLostReasons()).filter(reason => reason.active)
    const reason = porNombre(reasons, input.lostReason)
    if (!reason) {
      return {
        ok: false,
        error: input.lostReason ? `«${input.lostReason}» no es uno de los motivos.` : 'Para perderlo di el motivo.',
        motivos: reasons.map(r => r.name),
      }
    }
    const row = await lose(access, account.id, { lostReasonId: reason.id, note: input.lostNote, expectedStageId: current.id })
    return { ok: true, negocio: negocio(row), audit: { action: 'CRM_ACCOUNT_LOST', data: { from: current.name, motivo: reason.name } } }
  }

  if (target.order <= current.order) {
    return {
      ok: false,
      error:
        target.id === current.id
          ? `Ya está en «${current.name}».`
          : `No retrocede: está en «${current.name}», después de «${target.name}».`,
    }
  }
  const row = await moveStage(access, account.id, target.id, current.id)
  return { ok: true, negocio: negocio(row), audit: { action: 'CRM_STAGE_MOVED', data: { from: current.name, to: target.name } } }
}

/** A page of the email lists: the service caps it at 100 too, this refuses a hostile number before it gets there. */
const pageLimit = z.number().int('El límite es un número entero').min(1, 'El límite es de 1 a 100').max(100, 'El límite es de 1 a 100')
const pageCursor = z.string().cuid('El cursor no es válido')

/** One template as the routine reads it: name, subject and dates. Never the content (the blocks). */
function plantilla(row: Awaited<ReturnType<typeof listTemplates>>['rows'][number]) {
  return {
    id: row.id,
    nombre: row.name,
    asunto: row.subject,
    creada: fecha(row.createdAt),
    actualizada: fecha(row.updatedAt),
    archivada: row.archivedAt !== null,
  }
}

/** The delivery states, in the words of the screen. ENVIANDO is a delivery the sender holds right now. */
const CONTADORES = {
  PENDIENTE: 'pendientes',
  ENVIANDO: 'enCurso',
  ENVIADO: 'enviados',
  REINTENTO: 'reintentos',
  FALLIDO: 'fallidos',
  OMITIDO: 'omitidos',
  DESCONOCIDO: 'desconocidos',
} as const

/** One campaign as the routine reads it: where it stands and how many emails are in each state. Never the content. */
function campana(row: Awaited<ReturnType<typeof getCampaign>>) {
  const segmentos = (row.audience as { segmentos?: Array<{ tipo?: unknown }> } | null)?.segmentos
  return {
    id: row.id,
    nombre: row.name,
    estado: row.status,
    asunto: row.subject,
    publicos: Array.isArray(segmentos) ? segmentos.flatMap(segmento => (typeof segmento?.tipo === 'string' ? [segmento.tipo] : [])) : [],
    total: row.total,
    pruebaVigente: row.pruebaVigente,
    contadores: Object.fromEntries(Object.entries(CONTADORES).map(([estado, nombre]) => [nombre, row.contadores[estado] ?? 0])) as Record<
      (typeof CONTADORES)[keyof typeof CONTADORES],
      number
    >,
    creada: fecha(row.createdAt),
    encolada: fecha(row.enqueuedAt),
    terminada: fecha(row.finishedAt),
    cancelada: fecha(row.cancelledAt),
  }
}

const accountId = z.string().cuid('El id del negocio no es válido')

export function registerCrmTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

  const audit = (action: string, entityId: string, data?: Record<string, unknown>) =>
    auditMcpWrite(scope, { action, entity: 'CrmAccount', entityId, venueId: null, data })

  server.tool(
    'crm_find_account',
    'Busca negocios en el CRM de ventas de Avoqado por teléfono, correo o texto (nombre del negocio o de su contacto). ' +
      'Con varios, gana el teléfono y luego el correo. Hasta 20 resultados con el total; también encuentra los archivados. ' +
      SOLO,
    {
      phone: z.string().max(40).optional().describe('Teléfono, en cualquier formato; sin lada se toma de México'),
      email: z.string().max(200).optional().describe('Correo del contacto'),
      q: z.string().max(200).optional().describe('Texto: nombre del negocio o de su contacto'),
    },
    async ({ phone, email, q }) =>
      conLlave(scope, 'crm:ver', async access => {
        // By phone, its canonical form; by email, the exact email (never the text search, which also matches phone digits).
        let filters: { q: string } | { email: string } | null = q?.trim() ? { q: q.trim() } : null
        if (email?.trim()) filters = { email: email.trim().toLowerCase() }
        if (phone) {
          const canonical = canonicalPhoneE164(phone)
          if (!canonical) return { ok: false, error: 'Ese teléfono no es válido.' }
          filters = { q: canonical }
        }
        if (!filters) return { ok: false, error: 'Di el teléfono, el correo o el texto a buscar.' }
        const { rows, nextCursor, total } = await listAccounts(access, { ...filters, limit: FIND_CAP })
        return { ok: true, total, hayMas: nextCursor !== null, negocios: rows.map(negocio) }
      }),
  )

  server.tool(
    'crm_upsert_whatsapp_prospect',
    'Registra en el CRM de ventas a un prospecto que escribió por WhatsApp. Si ese teléfono ya está en el CRM (por la ' +
      'landing, HubSpot, a mano o WhatsApp) no crea otro negocio. Manda ultimoMensajeAt, la hora del último mensaje del ' +
      'prospecto que viste: con un mensaje nuevo deja la nota «Volvió a escribir por WhatsApp», cuenta como contacto y, si ' +
      'estaba archivado y no perdido, lo reactiva; releer el mismo chat no escribe nada. El nombre, el giro y las ventas sólo ' +
      'se llenan si faltaban, nunca se sobrescriben. Si no está, lo crea sin dueño en la primera etapa. ' +
      SOLO,
    {
      phoneE164: z.string().min(1, 'Di el teléfono').max(40).describe('Teléfono del prospecto; sin lada se toma de México'),
      name: z.string().trim().max(200).optional().describe('Nombre del negocio o de la persona'),
      giro: z.string().trim().max(100).optional().describe('Giro del negocio, p. ej. cafetería'),
      ventasRango: z.string().trim().max(100).optional().describe('Cuánto vende al mes, como lo dijo'),
      campaign: z.string().trim().max(200).optional().describe('La campaña del anuncio por el que llegó'),
      ultimoMensajeAt: z
        .string()
        .datetime({ offset: true, message: 'La fecha va con su zona, p. ej. 2026-11-03T10:00:00-06:00' })
        .optional()
        .describe('Fecha y hora con zona del último mensaje del prospecto que viste en el chat'),
    },
    async ({ phoneE164, ultimoMensajeAt, ...input }) =>
      conLlave(scope, 'crm:editar', async access => {
        const phone = canonicalPhoneE164(phoneE164)
        if (!phone) return { ok: false, error: 'Ese teléfono no es válido.' }
        const result = await upsertWhatsapp(access, {
          phone,
          ...input,
          ultimoMensajeAt: ultimoMensajeAt ? new Date(ultimoMensajeAt) : undefined,
        })
        if (!result.ok) return result
        // A re-read that changed nothing leaves no trail.
        if (result.creado || result.notaNueva || result.actualizados.length) {
          const action = result.creado
            ? 'CRM_WHATSAPP_PROSPECT_CREATED'
            : result.notaNueva
              ? 'CRM_WHATSAPP_PROSPECT_RETURNED'
              : 'CRM_WHATSAPP_PROSPECT_UPDATED'
          await audit(action, result.accountId, {
            reactivado: result.reactivado,
            actualizados: result.actualizados,
            campaign: input.campaign ?? null,
          })
        }
        return result
      }),
  )

  server.tool(
    'crm_advance_stage',
    'Avanza un negocio del CRM a una etapa posterior, por su nombre (p. ej. «Demo»). Nunca retrocede ni mueve un negocio ' +
      'cerrado. «Perdido» se puede desde cualquier etapa abierta y pide el motivo, de la lista que se devuelve; para ' +
      '«Ganado» se usa la ficha del SUPERADMIN, que liga su negocio de Avoqado. Si el nombre no coincide, devuelve las ' +
      'opciones. ' +
      SOLO,
    {
      accountId,
      stageName: z.string().min(1, 'Di la etapa').max(100).describe('Nombre de la etapa destino'),
      lostReason: z.string().max(100).optional().describe('Para «Perdido»: el motivo, por su nombre'),
      lostNote: z.string().trim().max(1000).optional().describe('Para «Perdido»: una nota opcional'),
    },
    async input =>
      conLlave(scope, 'crm:editar', async access => {
        const { audit: what, ...answer } = await advance(access, input)
        if (what) await audit(what.action, input.accountId, what.data)
        return answer
      }),
  )

  server.tool(
    'crm_add_note',
    'Agrega una nota a la línea de tiempo de un negocio del CRM. La misma nota repetida el mismo día no se duplica. ' + SOLO,
    { accountId, text: z.string().trim().min(1, 'Escribe la nota').max(5000) },
    async ({ accountId: id, text: note }) =>
      conLlave(scope, 'crm:editar', async access => {
        // A retry of the routine: the same note by the same person on the same business today is already there.
        // ponytail: check-then-write; two identical calls in the same instant could both write.
        const already = await prisma.crmTimelineEvent.findFirst({
          where: {
            accountId: id,
            kind: 'NOTE',
            actorStaffId: access.staffId,
            createdAt: { gte: venueStartOfDay(DEFAULT_TIMEZONE, new Date()) },
            data: { path: ['text'], equals: note },
          },
          select: { id: true },
        })
        if (already) return { ok: true, accountId: id, yaEstaba: true }
        await addNote(access, id, { text: note })
        await audit('CRM_NOTE_ADDED', id)
        return { ok: true, accountId: id, yaEstaba: false }
      }),
  )

  server.tool(
    'crm_delete_account',
    'ELIMINA para siempre un negocio del CRM de ventas: sus contactos, notas, actividades e historia. No se puede deshacer; ' +
      'para sólo sacarlo del embudo se archiva en su ficha. Sólo el superadmin real. DOS PASOS: la primera llamada dice qué ' +
      'se borraría y pide confirmar; nada se borra hasta llamar otra vez con confirm:true. confirmName es el nombre del ' +
      'negocio tal como aparece. Lo eliminado no vuelve con datos de antes (landing, altas, HubSpot o esta rutina): vuelve ' +
      'sólo si la persona escribe o llena la landing después, o si alguien lo crea a mano. ' +
      SOLO,
    {
      accountId,
      // No maximum: it is the whole name of the business, whatever its length (Codex r3 H3).
      confirmName: z.string().trim().min(1, 'Escribe el nombre del negocio').describe('El nombre del negocio, tal como aparece'),
      confirm: z.boolean().optional().describe('true sólo en la SEGUNDA llamada, tras la autorización del usuario'),
    },
    async ({ accountId: id, confirmName, confirm }) =>
      conLlave(scope, 'crm:admin', async access => {
        requireWriteScopeAlways(scope, 'crm:admin', 'elimina un negocio del CRM de ventas')
        if (!access.isSuperadmin) return { ok: false, error: 'Sólo el superadmin puede eliminar un negocio del CRM.' }
        if (confirm !== true) {
          const account = await prisma.crmAccount.findUnique({
            where: { id },
            select: {
              name: true,
              source: true,
              stage: { select: { name: true } },
              _count: { select: { contacts: true, activities: true, timelineEvents: true } },
            },
          })
          if (!account) return { ok: false, error: 'Ese negocio ya no está en el CRM.' }
          // The token signs `confirmName`: it must be the name this preview shows, or a name that changed afterwards could
          // be confirmed without anybody seeing it (Codex r2 H4). The deletion compares it again under the lock.
          if (!sameName(confirmName, account.name)) {
            return { ok: false, error: `El nombre no coincide: este negocio se llama «${account.name}».` }
          }
          return {
            requiresConfirmation: true,
            negocio: account.name,
            fuente: account.source,
            etapa: account.stage.name,
            seBorran: {
              contactos: account._count.contacts,
              actividades: account._count.activities,
              eventos: account._count.timelineEvents,
            },
            aviso: 'Se borra para siempre y no se puede deshacer.',
          }
        }
        const result = await deleteAccount(access, id, confirmName)
        // The deletion's own ActivityLog is written in its transaction; this one adds which assistant did it.
        await audit('CRM_ACCOUNT_DELETED_BY_MCP', id)
        return { ok: true, ...result }
      }),
  )

  server.tool(
    'crm_add_activity',
    'Agenda el siguiente paso de un negocio del CRM (llamada, WhatsApp, correo, reunión, demo o tarea) con fecha y hora; ' +
      'queda a cargo del dueño del negocio o, si no tiene, de quien la agenda. Si ya hay una igual pendiente, no la duplica. ' +
      SOLO,
    {
      accountId,
      type: z.enum(ACTIVITY_TYPES, { errorMap: () => ({ message: 'El tipo es LLAMADA, WHATSAPP, CORREO, REUNION, DEMO o TAREA' }) }),
      title: z.string().trim().min(1, 'Escribe qué hay que hacer').max(200),
      dueAt: z
        .string()
        .datetime({ offset: true, message: 'La fecha va con su zona, p. ej. 2026-11-03T10:00:00-06:00' })
        .describe('Fecha y hora con zona; la Ciudad de México es -06:00'),
    },
    async ({ accountId: id, type, title, dueAt }) =>
      conLlave(scope, 'crm:editar', async access => {
        const due = new Date(dueAt)
        // The same activity still pending is the one a retry already scheduled.
        const already = await prisma.crmActivity.findFirst({
          where: { accountId: id, type, title, dueAt: due, doneAt: null, account: scopeWhere(access, 'ver') },
          select: { id: true, dueAt: true },
        })
        if (already) return { ok: true, activityId: already.id, vence: fecha(already.dueAt), yaEstaba: true }
        const activity = await addActivity(access, id, { type, title, dueAt: due })
        await audit('CRM_ACTIVITY_SCHEDULED', id, { activityId: activity.id, type, title })
        return { ok: true, activityId: activity.id, vence: fecha(activity.dueAt), yaEstaba: false }
      }),
  )

  server.tool(
    'crm_pending',
    '«Mis pendientes» del CRM de ventas: lo vencido, lo de hoy, mis negocios sin siguiente paso, mis estancados y los ' +
      'nuevos sin dueño. Hasta 50 por sección, con el total. Fechas en hora de la Ciudad de México. ' +
      SOLO,
    {},
    async () =>
      conLlave(scope, 'crm:ver', async access => {
        const pending = await getPending(access)
        const sections = Object.entries(pending) as Array<[keyof Pending, Pending[keyof Pending]]>
        return {
          ok: true,
          ...Object.fromEntries(sections.map(([name, section]) => [name, { total: section.total, negocios: section.rows.map(negocio) }])),
        }
      }),
  )

  server.tool(
    'crm_pipeline_summary',
    'Resumen del embudo de ventas: cuántos negocios hay en cada etapa y cuántos están estancados hoy, más los ganados y ' +
      'perdidos del mes en curso (Ciudad de México). ' +
      SOLO,
    {},
    async () =>
      conLlave(scope, 'crm:ver', async access => {
        const now = new Date()
        const desde = `${fecha(now, 'yyyy-MM')}-01`
        const hasta = fecha(now, 'yyyy-MM-dd') as string
        const reports = await getReports(access, { desde, hasta })
        return {
          ok: true,
          porEtapa: reports.porEtapa.map(stage => ({
            etapa: stage.name,
            tipo: stage.kind,
            total: stage.total,
            estancados: stage.estancados,
          })),
          abiertos: reports.abiertos,
          estancados: reports.estancados,
          mes: { desde, hasta, ganados: reports.ganados.total, perdidos: reports.perdidos.total },
        }
      }),
  )

  server.tool(
    'crm_list_email_templates',
    'Lista las plantillas de correo del CRM de ventas: nombre, asunto y fechas (no trae el contenido). Por default las vivas; ' +
      'archivadas:true trae las archivadas. De 50 en 50 (hasta 100) con el total; para la página siguiente manda el cursor que ' +
      'devolvió. Sólo lectura: esta herramienta no manda correos ni campañas (es masivo y no se deshace) ni crea plantillas; ' +
      'eso se hace en las pantallas del SUPERADMIN. ' +
      SOLO,
    {
      cursor: pageCursor.optional().describe('El «siguiente» de la página anterior'),
      limit: pageLimit.optional().describe('Cuántas traer, de 1 a 100 (50 si no lo dices)'),
      archivadas: z.boolean().optional().describe('true = sólo las archivadas; si no, sólo las vivas'),
    },
    async ({ cursor, limit, archivadas }) =>
      conLlave(scope, ['crm:contactar', 'crm:campanas', 'crm:admin'], async () => {
        const { rows, nextCursor, total } = await listTemplates({ cursor, limit, archivadas })
        return { ok: true, total, hayMas: nextCursor !== null, siguiente: nextCursor, plantillas: rows.map(plantilla) }
      }),
  )

  server.tool(
    'crm_campaign_status',
    'Estado de las campañas de correo del CRM de ventas: de cada una su estado (BORRADOR, ENVIANDO, ENVIADA o CANCELADA), el ' +
      'asunto, los públicos, a cuántas personas se encoló y cuántos correos van en cada estado (pendientes, en curso, enviados, ' +
      'reintentos, fallidos, omitidos y desconocidos: no sabemos si salieron, porque Resend los aceptó y no alcanzamos a guardarlo, ' +
      'porque pasaron más de 23 h desde el primer intento o porque se agotaron los intentos sin confirmación; los fallidos son sólo ' +
      'los que se sabe que no salieron). Sin ' +
      'campaignId lista las campañas, de 50 en 50 (hasta 100) con el total, y status filtra por estado; con campaignId trae ' +
      'esa campaña. No trae el contenido del correo. Sólo lectura: esta herramienta no manda correos ni campañas (es masivo y ' +
      'no se deshace); eso lo hace una persona desde las pantallas del SUPERADMIN. ' +
      SOLO,
    {
      campaignId: z.string().cuid('El id de la campaña no es válido').optional().describe('Una campaña en particular'),
      cursor: pageCursor.optional().describe('El «siguiente» de la página anterior (sólo en la lista)'),
      limit: pageLimit.optional().describe('Cuántas traer, de 1 a 100 (50 si no lo dices; sólo en la lista)'),
      status: z
        .enum(['BORRADOR', 'ENVIANDO', 'ENVIADA', 'CANCELADA'], {
          errorMap: () => ({ message: 'El estado es BORRADOR, ENVIANDO, ENVIADA o CANCELADA' }),
        })
        .optional()
        .describe('Sólo las campañas en ese estado (sólo en la lista)'),
    },
    async ({ campaignId, cursor, limit, status }) =>
      conLlave(scope, ['crm:campanas', 'crm:admin'], async () => {
        if (campaignId) return { ok: true, campana: campana(await getCampaign(campaignId)) }
        const { rows, nextCursor, total } = await listCampaigns({ cursor, limit, status })
        return { ok: true, total, hayMas: nextCursor !== null, siguiente: nextCursor, campanas: rows.map(campana) }
      }),
  )
}
