/**
 * «Importar lo de HubSpot», una sola vez (spec 2026-10-30 §5.3.4; rulings 4, 28, 30 and 33).
 *
 * Specific to HubSpot's export, not a general column mapper: a contacts file and a deals file, their headers read
 * without case or accents and with a few aliases (ruling 4). Every record enters with its key — `hubspot:deal:<id>` or
 * `hubspot:contact:<id>` — through `upsertAccountBySource`, so importing the same files twice, one after the other or
 * both at once, never duplicates an account.
 *
 * - A deal enters «Sin dueño», with its stage by name and its associated contacts inside (the first one, primary).
 *   «Cerrado Ganado» → «Ganado» without an Organization, with a note to link it; «Cerrado Perdido» → «Perdido» for
 *   «Dijo que no». Nothing is linked to an Organization: only the landing links by itself (ruling 28).
 * - A contact without a deal enters ARCHIVED and «Sin dueño» (ruling 30): out of the pipeline and the digest, found by a
 *   search.
 * - «Repetido» (ruling 33): its key is already in the CRM — or, for a contact without a deal, its email or phone already
 *   is (it came through the landing or by hand). It is counted and never touched.
 *
 * A file that cannot be read — empty, or missing a column the import needs — is refused whole, before anything is
 * written. The preview writes nothing; applying runs the same plan in batches of 200 records per transaction, and a
 * batch that fails keeps the earlier ones: importing the same files again completes it.
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
import { cleanText, upsertAccountBySource, type UpsertBySourceInput } from './inbound.service'
import { addEvent } from './timeline.service'

const IMPORTACION = 'IMPORTACION'
/** Records per transaction: a failure costs one batch, never the ones before it. */
const BATCH = 200
const BATCH_TX = { maxWait: 10_000, timeout: 60_000 }
/** Keys, emails or phones per lookup query. */
const LOOKUP_CHUNK = 1000
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
  conError: ImportError[]
  /** New deals, in the pipeline. */
  negocios: number
  /** New contacts without a deal, archived. */
  archivados: number
  /** Contacts that go inside their deal's account instead of getting their own. */
  contactosDeNegocios: number
  /** What enters differently from the file: a stage the CRM lacks, a phone that is not one, a contact not in the file. */
  avisos: string[]
  columnasIgnoradas: Record<Archivo, string[]>
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

const PARSE_ERRORS: Record<string, string> = { MissingQuotes: 'Tiene comillas sin cerrar', InvalidQuotes: 'Tiene comillas mal puestas' }

type Values<F extends string> = Partial<Record<F, string>>

interface CsvFile<F extends string> {
  rows: { fila: number; values: Values<F> }[]
  errors: ImportError[]
  /** The whole file is unreadable: nothing of either file is imported. */
  unreadable: boolean
  ignored: string[]
}

/**
 * The rows of one file, each cell cleaned like the landing's (no NUL or control characters, at most 500 characters).
 * Empty rows are skipped; a row Papa could not read, or with a different number of columns than the header — an
 * unquoted comma that shifted every cell after it — is an error, never a guess.
 */
function readCsv<F extends string>(csv: string, archivo: Archivo, columns: Record<F, string[]>, required: NoInfer<F>[]): CsvFile<F> {
  // Without a header row: Papa's row numbers then match the spreadsheet's, header included. It strips the BOM itself.
  const { data, errors: parseErrors } = Papa.parse<string[]>(csv, { skipEmptyLines: false })
  const [header = [], ...lines] = data
  const fields = Object.keys(columns) as F[]
  // Cleaned (at most 500 characters) before anything else: a file that is not a CSV can be one 5 MB header cell.
  const names = header.map(cleanText)
  const fieldAt = names.map(name => {
    const wanted = normalize(name)
    return fields.find(field => columns[field].some(alias => normalize(alias) === wanted)) ?? null
  })
  const ignored = names.filter((name, column) => name && !fieldAt[column])
  const unreadable = (razon: string): CsvFile<F> => ({ rows: [], errors: [{ archivo, fila: 1, razon }], unreadable: true, ignored })

  if (!names.some(Boolean)) return unreadable('El archivo está vacío')
  const missing = required.find(field => !fieldAt.includes(field))
  if (missing) return unreadable(`Falta la columna «${columns[missing][0]}»`)

  const broken = new Map<number, string>()
  for (const error of parseErrors) {
    if (error.row !== undefined && !broken.has(error.row + 1)) broken.set(error.row + 1, PARSE_ERRORS[error.code] ?? 'No se pudo leer')
  }
  const rows: CsvFile<F>['rows'] = []
  const errors: ImportError[] = []
  lines.forEach((line, index) => {
    const fila = index + 2
    if (line.every(cell => !cleanText(cell))) return
    const razon =
      broken.get(fila) ?? (line.length !== header.length ? `Tiene ${line.length} columnas y el encabezado ${header.length}` : null)
    if (razon) {
      errors.push({ archivo, fila, razon })
      return
    }
    const values: Values<F> = {}
    line.forEach((cell, column) => {
      const field = fieldAt[column]
      const text = cleanText(cell)
      if (field && text && !values[field]) values[field] = text
    })
    rows.push({ fila, values })
  })
  return { rows, errors, unreadable: false, ignored }
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ContactRow {
  id: string
  person: string | null
  company: string | null
  phoneE164: string | null
  email: string | null
}

type ContactInput = NonNullable<UpsertBySourceInput['contact']>

interface PlannedAccount {
  externalKey: string
  data: UpsertBySourceInput['data']
  /** The first one is the primary person. */
  contacts: ContactInput[]
  stageName: string
  won: boolean
}

const dealKey = (id: string) => `hubspot:deal:${id}`
const contactKey = (id: string) => `hubspot:contact:${id}`

const contactInput = (contact: ContactRow, isPrimary: boolean): ContactInput => ({
  name: contact.person || contact.company || contact.phoneE164 || '',
  phoneE164: contact.phoneE164,
  email: contact.email,
  isPrimary,
})

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
 * The emails and phones a person who came in some OTHER way — the landing, by hand — already has (ruling 33). Never
 * this import's own: after a crash, a contact sharing a phone with a deal the first run already wrote would otherwise
 * turn «repetido» and never come in. One set for both: an email has an «@» and an E.164 phone never does. GROUP BY
 * gives each value once, however many people share it; every CRM writer stores emails in lowercase (the landing,
 * «Nuevo prospecto», this import), so the exact match uses the index.
 */
async function knownEmailsAndPhones(contacts: ContactRow[]): Promise<Set<string>> {
  const emails = [...new Set(contacts.flatMap(contact => (contact.email ? [contact.email] : [])))]
  const phones = [...new Set(contacts.flatMap(contact => (contact.phoneE164 ? [contact.phoneE164] : [])))]
  const notImported = { source: { not: IMPORTACION } }
  const found = new Set<string>()
  for (const chunk of chunksOf(emails, LOOKUP_CHUNK)) {
    const rows = await prisma.crmContact.groupBy({ by: ['email'], where: { email: { in: chunk }, account: notImported } })
    for (const { email } of rows) if (email) found.add(email)
  }
  for (const chunk of chunksOf(phones, LOOKUP_CHUNK)) {
    const rows = await prisma.crmContact.groupBy({ by: ['phoneE164'], where: { phoneE164: { in: chunk }, account: notImported } })
    for (const { phoneE164 } of rows) if (phoneE164) found.add(phoneE164)
  }
  return found
}

const isKnown = (known: Set<string>, contact: ContactRow) =>
  (!!contact.email && known.has(contact.email)) || (!!contact.phoneE164 && known.has(contact.phoneE164))

/** What the two files would do to the CRM now, and the accounts to create. Reads; never writes. */
async function plan(contactsCsv: string, dealsCsv: string) {
  const contactsFile = readCsv(contactsCsv, 'contactos', CONTACT_COLUMNS, ['id'])
  const dealsFile = readCsv(dealsCsv, 'negocios', DEAL_COLUMNS, ['id', 'name', 'stage', 'contactIds'])
  const summary: HubspotPreview = {
    nuevos: 0,
    repetidos: 0,
    conError: [...contactsFile.errors, ...dealsFile.errors],
    negocios: 0,
    archivados: 0,
    contactosDeNegocios: 0,
    avisos: [],
    columnasIgnoradas: { contactos: contactsFile.ignored, negocios: dealsFile.ignored },
  }
  const records: PlannedAccount[] = []
  if (contactsFile.unreadable || dealsFile.unreadable) return { summary, records, unreadable: true }
  const rowError = (archivo: Archivo, fila: number, razon: string) => summary.conError.push({ archivo, fila, razon })

  // Contacts: one per Record ID, with a name or a phone.
  const contacts = new Map<string, ContactRow>()
  const contactIdsInFile = new Set<string>()
  for (const { fila, values } of contactsFile.rows) {
    const id = values.id
    if (!id) {
      rowError('contactos', fila, 'Sin Record ID')
      continue
    }
    if (contactIdsInFile.has(id)) {
      rowError('contactos', fila, `El Record ID ${id} se repite en el archivo`)
      continue
    }
    contactIdsInFile.add(id)
    const person = [values.firstName, values.lastName].filter(Boolean).join(' ') || null
    const company = values.company ?? null
    const phoneE164 = values.phone ? canonicalPhoneE164(values.phone) : null
    if (!person && !company && !phoneE164) {
      rowError('contactos', fila, 'Sin nombre ni teléfono')
      continue
    }
    if (values.phone && !phoneE164)
      summary.avisos.push(`Contactos, fila ${fila}: el teléfono «${values.phone}» no es válido; entra sin teléfono`)
    contacts.set(id, { id, person, company, phoneE164, email: values.email?.toLowerCase() ?? null })
  }

  // Deals. Their contacts — named by ANY deal row, even one with an error — never get an account of their own: when the
  // deal comes in, they go inside it (ruling 33).
  const inDeals = new Set<string>()
  const deals: { fila: number; id: string; name: string; stage: string; contactIds: string[] }[] = []
  const dealIds = new Set<string>()
  for (const { fila, values } of dealsFile.rows) {
    const contactIds = (values.contactIds ?? '').split(/[;,\s]+/).filter(Boolean)
    for (const contactId of contactIds) inDeals.add(contactId)
    const id = values.id
    if (!id) rowError('negocios', fila, 'Sin Record ID')
    else if (dealIds.has(id)) rowError('negocios', fila, `El Record ID ${id} se repite en el archivo`)
    else if (!values.name) rowError('negocios', fila, 'Sin nombre del negocio')
    else deals.push({ fila, id, name: values.name, stage: values.stage ?? '', contactIds })
    if (id) dealIds.add(id)
  }
  const alone = [...contacts.values()].filter(contact => !inDeals.has(contact.id))
  summary.contactosDeNegocios = contacts.size - alone.length

  const [stages, reasons, initial, existing, known] = await Promise.all([
    listStages(),
    listLostReasons(),
    getInitialStage(),
    existingKeys([...deals.map(deal => dealKey(deal.id)), ...alone.map(contact => contactKey(contact.id))]),
    knownEmailsAndPhones([...contacts.values()]),
  ])
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
  // Ruling 28: everything comes in with today's date.
  const now = new Date()

  for (const deal of deals) {
    const externalKey = dealKey(deal.id)
    if (existing.has(externalKey)) {
      summary.repetidos++
      continue
    }
    let stage: { id: string; name: string; kind?: string } | undefined = stageOf(deal.stage)
    if (!stage) {
      stage = initial
      const what = deal.stage ? `está en la etapa «${deal.stage}», que no existe en el CRM` : 'no trae etapa'
      summary.avisos.push(`Negocios, fila ${deal.fila}: «${deal.name}» ${what}; entra en «${initial.name}»`)
    }
    const people = deal.contactIds.flatMap(contactId => {
      const contact = contacts.get(contactId)
      // A contact whose row has an error is already listed in `conError`.
      if (!contact && !contactIdsInFile.has(contactId)) {
        summary.avisos.push(`Negocios, fila ${deal.fila}: el contacto ${contactId} de «${deal.name}» no viene en el archivo de contactos`)
      }
      return contact ? [contact] : []
    })
    // A deal is «repetido» only by its key (ruling 33); someone already in the CRM is said, for the team to merge.
    if (people.some(contact => isKnown(known, contact))) {
      summary.avisos.push(`Negocios, fila ${deal.fila}: alguien de «${deal.name}» ya está en el CRM; entra como negocio aparte`)
    }
    const data: UpsertBySourceInput['data'] = { name: deal.name, stageId: stage.id, sourceDetail: { origen: 'HubSpot', recordId: deal.id } }
    // «Ganado» without its Organization: the seller links it with «Ganar» (win() asks for one, so it is not used here).
    if (stage.kind === 'GANADA') data.wonAt = now
    if (stage.kind === 'PERDIDA') Object.assign(data, { lostAt: now, lostReasonId: lostReason?.id ?? null })
    records.push({
      externalKey,
      data,
      contacts: people.map((contact, index) => contactInput(contact, index === 0)),
      stageName: stage.name,
      won: stage.kind === 'GANADA',
    })
    summary.negocios++
  }

  for (const contact of alone) {
    const externalKey = contactKey(contact.id)
    if (existing.has(externalKey) || isKnown(known, contact)) {
      summary.repetidos++
      continue
    }
    records.push({
      externalKey,
      data: {
        name: contact.company || contact.person || contact.phoneE164 || '',
        stageId: initial.id,
        archivedAt: now,
        sourceDetail: { origen: 'HubSpot', recordId: contact.id },
      },
      contacts: [contactInput(contact, true)],
      stageName: initial.name,
      won: false,
    })
    summary.archivados++
  }

  summary.nuevos = summary.negocios + summary.archivados
  summary.conError.sort((a, b) => a.archivo.localeCompare(b.archivo) || a.fila - b.fila)
  return { summary, records, unreadable: false }
}

// ── Preview and apply ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What importing these two files would do: new, repeated and rows with an error, listed. Writes nothing. */
export async function previewHubspot(contactsCsv: string, dealsCsv: string): Promise<HubspotPreview> {
  return (await plan(contactsCsv, dealsCsv)).summary
}

/**
 * Creates ONE account, unless its key already has one — another import got there first, or an earlier run of this one
 * — and then writes nothing else. Its people and its events go in only with the account.
 */
async function createTx(tx: Prisma.TransactionClient, record: PlannedAccount, actorStaffId: string): Promise<boolean> {
  const [primary, ...others] = record.contacts
  const { account, created } = await upsertAccountBySource(tx, {
    source: IMPORTACION,
    externalKey: record.externalKey,
    data: record.data,
    contact: primary,
  })
  if (!created) return false
  if (others.length) await tx.crmContact.createMany({ data: others.map(contact => ({ ...contact, accountId: account.id })) })
  await addEvent(tx, {
    accountId: account.id,
    kind: 'SYSTEM',
    actorStaffId,
    sourceKey: `import:${record.externalKey}`,
    data: { event: 'CREATED', source: IMPORTACION, via: IMPORTACION, externalKey: record.externalKey, stage: record.stageName },
  })
  if (record.won) await addEvent(tx, { accountId: account.id, kind: 'NOTE', actorStaffId: null, data: { text: WON_NOTE } })
  return true
}

/**
 * Imports the two files: the same plan as the preview, in batches of 200 records per transaction. Idempotent by key: a
 * second run — or one at the same time — creates nothing the first one did. An unreadable file is a 422 before anything
 * is written. The answer carries the preview's counts plus what this run created (`aplicados`) and what failed.
 */
export async function applyHubspot(actor: CrmAccess, contactsCsv: string, dealsCsv: string): Promise<HubspotApplied> {
  const { summary, records, unreadable } = await plan(contactsCsv, dealsCsv)
  if (unreadable) {
    const reasons = summary.conError.map(error => `${error.archivo}: ${error.razon}`).join('; ')
    throw new ValidationError(`No se puede importar. ${reasons}`, 'CRM_IMPORT_ARCHIVO_INVALIDO', { conError: summary.conError })
  }

  let aplicados = 0
  let fallaron = 0
  for (const batch of chunksOf(records, BATCH)) {
    try {
      aplicados += await prisma.$transaction(async tx => {
        let created = 0
        for (const record of batch) if (await createTx(tx, record, actor.staffId)) created++
        return created
      }, BATCH_TX)
    } catch (error) {
      fallaron += batch.length
      logger.error('[CRM] A batch of the HubSpot import failed; importing the same files again completes it', {
        firstKey: batch[0].externalKey,
        size: batch.length,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  void logAction({
    staffId: actor.staffId,
    venueId: null,
    action: 'CRM_HUBSPOT_IMPORTED',
    entity: 'CrmAccount',
    data: {
      nuevos: summary.nuevos,
      repetidos: summary.repetidos,
      conError: summary.conError.length,
      negocios: summary.negocios,
      archivados: summary.archivados,
      aplicados,
      fallaron,
    },
  })
  return { ...summary, aplicados, fallaron }
}
