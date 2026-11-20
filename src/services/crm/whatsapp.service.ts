/**
 * Reading the sales WhatsApp (+52 56 4007 0001) in the CRM — phase 3, «leer chats» (promesa
 * Avoqado/docs/audit/2026-11-20-crm-whatsapp-leer/promesa.md).
 *
 * 🔴 READ ONLY. Nothing here writes `CrmWhatsappMessage` (its only writer is `storeSalesMessages` in the webhook) nor sends
 * anything to Meta: the SERVIDOR does not know how to send from the sales number, and it stays that way.
 *
 * 🔴 The founder only (20-nov, «Sólo yo»): the real superadmin (`access.isSuperadmin`, from `esSuperadminReal`). A seller with
 * every CRM key gets 403. The routes check it before reading any key (`soloSuperadminReal`); this check is the MCP's and the
 * backstop of both.
 *
 * A chat is linked to a prospect when some person of some CRM business carries its phone (`CrmContact.phoneE164`). Both sides
 * are stored canonical (`canonicalPhoneE164`), so a chat that arrived as `5215512345678` meets the `+525512345678` of the ficha.
 *
 * Pages are a photo («foto»): the first page fixes `hasta`, and every later page of the same walk only counts messages that
 * had arrived by then. A chat that gets a new message mid-walk keeps its place instead of jumping above the cursor and being
 * skipped, and the total does not move. What arrived later shows on the next first page (the screens refetch it every
 * minute). Accepted residuals (Codex r2 #2): a webhook batch whose statement started before the photo and committed after it
 * can still show on a later page, and a phone given to or taken from a business mid-walk changes «sin prospecto» from the
 * next page on; the next refresh shows the right list.
 */
import { Prisma } from '@prisma/client'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { utcTs } from '../../utils/sqlDates'
import type { CrmAccess } from './access.service'

const CHATS_DEFAULT = 50
const CHATS_MAX = 100
const MENSAJES_DEFAULT = 50
const MENSAJES_MAX = 200

export function soloElFounder(access: CrmAccess): void {
  if (!access.isSuperadmin) throw new ForbiddenError('Los chats del WhatsApp de ventas sólo los ve el superadmin.', 'CRM_FORBIDDEN')
}

const clamp = (value: number | undefined, fallback: number, max: number) => Math.min(Math.max(value ?? fallback, 1), max)

/**
 * `[hasta, sort date, unique tiebreaker]`, opaque to the screens. `hasta` is UTC as text, from THIS process's clock: the
 * webhook writes `receivedAt` through Prisma, whose engine fills `@default(now())` with the process clock in UTC whatever
 * the database's time zone (measured 20-nov on a Postgres in America/Los_Angeles: 22:56 stored at 14:59 local). Same process,
 * same clock: a message stamped after the photo can never fall inside it (Codex r3 #2; r2 #1 read the column's SQL default).
 */
type Cursor = [string, Date, string]
const HASTA_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/
const encode = (hasta: string, at: Date, id: string) => Buffer.from(JSON.stringify([hasta, at.toISOString(), id])).toString('base64url')
function decode(cursor: string | undefined): Cursor | null {
  if (!cursor) return null
  try {
    const [hasta, at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
    const date = new Date(String(at))
    if (
      typeof hasta === 'string' &&
      HASTA_RE.test(hasta) &&
      typeof at === 'string' &&
      typeof id === 'string' &&
      id &&
      !Number.isNaN(date.getTime())
    )
      return [hasta, date, id]
  } catch {
    // falls through to the 400
  }
  throw new BadRequestError('El cursor no es válido', 'CRM_CURSOR_INVALIDO')
}

/** The photo of a first page: now, in the form `receivedAt` is stored (UTC without zone, see `Cursor`). */
const fotoDeAhora = () => new Date().toISOString().slice(0, 23)

/**
 * The stored forms a phone from a screen can match: its canonical form and, for a `+digits` the list itself handed out,
 * that exact value too. The webhook keeps `+digits` when it cannot read a number, and canonicalizing such a value again may
 * give another one (a 10-digit `+…` reads as Mexican, `utils/phone.ts`), so the chat the list showed must still open.
 */
function formasDelTelefono(input: string): string[] {
  const raw = input.trim()
  const forms = new Set<string>()
  const canonical = canonicalPhoneE164(raw)
  if (canonical) forms.add(canonical)
  if (/^\+\d{6,15}$/.test(raw)) forms.add(raw)
  if (!forms.size) throw new BadRequestError('Ese teléfono no es válido', 'CRM_TELEFONO_INVALIDO')
  return [...forms]
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, char => `\\${char}`)

export interface ChatFilters {
  /** Only the chats no CRM business has the phone of. */
  sinProspecto?: boolean
  /** Digits of the phone (4 or more) or the WhatsApp profile name. */
  q?: string
  cursor?: string
  limit?: number
}

interface ChatRow {
  phone: string
  mensajes: number
  lastAt: Date
  accountId: string | null
  negocios: number
  accountName: string | null
  archivedAt: Date | null
  body: string | null
  type: string | null
  direction: string | null
  origin: string | null
  contactName: string | null
}

export interface Chat {
  telefono: string
  /** Whether the CRM accepts this phone for a person («Crear prospecto»): the webhook keeps `+digits` it could not read. */
  telefonoValido: boolean
  /** The last profile name Meta sent for this phone (only incoming messages carry it). */
  nombre: string | null
  mensajes: number
  ultimo: { at: Date; texto: string | null; tipo: string | null; direccion: string | null; origen: string | null }
  /** The oldest CRM business with a person of this phone; `otrosNegocios` says how many more have one. */
  negocio: { id: string; name: string; archivado: boolean } | null
  otrosNegocios: number
}

/**
 * One row per phone, newest chat first. The page size is the SERVIDOR's (50, at most 100); `total` is exact for the filter
 * and the photo. ponytail: the grouping reads every message up to `hasta` on each call, as an index-only scan of
 * "CrmWhatsappMessage_chat_cover_idx" (measured in the promesa's «Capacidad»); a per-chat summary table written by the webhook
 * is the upgrade if it ever gets slow.
 */
export async function listChats(access: CrmAccess, filters: ChatFilters = {}) {
  soloElFounder(access)
  const limit = clamp(filters.limit, CHATS_DEFAULT, CHATS_MAX)
  const after = decode(filters.cursor)
  const hasta = after?.[0] ?? fotoDeAhora()
  const foto = Prisma.sql`m."receivedAt" <= ${hasta}::timestamp`

  const q = filters.q?.trim() || null
  const digits = q?.replace(/\D/g, '') ?? ''
  // Only digits and phone punctuation is a phone: the names are not read at all (Codex r2 #7). Anything else, an emoji or a
  // letter, may be a profile name like «📦 2026» (Codex r3 #3).
  const soloTelefono = !!q && digits.length >= 4 && /^[\d\s()+\-.]+$/.test(q)
  // ponytail: the name search reads `contactName` of every message (no index can serve `bool_or(ILIKE)`): 28–121 ms with
  // 100,000 messages, seconds with 1,000,000. Past ~300,000, a pg_trgm GIN index on "contactName" and filtering the phones
  // first is the upgrade. The list without `q` is an index-only scan (covering index), 94–178 ms with 1,000,000.
  const pattern = q && !soloTelefono ? `%${likeEscape(q)}%` : null
  const busca = q
    ? Prisma.sql`WHERE ${digits.length >= 4 ? Prisma.sql`c.phone LIKE ${`%${digits}%`} OR` : Prisma.empty} c."nameMatch"`
    : Prisma.empty
  const sinProspecto = filters.sinProspecto ? Prisma.sql`AND f."accountId" IS NULL` : Prisma.empty
  const despues = after ? Prisma.sql`AND (f."lastAt", f.phone) < (${utcTs(after[1])}, ${after[2]})` : Prisma.empty

  // One source for the page and its total: the chats of the photo grouped by phone, the search, and their businesses.
  const base = Prisma.sql`
    WITH chats AS (
      SELECT m."contactPhone" AS phone, count(*)::int AS mensajes, max(m."sentAt") AS "lastAt",
             ${pattern ? Prisma.sql`coalesce(bool_or(m."contactName" ILIKE ${pattern}), false)` : Prisma.sql`false`} AS "nameMatch"
      FROM "CrmWhatsappMessage" m
      WHERE ${foto}
      GROUP BY m."contactPhone"
    ), filtrados AS (
      SELECT c.phone, c.mensajes, c."lastAt", ligas."accountId", ligas.negocios
      FROM chats c
      CROSS JOIN LATERAL (
        SELECT (array_agg(ct."accountId" ORDER BY a."createdAt", a.id))[1] AS "accountId",
               count(DISTINCT ct."accountId")::int AS negocios
        FROM "CrmContact" ct JOIN "CrmAccount" a ON a.id = ct."accountId" WHERE ct."phoneE164" = c.phone
      ) ligas
      ${busca}
    )`
  const totalSql = Prisma.sql`(SELECT count(*)::int FROM filtrados f WHERE true ${sinProspecto})`

  const rows = await prisma.$queryRaw<Array<ChatRow & { total: number }>>(Prisma.sql`
    ${base}
    SELECT p.*, a.name AS "accountName", a."archivedAt", last.body, last.type, last.direction, last.origin, perfil."contactName",
           ${totalSql} AS total
    FROM (
      SELECT f.* FROM filtrados f WHERE true ${sinProspecto} ${despues}
      ORDER BY f."lastAt" DESC, f.phone DESC
      LIMIT ${limit + 1}
    ) p
    LEFT JOIN "CrmAccount" a ON a.id = p."accountId"
    LEFT JOIN LATERAL (
      SELECT m.body, m.type, m.direction, m.origin FROM "CrmWhatsappMessage" m
      WHERE m."contactPhone" = p.phone AND ${foto} ORDER BY m."sentAt" DESC, m.id DESC LIMIT 1
    ) last ON true
    LEFT JOIN LATERAL (
      SELECT m."contactName" FROM "CrmWhatsappMessage" m
      WHERE m."contactPhone" = p.phone AND m."contactName" IS NOT NULL AND ${foto}
      ORDER BY m."sentAt" DESC, m.id DESC LIMIT 1
    ) perfil ON true
    ORDER BY p."lastAt" DESC, p.phone DESC
  `)
  // A page with no row (past the end, or nothing matches) carries no total: read it alone.
  const total =
    rows[0]?.total ?? (await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`${base} SELECT ${totalSql} AS total`))[0].total

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    rows: page.map(
      (row): Chat => ({
        telefono: row.phone,
        telefonoValido: canonicalPhoneE164(row.phone) !== null,
        nombre: row.contactName,
        mensajes: row.mensajes,
        ultimo: { at: row.lastAt, texto: row.body, tipo: row.type, direccion: row.direction, origen: row.origin },
        negocio: row.accountId ? { id: row.accountId, name: row.accountName ?? '', archivado: row.archivedAt !== null } : null,
        otrosNegocios: Math.max(row.negocios - 1, 0),
      }),
    ),
    total,
    nextCursor: rows.length > limit && last ? encode(hasta, last.lastAt, last.phone) : null,
  }
}

export interface ThreadQuery {
  phone?: string
  accountId?: string
  cursor?: string
  limit?: number
}

export interface Mensaje {
  id: string
  contactPhone: string
  contactName: string | null
  direction: string
  origin: string
  type: string
  body: string | null
  sentAt: Date
}

/**
 * One conversation: of a phone, or of every phone of a business's people (joined in the database, however many people it
 * has). The newest page first, returned oldest → newest (how a chat reads); «Ver anteriores» passes `nextCursor`. Ordered by
 * `sentAt, id`: two messages of the same second are never lost nor repeated between pages.
 */
export async function getThread(access: CrmAccess, query: ThreadQuery) {
  soloElFounder(access)
  if (!query.phone === !query.accountId) throw new BadRequestError('Di el teléfono o el negocio, uno de los dos', 'CRM_HILO_SIN_QUIEN')
  const limit = clamp(query.limit, MENSAJES_DEFAULT, MENSAJES_MAX)
  const before = decode(query.cursor)
  const hasta = before?.[0] ?? fotoDeAhora()

  let quien: Prisma.Sql
  if (query.accountId) {
    const account = await prisma.crmAccount.findUnique({ where: { id: query.accountId }, select: { id: true } })
    if (!account) throw new NotFoundError('Ese negocio no existe', 'CRM_NEGOCIO_NO_EXISTE')
    quien = Prisma.sql`m."contactPhone" IN (SELECT ct."phoneE164" FROM "CrmContact" ct WHERE ct."accountId" = ${account.id} AND ct."phoneE164" IS NOT NULL)`
  } else {
    quien = Prisma.sql`m."contactPhone" IN (${Prisma.join(formasDelTelefono(query.phone!))})`
  }
  const foto = Prisma.sql`${quien} AND m."receivedAt" <= ${hasta}::timestamp`
  const antes = before ? Prisma.sql`AND (m."sentAt", m.id) < (${utcTs(before[1])}, ${before[2]})` : Prisma.empty

  const [found, [{ total }]] = await Promise.all([
    prisma.$queryRaw<Mensaje[]>(Prisma.sql`
      SELECT m.id, m."contactPhone", m."contactName", m.direction, m.origin, m.type, m.body, m."sentAt"
      FROM "CrmWhatsappMessage" m
      WHERE ${foto} ${antes}
      ORDER BY m."sentAt" DESC, m.id DESC
      LIMIT ${limit + 1}
    `),
    prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT count(*)::int AS total FROM "CrmWhatsappMessage" m WHERE ${foto}`),
  ])
  const page = found.slice(0, limit)
  const oldest = page[page.length - 1]
  return {
    rows: page.reverse(),
    total,
    nextCursor: found.length > limit && oldest ? encode(hasta, oldest.sentAt, oldest.id) : null,
  }
}
