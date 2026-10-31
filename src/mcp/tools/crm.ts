/**
 * The CRM from the MCP (spec 2026-10-30 §5.8, plan task 10): the founder's Claude routine (`seguimiento-prospectos`)
 * writes WhatsApp prospects and their follow-ups here instead of HubSpot.
 *
 * 🔴 SUPERADMIN only, three times over: `server.ts` registers them only for a SUPERADMIN connection, this file registers
 * nothing otherwise, and every handler checks again — then asks `getCrmAccess` for the same keys the CRM screens ask
 * for. Holding `crm:*` never widens `scope.isSuperAdmin`. Free catalog only: they are NOT in `directory/catalog.ts`.
 *
 * Everything goes through the CRM services (they check the scope, lock the row and write the timeline). What is added
 * here is ruling 38: one business per person on WhatsApp, «sólo avanza», reasons resolved by name, and writes that a
 * retry of the routine does not repeat.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
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
  touchEditableTx,
  type AccountRow,
  type Pending,
} from '@/services/crm/accounts.service'
import { addActivity } from '@/services/crm/activities.service'
import { upsertAccountBySource } from '@/services/crm/inbound.service'
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

/** One business as the routine reads it. */
function negocio(row: AccountRow) {
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
  }
}

/**
 * Every handler: SUPERADMIN, the write grant for a write, the person's CRM keys read now from the database, and the
 * service's refusals written for the operator back as `ok:false` with their code. Anything else is thrown, and
 * `instrument.ts` handles it.
 */
async function conLlave(scope: McpScope, key: CrmKey, run: (access: CrmAccess) => Promise<unknown>) {
  if (!scope.isSuperAdmin) return text({ ok: false, error: SOLO_AVOQADO })
  if (key === 'crm:editar') requireWriteScopeAlways(scope, key, 'escribe en el CRM de ventas')
  const access = await getCrmAccess(scope.staffId)
  if (!access) return text({ ok: false, error: 'Tu usuario no tiene acceso al CRM: está inactivo o ya no es SUPERADMIN.' })
  if (!hasCrmKey(access, key)) return text({ ok: false, error: `Te falta la llave «${key}» del CRM.` })
  try {
    return text(await run(access))
  } catch (error) {
    const refusal = error as { isOperational?: unknown; message?: string; code?: string }
    if (typeof error !== 'object' || error === null || refusal.isOperational !== true) throw error
    return text({ ok: false, error: refusal.message, code: refusal.code })
  }
}

/**
 * Ruling 38. One event per business per day from WhatsApp, keyed `whatsapp:<account>:<day>`: the creation takes it, and
 * so does «Volvió a escribir» — so a retry or a second run the same day writes nothing, and a later day gets its note.
 */
async function upsertWhatsapp(
  access: CrmAccess,
  input: { phone: string; name?: string; giro?: string; ventasRango?: string; campaign?: string },
) {
  const now = new Date()
  const key = (accountId: string) => `whatsapp:${accountId}:${fecha(now, 'yyyy-MM-dd')}`
  const campaign = input.campaign ? { campaign: input.campaign } : {}

  // The person's business: the WhatsApp one of this phone or, from any other source, the one with a person of it.
  const whatsapp = await prisma.crmAccount.findUnique({
    where: { source_externalKey: { source: WHATSAPP, externalKey: input.phone } },
    select: { id: true },
  })
  let existingId = whatsapp?.id ?? null
  if (!existingId) {
    const matches = await findDuplicates(access, { phone: input.phone })
    const ids = matches.flatMap(match => ('id' in match ? [match.id] : []))
    if (matches.length > 1 || ids.length !== matches.length) {
      return { ok: false, error: 'Ese teléfono está en varios negocios del CRM: elige uno y agrégale la nota.', candidatos: matches }
    }
    existingId = ids[0] ?? null
  }
  const stageId = existingId ? null : (await getInitialStage()).id

  return prisma.$transaction(async tx => {
    let accountId = existingId
    if (!accountId && stageId) {
      const name = input.name || input.phone
      const { account, created } = await upsertAccountBySource(tx, {
        source: WHATSAPP,
        externalKey: input.phone,
        data: {
          name,
          giro: input.giro || null,
          ventasRango: input.ventasRango || null,
          sourceDetail: input.campaign ? { campaign: input.campaign } : undefined,
          ownerStaffId: null,
          stageId,
        },
        contact: { name, phoneE164: input.phone, isPrimary: true },
      })
      if (created) {
        await addEvent(tx, {
          accountId: account.id,
          kind: 'SYSTEM',
          actorStaffId: access.staffId,
          sourceKey: key(account.id),
          data: { event: 'CREATED', source: WHATSAPP, ...campaign },
        })
        return { ok: true, accountId: account.id, creado: true, yaExistia: false, reactivado: false, notaNueva: false }
      }
      // A call at the same instant created it: from here on it is the same as finding it.
      accountId = account.id
    }
    if (!accountId) throw new Error('WhatsApp prospect: no account to write to')

    // Scope check, row lock and touch (`lastTouchAt`) in one statement, like every change to a business.
    const row = await touchEditableTx(tx, access, accountId, now)
    // Rulings 31/33/36: an archived business comes back — not a lost one, which stays lost.
    const reactivado = row.archivedAt !== null && row.stage.kind !== 'PERDIDA'
    if (reactivado) {
      await tx.crmAccount.update({ where: { id: accountId }, data: { archivedAt: null } })
      await addEvent(tx, { accountId, kind: 'REACTIVATED', actorStaffId: access.staffId, data: { via: WHATSAPP, ...campaign } })
    }
    const notaNueva = await addEvent(tx, {
      accountId,
      kind: 'NOTE',
      actorStaffId: access.staffId,
      sourceKey: key(accountId),
      data: { text: input.campaign ? `${VOLVIO} (campaña ${input.campaign}).` : `${VOLVIO}.`, via: WHATSAPP, ...campaign },
    })
    return { ok: true, accountId, creado: false, yaExistia: true, reactivado, notaNueva }
  })
}

/**
 * «Sólo avanza» (ruling 38): only to a stage with a higher order, and only an open business. «Ganado» goes through the
 * ficha (it links the Avoqado business); «Perdido» needs a reason resolved by name.
 *
 * ponytail: the order is checked before `moveStage` locks the row; a person moving the same business in that instant
 * could be moved back by this call. Recheck inside the service's transaction if the routine and the team ever collide.
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
  if (target.order <= current.order) {
    return {
      ok: false,
      error:
        target.id === current.id
          ? `Ya está en «${current.name}».`
          : `No retrocede: está en «${current.name}», después de «${target.name}».`,
    }
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
    const row = await lose(access, account.id, { lostReasonId: reason.id, note: input.lostNote })
    return { ok: true, negocio: negocio(row), audit: { action: 'CRM_ACCOUNT_LOST', data: { from: current.name, motivo: reason.name } } }
  }
  const row = await moveStage(access, account.id, target.id)
  return { ok: true, negocio: negocio(row), audit: { action: 'CRM_STAGE_MOVED', data: { from: current.name, to: target.name } } }
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
        let term = q?.trim() || null
        if (email?.trim()) term = email.trim().toLowerCase()
        if (phone) {
          term = canonicalPhoneE164(phone)
          if (!term) return { ok: false, error: 'Ese teléfono no es válido.' }
        }
        if (!term) return { ok: false, error: 'Di el teléfono, el correo o el texto a buscar.' }
        const { rows, nextCursor, total } = await listAccounts(access, { q: term, limit: FIND_CAP })
        return { ok: true, total, hayMas: nextCursor !== null, negocios: rows.map(negocio) }
      }),
  )

  server.tool(
    'crm_upsert_whatsapp_prospect',
    'Registra en el CRM de ventas a un prospecto que escribió por WhatsApp. Si ese teléfono ya está en el CRM (por la ' +
      'landing, HubSpot, a mano o WhatsApp) no crea otro negocio: le deja la nota «Volvió a escribir por WhatsApp» (una por ' +
      'día) y, si estaba archivado y no perdido, lo reactiva. Si no está, lo crea sin dueño en la primera etapa. Repetir la ' +
      'misma llamada no duplica nada. ' +
      SOLO,
    {
      phoneE164: z.string().min(1, 'Di el teléfono').max(40).describe('Teléfono del prospecto; sin lada se toma de México'),
      name: z.string().trim().max(200).optional().describe('Nombre del negocio o de la persona'),
      giro: z.string().trim().max(100).optional().describe('Giro del negocio, p. ej. cafetería'),
      ventasRango: z.string().trim().max(100).optional().describe('Cuánto vende al mes, como lo dijo'),
      campaign: z.string().trim().max(200).optional().describe('La campaña del anuncio por el que llegó'),
    },
    async ({ phoneE164, ...input }) =>
      conLlave(scope, 'crm:editar', async access => {
        const phone = canonicalPhoneE164(phoneE164)
        if (!phone) return { ok: false, error: 'Ese teléfono no es válido.' }
        const result = await upsertWhatsapp(access, { phone, ...input })
        if (!('accountId' in result)) return result
        const { notaNueva, ...answer } = result
        if (answer.creado || answer.reactivado || notaNueva) {
          await audit(answer.creado ? 'CRM_WHATSAPP_PROSPECT_CREATED' : 'CRM_WHATSAPP_PROSPECT_RETURNED', answer.accountId, {
            reactivado: answer.reactivado,
            campaign: input.campaign ?? null,
          })
        }
        return answer
      }),
  )

  server.tool(
    'crm_advance_stage',
    'Avanza un negocio del CRM a una etapa posterior, por su nombre (p. ej. «Demo»). Nunca retrocede ni mueve un negocio ' +
      'cerrado. «Perdido» pide el motivo, de la lista que se devuelve; para «Ganado» se usa la ficha del SUPERADMIN, que ' +
      'liga su negocio de Avoqado. Si el nombre no coincide, devuelve las opciones. ' +
      SOLO,
    {
      accountId,
      stageName: z.string().min(1, 'Di la etapa').max(100).describe('Nombre de la etapa destino'),
      lostReason: z.string().max(100).optional().describe('Para «Perdido»: el motivo, por su nombre'),
      lostNote: z.string().trim().max(1000).optional().describe('Para «Perdido»: una nota opcional'),
    },
    async input =>
      conLlave(scope, 'crm:editar', async access => {
        const result = await advance(access, input)
        if (!('audit' in result)) return result
        const { audit: what, ...answer } = result
        await audit(what.action, input.accountId, what.data)
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
    'crm_add_activity',
    'Agenda el siguiente paso de un negocio del CRM (llamada, WhatsApp, correo, reunión, demo o tarea) con fecha y hora; ' +
      'queda a cargo del dueño del negocio. Si ya hay una igual pendiente, no la duplica. ' +
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
}
