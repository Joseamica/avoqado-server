/**
 * «Importar lo de HubSpot», una sola vez (spec 2026-10-30 §5.3.4; rulings 4, 28, 30, 33, 36 and 65).
 *
 * Specific to HubSpot's export, not a general column mapper: a contacts file and a deals file, their headers read
 * without case or accents and with a few aliases (ruling 4). Every record enters with its key — `hubspot:deal:<id>` or
 * `hubspot:contact:<id>` — through `accountForTx`, so importing the same files twice, one after the other or
 * both at once, never duplicates an account.
 *
 * - A deal enters «Sin dueño», with its stage by name and its associated contacts inside (the first one, primary).
 *   «Cerrado Ganado» → «Ganado» without an Organization, with a note to link it; «Cerrado Perdido» → «Perdido» for
 *   «Dijo que no». Nothing is linked to an Organization: only the landing links by itself (ruling 28).
 * - A contact without a deal enters ARCHIVED and «Sin dueño» (ruling 30): out of the pipeline and the digest, found by a
 *   search.
 * - «Repetido» (rulings 33, 36 and 65): its key is already in the CRM, or the email or phone of the contact — of any of
 *   a deal's contacts — already is, from any source (the landing, by hand, WhatsApp, an earlier import), or an earlier
 *   record of these same files brings it. It is counted, nothing of it is written and nothing of what is there is
 *   touched; a repeated deal's aviso names the account (or the record) and the stage it had in HubSpot. Writing asks
 *   again, through the resolver every writer shares (`accountForTx`): a person another path created meanwhile is
 *   «repetido» too, never a second account.
 * - A person comes in through the same incorporation as everywhere (`addPersonTx`): two contact ids of the same email or
 *   phone, or the same id twice, never give two contacts; every distinct phone of the recognized columns comes in.
 *
 * A file that cannot be read — empty, wider than 2000 columns, with an unclosed quote, missing a column the import needs,
 * or not UTF-8 (the controller decodes it) — is refused whole, before anything is written. The preview writes nothing and lists the first 100
 * errors, notices and ignored columns with their totals; applying runs the same plan in batches of 200 records per
 * transaction, and a batch that fails keeps the earlier ones: importing the same files again completes it.
 */
import { Prisma } from '@prisma/client'
import Papa from 'papaparse'
import logger from '../../config/logger'
import { ValidationError } from '../../errors/AppError'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import type { CrmAccess } from './access.service'
import { getInitialStage, listLostReasons, listStages } from './accounts.service'
import { accountForTx, addPersonTx, cleanText, type UpsertBySourceInput } from './inbound.service'
import { addEvent } from './timeline.service'

const IMPORTACION = 'IMPORTACION'
/** Records per transaction: a failure costs one batch, never the ones before it. */
const BATCH = 200
const BATCH_TX = { maxWait: 10_000, timeout: 60_000 }
/** Keys, emails or phones per lookup query. */
const LOOKUP_CHUNK = 1000
/**
 * «Export all properties» gives several hundred columns; millions is a file that is not one (M-2, ruling 37). With the
 * alias map each column costs one lookup, so 2000 keeps the worst case small.
 */
const MAX_COLUMNS = 2000
/** Errors, notices and ignored columns the answer lists; their totals always come along. */
const LIST_CAP = 100
const WON_NOTE = 'Ganado en HubSpot: falta ligar su negocio de Avoqado'
const LOST_REASON = 'Dijo que no'
/** HubSpot's closed stages, in the founder's pipeline and in HubSpot's default one. */
const WON_STAGES = ['cerrado ganado', 'closed won']
const LOST_STAGES = ['cerrado perdido', 'closed lost']

/** Each field and the headers it is read from (ruling 4). The first one is how the preview names it. */
const CONTACT_COLUMNS = {
  id: ['Record ID', 'Contact ID', 'ID de registro'],
  firstName: ['First Name', 'Nombre'],
  lastName: ['Last Name', 'Apellidos'],
  phone: ['Phone Number', 'Phone', 'Mobile Phone Number', 'Número de teléfono', 'Teléfono'],
  email: ['Email', 'Correo', 'Correo electrónico'],
  company: ['Company Name', 'Company', 'Nombre de la empresa'],
}
/** All four are required: without the contacts, every deal's people would become archived accounts of their own. */
const DEAL_COLUMNS = {
  id: ['Record ID', 'Deal ID', 'ID de registro'],
  name: ['Deal Name', 'Nombre del negocio'],
  stage: ['Deal Stage', 'Pipeline Stage', 'Etapa del negocio'],
  contactIds: ['Associated Contact IDs', 'ID de contactos asociados'],
}

type Archivo = 'contactos' | 'negocios'

export interface ImportError {
  archivo: Archivo
  /** The row as the spreadsheet numbers it: the header is row 1. */
  fila: number
  razon: string
}

export interface HubspotPreview {
  nuevos: number
  repetidos: number
  /** The first 100 rows with an error, in the order of the files; `conErrorTotal` says how many there are. */
  conError: ImportError[]
  conErrorTotal: number
  /** New deals, in the pipeline. */
  negocios: number
  /** New contacts without a deal, archived. */
  archivados: number
  /** Contacts that go inside their deal's account instead of getting their own. */
  contactosDeNegocios: number
  /**
   * What does not enter as the file says: a deal of someone already in the CRM, a stage the CRM lacks, a phone that is not
   * one, a deal's contact that cannot come in. The first 100, and their total.
   */
  avisos: string[]
  avisosTotal: number
  /** The first 100 of each file, and their totals. */
  columnasIgnoradas: Record<Archivo, string[]>
  columnasIgnoradasTotal: Record<Archivo, number>
}

export interface HubspotApplied extends HubspotPreview {
  /** Accounts this run created. Fewer than `nuevos` if another import created some in between. */
  aplicados: number
  /** Records of the batches that failed: importing again completes them. */
  fallaron: number
}

// ── Reading a file ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Headers and stage names compare without case, accents or extra spaces. */
const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

/** Every distinct non-empty value of a field, in the order of its columns: «Phone Number» and «Mobile Phone Number» both. */
type Values<F extends string> = Partial<Record<F, string[]>>

/** A row of the file, read — or the reason it could not be. In the order of the file. */
type CsvRow<F extends string> = { fila: number; values: Values<F> } | { fila: number; razon: string }

interface CsvFile<F extends string> {
  rows: CsvRow<F>[]
  /** Why nothing of either file is imported: the file cannot be read as a whole. */
  unreadable: ImportError | null
  ignored: string[]
}

/**
 * The rows of one file, each cell cleaned like the landing's (no NUL or control characters, at most 500 characters).
 * Empty rows are skipped; a row with a different number of columns than the header — an unquoted comma that shifted
 * every cell after it — or a misplaced quote is an error of that row, never a guess. An unclosed quote makes Papa fold
 * every row after it into one cell, so that file is not read at all (M-4).
 */
function readCsv<F extends string>(csv: string, archivo: Archivo, columns: Record<F, string[]>, required: NoInfer<F>[]): CsvFile<F> {
  const unreadable = (fila: number, razon: string, ignored: string[] = []): CsvFile<F> => ({
    rows: [],
    unreadable: { archivo, fila, razon },
    ignored,
  })
  // Without a header row: Papa's row numbers then match the spreadsheet's, header included. It strips the BOM itself.
  const { data, errors: parseErrors } = Papa.parse<string[]>(csv, { skipEmptyLines: false })
  const [header = [], ...lines] = data
  // Before touching a single header: a file that is not a CSV can be millions of columns (M-2).
  if (header.length > MAX_COLUMNS) {
    return unreadable(1, `Tiene ${header.length} columnas y el máximo es ${MAX_COLUMNS}: en HubSpot exporta sólo las columnas de la vista`)
  }
  const unclosed = parseErrors.find(error => error.code === 'MissingQuotes' && error.row !== undefined)
  if (unclosed) return unreadable(unclosed.row! + 1, 'Tiene comillas sin cerrar: no se pudo leer nada desde esta fila')

  // Each alias normalized once; each header looked up once.
  const fieldOf = new Map<string, F>()
  for (const field of Object.keys(columns) as F[]) for (const alias of columns[field]) fieldOf.set(normalize(alias), field)
  const names = header.map(cleanText)
  const fieldAt = names.map(name => fieldOf.get(normalize(name)) ?? null)
  const ignored = names.filter((name, column) => name && !fieldAt[column])

  if (!names.some(Boolean)) return unreadable(1, 'El archivo está vacío', ignored)
  const missing = required.find(field => !fieldAt.includes(field))
  if (missing) return unreadable(1, `Falta la columna «${columns[missing][0]}»`, ignored)

  const misquoted = new Set(
    parseErrors.flatMap(error => (error.code === 'InvalidQuotes' && error.row !== undefined ? [error.row + 1] : [])),
  )
  const rows: CsvRow<F>[] = []
  lines.forEach((line, index) => {
    const fila = index + 2
    if (line.every(cell => !cleanText(cell))) return
    if (misquoted.has(fila)) return void rows.push({ fila, razon: 'Tiene comillas mal puestas' })
    if (line.length !== header.length) {
      return void rows.push({ fila, razon: `Tiene ${line.length} columnas y el encabezado ${header.length}` })
    }
    const values: Values<F> = {}
    line.forEach((cell, column) => {
      const field = fieldAt[column]
      const text = cleanText(cell)
      if (!field || !text) return
      const kept = (values[field] ??= [])
      if (!kept.includes(text)) kept.push(text)
    })
    rows.push({ fila, values })
  })
  return { rows, unreadable: null, ignored }
}

/** A list that keeps its first 100 items and counts them all. */
function capped<T>() {
  const list = {
    items: [] as T[],
    total: 0,
    add(item: T) {
      list.total++
      if (list.items.length < LIST_CAP) list.items.push(item)
    },
  }
  return list
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ContactRow {
  id: string
  person: string | null
  company: string | null
  /** Every distinct valid phone of the row (ruling 65 d), canonical; the first one is the main one. */
  phones: string[]
  email: string | null
}

type ContactInput = NonNullable<UpsertBySourceInput['contact']>

interface PlannedAccount {
  externalKey: string
  data: UpsertBySourceInput['data']
  /** The first one is the primary person; a person's other phones follow as people of their own. */
  contacts: ContactInput[]
  stageName: string
  won: boolean
  /** A deal's line for an aviso — `Negocios, fila N: «nombre»` and its HubSpot stage — if it turns out «repetido». */
  deal?: { where: string; hubspotStage: string }
}

const dealKey = (id: string) => `hubspot:deal:${id}`
const contactKey = (id: string) => `hubspot:contact:${id}`

const nameOf = (contact: ContactRow) => contact.person || contact.company || contact.phones[0] || ''

/** A row's people: its main contact, then one for each of its other phones (the incorporation never repeats them). */
const peopleOf = (contact: ContactRow, isPrimary: boolean): ContactInput[] => [
  { name: nameOf(contact), phoneE164: contact.phones[0] ?? null, email: contact.email, isPrimary },
  ...contact.phones.slice(1).map(phoneE164 => ({ name: nameOf(contact), phoneE164, email: contact.email, isPrimary: false })),
]

/** What identifies a row's person: its email and every phone. An email has an «@» and an E.164 phone never does. */
const identityOf = (contact: ContactRow) => [...(contact.email ? [contact.email] : []), ...contact.phones]

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}

/** The HubSpot keys this import already created, a chunk of keys per query. */
async function existingKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const chunk of chunksOf(keys, LOOKUP_CHUNK)) {
    const accounts = await prisma.crmAccount.findMany({
      where: { source: IMPORTACION, externalKey: { in: chunk } },
      select: { externalKey: true },
      orderBy: { id: 'asc' },
      // (source, externalKey) is unique: never more than the keys asked for.
      take: chunk.length,
    })
    for (const { externalKey } of accounts) if (externalKey) found.add(externalKey)
  }
  return found
}

/**
 * The emails and phones a person already in the CRM has (rulings 33 and 65), from ANY source — the landing, by hand,
 * WhatsApp, an earlier run of this import: one person, one account, however they arrived. One set for both: an email
 * has an «@» and an E.164 phone never does. GROUP BY gives each value once, however many people share it; every CRM
 * writer stores emails in lowercase (the landing, «Nuevo prospecto», this import), so the exact match uses the index.
 */
async function knownEmailsAndPhones(contacts: ContactRow[]): Promise<Map<string, string>> {
  const emails = [...new Set(contacts.flatMap(contact => (contact.email ? [contact.email] : [])))]
  const phones = [...new Set(contacts.flatMap(contact => contact.phones))]
  // Each email or phone → ONE account that has it (the smallest id: the same answer on every run).
  const found = new Map<string, string>()
  for (const chunk of chunksOf(emails, LOOKUP_CHUNK)) {
    const rows = await prisma.crmContact.groupBy({ by: ['email'], where: { email: { in: chunk } }, _min: { accountId: true } })
    for (const { email, _min } of rows) if (email && _min.accountId) found.set(email, _min.accountId)
  }
  for (const chunk of chunksOf(phones, LOOKUP_CHUNK)) {
    const rows = await prisma.crmContact.groupBy({ by: ['phoneE164'], where: { phoneE164: { in: chunk } }, _min: { accountId: true } })
    for (const { phoneE164, _min } of rows) if (phoneE164 && _min.accountId) found.set(phoneE164, _min.accountId)
  }
  return found
}

/** The first of these people's values a map knows, and what it says: the account they are in, or the record that brings them. */
function firstKnown<T>(known: Map<string, T>, people: ContactRow[]): { person: ContactRow; value: T } | null {
  for (const person of people) {
    for (const key of identityOf(person)) {
      const value = known.get(key)
      if (value !== undefined) return { person, value }
    }
  }
  return null
}

/** The names of the accounts the avisos point to (only deals of someone already in the CRM: a handful). */
async function accountNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const chunk of chunksOf([...new Set(ids)], LOOKUP_CHUNK)) {
    const accounts = await prisma.crmAccount.findMany({
      where: { id: { in: chunk } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
      take: chunk.length,
    })
    for (const account of accounts) names.set(account.id, account.name)
  }
  return names
}

/** A repeated deal's aviso (ruling 36): who is already there, where, and the stage HubSpot had, for the seller to carry over. */
const repeatedDeal = (where: string, person: ContactRow, place: string, hubspotStage: string) =>
  `${where} no entra (ni sus contactos): ${nameOf(person)} ya ${place}; en HubSpot estaba en ${hubspotStage}, ajústalo a mano`

const stageText = (stage: string) => (stage ? `la etapa «${stage}»` : 'ninguna etapa')

/** What the two files would do to the CRM now, and the accounts to create. Reads; never writes. */
async function plan(contactsCsv: string, dealsCsv: string) {
  const contactsFile = readCsv(contactsCsv, 'contactos', CONTACT_COLUMNS, ['id'])
  const dealsFile = readCsv(dealsCsv, 'negocios', DEAL_COLUMNS, ['id', 'name', 'stage', 'contactIds'])
  const counts = { nuevos: 0, repetidos: 0, negocios: 0, archivados: 0, contactosDeNegocios: 0 }
  // Both files are read in order, contacts first: the first 100 of each list are the first ones of the files.
  const errors = capped<ImportError>()
  const avisos = capped<string>()
  const summary = (): HubspotPreview => ({
    ...counts,
    conError: errors.items,
    conErrorTotal: errors.total,
    avisos: avisos.items,
    avisosTotal: avisos.total,
    columnasIgnoradas: { contactos: contactsFile.ignored.slice(0, LIST_CAP), negocios: dealsFile.ignored.slice(0, LIST_CAP) },
    columnasIgnoradasTotal: { contactos: contactsFile.ignored.length, negocios: dealsFile.ignored.length },
  })
  const records: PlannedAccount[] = []
  for (const file of [contactsFile, dealsFile]) if (file.unreadable) errors.add(file.unreadable)
  if (errors.total) return { summary: summary(), records, unreadable: true }

  // Contacts: one per Record ID, with a name or a phone.
  const contacts = new Map<string, ContactRow>()
  const contactIdsInFile = new Set<string>()
  /** Contacts whose row has an error, by id: a deal that names one comes in without it (M-6). */
  const badContactRows = new Map<string, number>()
  for (const row of contactsFile.rows) {
    if ('razon' in row) {
      errors.add({ archivo: 'contactos', fila: row.fila, razon: row.razon })
      continue
    }
    const { fila, values } = row
    const id = values.id?.[0]
    if (!id) {
      errors.add({ archivo: 'contactos', fila, razon: 'Sin Record ID' })
      continue
    }
    if (contactIdsInFile.has(id)) {
      errors.add({ archivo: 'contactos', fila, razon: `El Record ID ${id} se repite en el archivo` })
      continue
    }
    contactIdsInFile.add(id)
    const person = [values.firstName?.[0], values.lastName?.[0]].filter(Boolean).join(' ') || null
    const company = values.company?.[0] ?? null
    // Every phone of the recognized columns (ruling 65 d): «Phone Number» and «Mobile Phone Number» are both the person's.
    const rawPhones = values.phone ?? []
    const phones = [...new Set(rawPhones.flatMap(raw => canonicalPhoneE164(raw) ?? []))]
    if (!person && !company && !phones.length) {
      errors.add({ archivo: 'contactos', fila, razon: 'Sin nombre ni teléfono' })
      badContactRows.set(id, fila)
      continue
    }
    for (const raw of rawPhones) {
      if (canonicalPhoneE164(raw)) continue
      avisos.add(`Contactos, fila ${fila}: el teléfono «${raw}» no es válido; entra sin ${phones.length ? 'ese ' : ''}teléfono`)
    }
    contacts.set(id, { id, person, company, phones, email: values.email?.[0]?.toLowerCase() ?? null })
  }

  // Deals. Their contacts — named by ANY deal row, even one with an error — never get an account of their own: when the
  // deal comes in, they go inside it (ruling 33).
  const inDeals = new Set<string>()
  const deals: { fila: number; id: string; name: string; stage: string; contactIds: string[] }[] = []
  const dealIds = new Set<string>()
  for (const row of dealsFile.rows) {
    if ('razon' in row) {
      errors.add({ archivo: 'negocios', fila: row.fila, razon: row.razon })
      continue
    }
    const { fila, values } = row
    // The same id twice («1;1») is one person (Codex exhaustiva #8).
    const contactIds = [...new Set((values.contactIds ?? []).flatMap(cell => cell.split(/[;,\s]+/)).filter(Boolean))]
    for (const contactId of contactIds) inDeals.add(contactId)
    const id = values.id?.[0]
    const name = values.name?.[0]
    if (!id) errors.add({ archivo: 'negocios', fila, razon: 'Sin Record ID' })
    else if (dealIds.has(id)) errors.add({ archivo: 'negocios', fila, razon: `El Record ID ${id} se repite en el archivo` })
    else if (!name) errors.add({ archivo: 'negocios', fila, razon: 'Sin nombre del negocio' })
    else deals.push({ fila, id, name, stage: values.stage?.[0] ?? '', contactIds })
    if (id) dealIds.add(id)
  }
  const alone = [...contacts.values()].filter(contact => !inDeals.has(contact.id))
  counts.contactosDeNegocios = contacts.size - alone.length

  const [stages, reasons, initial, existing, known] = await Promise.all([
    listStages(),
    listLostReasons(),
    getInitialStage(),
    existingKeys([...deals.map(deal => dealKey(deal.id)), ...alone.map(contact => contactKey(contact.id))]),
    knownEmailsAndPhones([...contacts.values()]),
  ])
  // Ruling 36 (ruling 33 as written): a deal with someone already in the CRM is «repetido» — the person, and the account
  // they are in, for its aviso.
  const alreadyIn = new Map<string, { person: ContactRow; accountId: string }>()
  for (const deal of deals) {
    if (existing.has(dealKey(deal.id))) continue
    const hit = firstKnown(
      known,
      deal.contactIds.flatMap(contactId => contacts.get(contactId) ?? []),
    )
    if (hit) alreadyIn.set(deal.id, { person: hit.person, accountId: hit.value })
  }
  const names = await accountNames([...alreadyIn.values()].map(({ accountId }) => accountId))
  // An admin may have renamed them: «Ganado» and «Perdido» by their kind, the open ones by name (listStages: by order).
  const wonStage = stages.find(stage => stage.kind === 'GANADA')
  const lostStage = stages.find(stage => stage.kind === 'PERDIDA')
  const lostReason =
    reasons.find(reason => reason.active && normalize(reason.name) === normalize(LOST_REASON)) ?? reasons.find(reason => reason.active)
  const stageOf = (name: string) => {
    const wanted = normalize(name)
    return (
      stages.find(stage => normalize(stage.name) === wanted) ??
      (WON_STAGES.includes(wanted) ? wonStage : LOST_STAGES.includes(wanted) ? lostStage : undefined)
    )
  }
  // Ruling 65 (a) within these files: who an earlier record already brings — one person, one account in one import too.
  const claimed = new Map<string, string>()
  const claim = (people: ContactRow[], name: string) => {
    for (const key of people.flatMap(identityOf)) if (!claimed.has(key)) claimed.set(key, name)
  }
  // Ruling 28: everything comes in with today's date.
  const now = new Date()

  for (const deal of deals) {
    const externalKey = dealKey(deal.id)
    if (existing.has(externalKey)) {
      counts.repetidos++
      continue
    }
    const where = `Negocios, fila ${deal.fila}: «${deal.name}»`
    const people = deal.contactIds.flatMap(contactId => contacts.get(contactId) ?? [])
    const already = alreadyIn.get(deal.id)
    if (already) {
      // Nothing of it is written, and nothing of the account that is already there is touched.
      counts.repetidos++
      const place = `está en el CRM en «${names.get(already.accountId) ?? 'otro negocio'}» (${already.accountId})`
      avisos.add(repeatedDeal(where, already.person, place, stageText(deal.stage)))
      continue
    }
    const sameFile = firstKnown(claimed, people)
    if (sameFile) {
      counts.repetidos++
      avisos.add(repeatedDeal(where, sameFile.person, `viene en «${sameFile.value}» de este mismo archivo`, stageText(deal.stage)))
      continue
    }
    // Once the deal is in, it is «repetido»: importing again could never add a person it came in without.
    for (const contactId of deal.contactIds) {
      if (contacts.has(contactId)) continue
      const badRow = badContactRows.get(contactId)
      avisos.add(
        badRow
          ? `${where} entra sin el contacto ${contactId} (contactos, fila ${badRow}, con error); corrígelo antes de aplicar: después ya no se agrega`
          : `${where} entra sin el contacto ${contactId}, que no viene en el archivo de contactos; después ya no se agrega`,
      )
    }
    let stage: { id: string; name: string; kind?: string } | undefined = stageOf(deal.stage)
    if (!stage) {
      stage = initial
      const what = deal.stage ? `está en la etapa «${deal.stage}», que no existe en el CRM` : 'no trae etapa'
      avisos.add(`${where} ${what}; entra en «${initial.name}»`)
    }
    const data: UpsertBySourceInput['data'] = { name: deal.name, stageId: stage.id, sourceDetail: { origen: 'HubSpot', recordId: deal.id } }
    // «Ganado» without its Organization: the seller links it with «Ganar» (win() asks for one, so it is not used here).
    if (stage.kind === 'GANADA') data.wonAt = now
    if (stage.kind === 'PERDIDA') Object.assign(data, { lostAt: now, lostReasonId: lostReason?.id ?? null })
    records.push({
      externalKey,
      data,
      contacts: people.flatMap((contact, index) => peopleOf(contact, index === 0)),
      stageName: stage.name,
      won: stage.kind === 'GANADA',
      deal: { where, hubspotStage: stageText(deal.stage) },
    })
    claim(people, deal.name)
    counts.negocios++
  }

  for (const contact of alone) {
    const externalKey = contactKey(contact.id)
    if (existing.has(externalKey) || firstKnown(known, [contact]) || firstKnown(claimed, [contact])) {
      counts.repetidos++
      continue
    }
    records.push({
      externalKey,
      data: {
        name: contact.company || contact.person || contact.phones[0] || '',
        stageId: initial.id,
        archivedAt: now,
        sourceDetail: { origen: 'HubSpot', recordId: contact.id },
      },
      contacts: peopleOf(contact, true),
      stageName: initial.name,
      won: false,
    })
    claim([contact], contact.company || contact.person || contact.phones[0] || '')
    counts.archivados++
  }

  counts.nuevos = counts.negocios + counts.archivados
  return { summary: summary(), records, unreadable: false }
}

// ── Preview and apply ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What importing these two files would do: new, repeated and rows with an error, listed. Writes nothing. */
export async function previewHubspot(contactsCsv: string, dealsCsv: string): Promise<HubspotPreview> {
  return (await plan(contactsCsv, dealsCsv)).summary
}

/** What writing one record did: created it, found its key already imported, or found its person already in the CRM. */
type Written = { created: true } | { created: false; repeatedIn: string | null }

/**
 * Creates ONE account, unless the CRM already has it — its key (another import got there first, or an earlier run of
 * this one) or one of its people, asked again here through the resolver every writer shares (ruling 65 a): the landing,
 * WhatsApp or another record may have brought that person since the plan was read. Then nothing is written. Its people
 * go in only with the account, each through the same incorporation as everywhere (`addPersonTx`), never twice.
 */
async function createTx(tx: Prisma.TransactionClient, record: PlannedAccount, actorStaffId: string): Promise<Written> {
  const [primary, ...others] = record.contacts
  const values = (pick: (contact: ContactInput) => string | null | undefined) => [
    ...new Set(record.contacts.flatMap(contact => pick(contact) ?? [])),
  ]
  const { account, created, via } = await accountForTx(
    tx,
    { emails: values(contact => contact.email), phones: values(contact => contact.phoneE164), organizationId: null },
    { source: IMPORTACION, externalKey: record.externalKey, data: record.data, contact: primary },
  )
  if (!created) return { created: false, repeatedIn: via === 'KEY' ? null : account.id }
  for (const contact of others) {
    await addPersonTx(tx, account.id, { name: contact.name, email: contact.email ?? null, phoneE164: contact.phoneE164 ?? null })
  }
  await addEvent(tx, {
    accountId: account.id,
    kind: 'SYSTEM',
    actorStaffId,
    sourceKey: `import:${record.externalKey}`,
    data: { event: 'CREATED', source: IMPORTACION, via: IMPORTACION, externalKey: record.externalKey, stage: record.stageName },
  })
  if (record.won) await addEvent(tx, { accountId: account.id, kind: 'NOTE', actorStaffId: null, data: { text: WON_NOTE } })
  return { created: true }
}

/**
 * Imports the two files: the same plan as the preview, in batches of 200 records per transaction. Idempotent by key and
 * by person: a second run — or one at the same time — creates nothing the first one did. An unreadable file is a 422
 * before anything is written. The answer carries the preview's counts plus what this run created (`aplicados`) and what
 * failed; a deal whose person reached the CRM between the plan and the write adds its aviso (ruling 36).
 *
 * ponytail: the whole import runs inside the one HTTP request, ~6–8 sequential queries per record. Today (~1k records)
 * that is seconds; a full 5 MB file (~25k contacts) is minutes. Nothing is lost if the client gives up — the server
 * finishes, and importing the same files again completes whatever did not land — so for a one-time admin import that is
 * enough. Upgrade path: a background job with progress, like the exports.
 */
export async function applyHubspot(actor: CrmAccess, contactsCsv: string, dealsCsv: string): Promise<HubspotApplied> {
  const { summary, records, unreadable } = await plan(contactsCsv, dealsCsv)
  if (unreadable) {
    const reasons = summary.conError.map(error => `${error.archivo}: ${error.razon}`).join('; ')
    throw new ValidationError(`No se puede importar. ${reasons}`, 'CRM_IMPORT_ARCHIVO_INVALIDO', { conError: summary.conError })
  }

  let aplicados = 0
  let fallaron = 0
  const repeatedDeals: Array<{ deal: NonNullable<PlannedAccount['deal']>; accountId: string }> = []
  for (const batch of chunksOf(records, BATCH)) {
    try {
      const written = await prisma.$transaction(async tx => {
        const results: Array<{ record: PlannedAccount; result: Written }> = []
        for (const record of batch) results.push({ record, result: await createTx(tx, record, actor.staffId) })
        return results
      }, BATCH_TX)
      for (const { record, result } of written) {
        if (result.created) aplicados++
        else if (result.repeatedIn && record.deal) repeatedDeals.push({ deal: record.deal, accountId: result.repeatedIn })
      }
    } catch (error) {
      fallaron += batch.length
      logger.error('[CRM] A batch of the HubSpot import failed; importing the same files again completes it', {
        firstKey: batch[0].externalKey,
        size: batch.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const names = await accountNames(repeatedDeals.map(({ accountId }) => accountId))
  const lateAvisos = repeatedDeals.map(
    ({ deal, accountId }) =>
      `${deal.where} no entra (ni sus contactos): alguien de él llegó al CRM mientras se importaba, en «${names.get(accountId) ?? 'otro negocio'}» (${accountId}); en HubSpot estaba en ${deal.hubspotStage}, ajústalo a mano`,
  )

  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_HUBSPOT_IMPORTED',
    entity: 'CrmAccount',
    data: {
      nuevos: summary.nuevos,
      repetidos: summary.repetidos,
      conError: summary.conErrorTotal,
      negocios: summary.negocios,
      archivados: summary.archivados,
      aplicados,
      fallaron,
    },
  })
  return {
    ...summary,
    avisos: [...summary.avisos, ...lateAvisos].slice(0, LIST_CAP),
    avisosTotal: summary.avisosTotal + lateAvisos.length,
    aplicados,
    fallaron,
  }
}
