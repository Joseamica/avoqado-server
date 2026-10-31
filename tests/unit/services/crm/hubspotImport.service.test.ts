/**
 * «Importar lo de HubSpot», una sola vez (spec 2026-10-30 §5.3.4, plan task 8, rulings 4, 28, 30 and 33).
 *
 * What these pin beyond the happy path: the preview writes nothing and its counts add up; importing the same files
 * twice — one after the other, or both at once — leaves one account per HubSpot id; a contact already in the CRM is
 * «repetido» and is never touched; a deal's contacts go inside the deal's account instead of getting their own; a bad
 * file is refused whole, before anything is written; and a batch that fails keeps what the earlier batches wrote, so
 * importing again completes it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { prismaMock } from '@tests/__helpers__/setup'
import { FAKE_STAGE_ID, installCrmInboundFake } from '@tests/__helpers__/crmInboundFake'
import { logAction } from '@/services/dashboard/activity-log.service'
import type { CrmAccess } from '@/services/crm/access.service'
import { applyHubspot, previewHubspot } from '@/services/crm/hubspotImport.service'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const CONTACTS = fixture('hubspot-contacts.csv')
const DEALS = fixture('hubspot-deals.csv')
/** A deals file with its columns and no deal. */
const NO_DEALS = 'Record ID,Deal Name,Deal Stage,Associated Contact IDs\n'
const CONTACTS_HEADER = 'Record ID,First Name,Last Name,Phone Number,Email,Company Name\n'

const ADMIN = 'cstaffadm0000000000000009'
const PROSPECTO = FAKE_STAGE_ID
const CONTACTO_INICIAL = 'cstagecin0000000000000001'
const GANADO = 'cstagegan0000000000000001'
const PERDIDO = 'cstageper0000000000000001'
const DIJO_QUE_NO = 'creasondqn000000000000001'
const PRECIO = 'creasonpre000000000000001'

const STAGES = [
  { id: PROSPECTO, name: 'Prospecto', order: 1, kind: 'ABIERTA', staleDays: 2 },
  { id: CONTACTO_INICIAL, name: 'Contacto inicial', order: 2, kind: 'ABIERTA', staleDays: 3 },
  { id: 'cstagecal0000000000000001', name: 'Calificado', order: 3, kind: 'ABIERTA', staleDays: 5 },
  { id: GANADO, name: 'Ganado', order: 6, kind: 'GANADA', staleDays: null },
  { id: PERDIDO, name: 'Perdido', order: 7, kind: 'PERDIDA', staleDays: null },
]
const REASONS = [
  { id: DIJO_QUE_NO, name: 'Dijo que no', active: true },
  { id: PRECIO, name: 'Precio', active: true },
]

const admin: CrmAccess = {
  staffId: ADMIN,
  isSuperadmin: false,
  ver: null,
  editar: null,
  contactar: false,
  campanas: false,
  exportar: false,
  ventas: false,
  admin: true,
}

let db: ReturnType<typeof installCrmInboundFake>

const accountOf = (externalKey: string) => db.accounts.find(account => account.externalKey === externalKey)
const contactsOf = (accountId: string) => db.contacts.filter(contact => contact.accountId === accountId)

beforeEach(() => {
  db = installCrmInboundFake(prismaMock)
  for (const fn of [
    prismaMock.crmAccount.findMany,
    prismaMock.crmContact.groupBy,
    prismaMock.crmContact.createMany,
    prismaMock.crmStage.findMany,
    prismaMock.crmLostReason.findMany,
  ])
    fn.mockReset()
  prismaMock.crmStage.findMany.mockResolvedValue(STAGES)
  prismaMock.crmLostReason.findMany.mockResolvedValue(REASONS)
  // The accounts this import already created, by their HubSpot key.
  prismaMock.crmAccount.findMany.mockImplementation(async ({ where }: any) =>
    db.accounts
      .filter(account => account.source === where.source && where.externalKey.in.includes(account.externalKey))
      .map(account => ({ externalKey: account.externalKey })),
  )
  // GROUP BY one column: each value once, whatever the number of people that share it — of accounts NOT of this import.
  prismaMock.crmContact.groupBy.mockImplementation(async ({ by: [field], where }: any) => {
    const sourceOf = (contact: any) => db.accounts.find(account => account.id === contact.accountId)?.source
    const others = db.contacts.filter(contact => sourceOf(contact) !== where.account.source.not)
    return [...new Set(others.map(contact => contact[field]).filter(value => value && where[field].in.includes(value)))].map(value => ({
      [field]: value,
    }))
  })
  prismaMock.crmContact.createMany.mockImplementation(async ({ data }: any) => {
    db.contacts.push(...data)
    return { count: data.length }
  })
  // A transaction that fails leaves nothing behind, like Postgres: what it appended is cut off again.
  prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    const before = { accounts: db.accounts.length, contacts: db.contacts.length, events: db.events.length }
    try {
      return await callback(prismaMock)
    } catch (error) {
      db.accounts.length = before.accounts
      db.contacts.length = before.contacts
      db.events.length = before.events
      throw error
    }
  })
})

it('vista_previa_cuenta_bien', async () => {
  const preview = await previewHubspot(CONTACTS, DEALS)

  expect(preview).toMatchObject({
    nuevos: 8,
    repetidos: 0,
    negocios: 2,
    archivados: 6,
    // Ana and Beto go inside «Café Ana», Carla inside «Tienda Carla».
    contactosDeNegocios: 3,
    conError: [{ archivo: 'contactos', fila: 11, razon: 'Sin nombre ni teléfono' }],
    columnasIgnoradas: { contactos: ['Lifecycle Stage'], negocios: ['Deal owner'] },
  })
  // 10 contacts: 6 archived + 3 inside a deal + 1 with an error.
  expect(preview.archivados + preview.contactosDeNegocios + preview.conError.length).toBe(10)
  // A preview writes nothing.
  expect(db.accounts).toHaveLength(0)
  expect(prismaMock.crmAccount.createMany).not.toHaveBeenCalled()
})

it('importar_dos_veces_no_duplica', async () => {
  const first = await applyHubspot(admin, CONTACTS, DEALS)
  expect(first).toMatchObject({ nuevos: 8, repetidos: 0, aplicados: 8, fallaron: 0 })
  const after = { accounts: db.accounts.length, contacts: db.contacts.length, events: db.events.length }
  // 2 deals + 6 archived contacts; 3 people inside the deals + 6; one creation event each + the «Ganado» note.
  expect(after).toEqual({ accounts: 8, contacts: 9, events: 9 })

  const second = await applyHubspot(admin, CONTACTS, DEALS)
  expect(second).toMatchObject({ nuevos: 0, repetidos: 8, negocios: 0, archivados: 0, aplicados: 0, fallaron: 0 })
  expect({ accounts: db.accounts.length, contacts: db.contacts.length, events: db.events.length }).toEqual(after)

  // Every applied import goes to the audit trail, with who did it and what it did.
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      staffId: ADMIN,
      venueId: null,
      action: 'CRM_HUBSPOT_IMPORTED',
      entity: 'CrmAccount',
      data: expect.objectContaining({ nuevos: 8, aplicados: 8, repetidos: 0, conError: 1 }),
    }),
  )
})

it('importar_dos_veces_a_la_vez_no_duplica', async () => {
  const [a, b] = await Promise.all([applyHubspot(admin, CONTACTS, DEALS), applyHubspot(admin, CONTACTS, DEALS)])

  // Both read an empty CRM; the unique (source, externalKey) lets only one of them create each account.
  expect(a.aplicados + b.aplicados).toBe(8)
  expect(db.accounts).toHaveLength(8)
  expect(db.contacts).toHaveLength(9)
  expect(db.events.filter(event => event.kind === 'SYSTEM')).toHaveLength(8)
})

it('sin_negocio_entra_archivado', async () => {
  await applyHubspot(admin, CONTACTS, DEALS)

  const dani = accountOf('hubspot:contact:104')
  expect(dani).toMatchObject({
    source: 'IMPORTACION',
    name: 'Estética Dani',
    stageId: PROSPECTO,
    archivedAt: expect.any(Date),
  })
  // «Sin dueño», and no Organization: only the landing links by itself (ruling 28).
  expect(dani!.ownerStaffId ?? null).toBeNull()
  expect(dani!.organizationId ?? null).toBeNull()
  expect(contactsOf(dani!.id)).toEqual([
    expect.objectContaining({ name: 'Dani Soto', phoneE164: '+525512345604', email: 'dani@x.mx', isPrimary: true }),
  ])
  // Without a person's name, the business's; without a business, the person's.
  expect(accountOf('hubspot:contact:106')).toMatchObject({ name: 'Barbería Seis' })
  expect(accountOf('hubspot:contact:105')).toMatchObject({ name: 'Eva Mora' })
  // Its creation event says how it came in, once per HubSpot id.
  expect(db.events).toContainEqual(
    expect.objectContaining({
      accountId: dani!.id,
      kind: 'SYSTEM',
      actorStaffId: ADMIN,
      sourceKey: 'import:hubspot:contact:104',
      data: expect.objectContaining({ event: 'CREATED', via: 'IMPORTACION' }),
    }),
  )
})

it('contacto_de_un_negocio_no_crea_su_propia_cuenta', async () => {
  await applyHubspot(admin, CONTACTS, DEALS)

  for (const id of ['101', '102', '103']) expect(accountOf(`hubspot:contact:${id}`)).toBeUndefined()
  const cafe = accountOf('hubspot:deal:9001')
  // A deal is in the pipeline, not in the archive.
  expect(cafe).toMatchObject({ name: 'Café Ana', stageId: CONTACTO_INICIAL })
  expect(cafe!.archivedAt ?? null).toBeNull()
  // The first associated contact is the primary one. Emails are stored in lowercase, like every CRM writer.
  expect(contactsOf(cafe!.id)).toEqual([
    expect.objectContaining({ name: 'Ana López', phoneE164: '+525512345601', email: 'ana@cafe.mx', isPrimary: true }),
    expect.objectContaining({ name: 'Beto Ruiz', email: 'beto@cafe.mx', isPrimary: false }),
  ])
})

it('fila_sin_nombre_ni_telefono_es_error', async () => {
  const contacts = `${CONTACTS_HEADER}201,,,,nadie@x.mx,\n202,,,12,,\n203,Rosa,,abc,,\n`
  const preview = await previewHubspot(contacts, NO_DEALS)

  expect(preview.conError).toEqual([
    { archivo: 'contactos', fila: 2, razon: 'Sin nombre ni teléfono' },
    // A phone that is not a phone is no phone.
    { archivo: 'contactos', fila: 3, razon: 'Sin nombre ni teléfono' },
  ])
  // A name with a broken phone still comes in, without the phone, and the preview says so.
  expect(preview).toMatchObject({ nuevos: 1, archivados: 1 })
  expect(preview.avisos).toEqual([expect.stringContaining('abc')])

  await applyHubspot(admin, contacts, NO_DEALS)
  expect(db.accounts.map(account => account.externalKey)).toEqual(['hubspot:contact:203'])
  expect(db.contacts).toEqual([expect.objectContaining({ name: 'Rosa', phoneE164: null })])
})

it('archivo_sin_columna_obligatoria_no_importa_nada', async () => {
  // A deals file without its contacts would turn every deal's people into archived accounts of their own.
  const deals = 'Record ID,Deal Name,Deal Stage\n9001,Café Ana,Demo\n'
  const preview = await previewHubspot(CONTACTS, deals)

  expect(preview.conError).toContainEqual({ archivo: 'negocios', fila: 1, razon: 'Falta la columna «Associated Contact IDs»' })
  await expect(applyHubspot(admin, CONTACTS, deals)).rejects.toMatchObject({ statusCode: 422, code: 'CRM_IMPORT_ARCHIVO_INVALIDO' })
  expect(db.accounts).toHaveLength(0)

  // An empty file, or one that is not a CSV, is a preview with an error — never a crash.
  const empty = await previewHubspot('', NO_DEALS)
  expect(empty.conError).toEqual([{ archivo: 'contactos', fila: 1, razon: 'El archivo está vacío' }])
  const binary = await previewHubspot('\u0000\u0001PK\u0003\u0004', NO_DEALS)
  expect(binary.conError).toEqual([{ archivo: 'contactos', fila: 1, razon: 'Falta la columna «Record ID»' }])
})

it('etapas_por_nombre', async () => {
  const deals = [
    'record id,DEAL NAME,Pipeline Stage,Associated Contact IDs',
    '9101,Uno,Contacto Inicial,',
    '9102,Dos,Cerrado Ganado,',
    '9103,Tres,Cerrado Perdido,',
    '9104,Cuatro,Etapa rara,',
    '9105,Cinco,calificado,',
  ].join('\n')
  const preview = await previewHubspot(CONTACTS_HEADER, deals)
  // A stage the CRM does not have goes to the first one, and the preview says so before anything is written.
  expect(preview.avisos).toEqual([expect.stringMatching(/Cuatro.*Etapa rara.*Prospecto/)])

  await applyHubspot(admin, CONTACTS_HEADER, deals)
  expect(accountOf('hubspot:deal:9101')).toMatchObject({ stageId: CONTACTO_INICIAL })
  expect(accountOf('hubspot:deal:9105')).toMatchObject({ stageId: 'cstagecal0000000000000001' })
  expect(accountOf('hubspot:deal:9104')).toMatchObject({ stageId: PROSPECTO })

  // «Cerrado Ganado»: won without an Organization, with the system's note to link it.
  const won = accountOf('hubspot:deal:9102')
  expect(won).toMatchObject({ stageId: GANADO, wonAt: expect.any(Date) })
  expect(won!.organizationId ?? null).toBeNull()
  expect(db.events).toContainEqual(
    expect.objectContaining({
      accountId: won!.id,
      kind: 'NOTE',
      actorStaffId: null,
      data: { text: 'Ganado en HubSpot: falta ligar su negocio de Avoqado' },
    }),
  )

  // «Cerrado Perdido»: lost for «Dijo que no».
  expect(accountOf('hubspot:deal:9103')).toMatchObject({ stageId: PERDIDO, lostAt: expect.any(Date), lostReasonId: DIJO_QUE_NO })
})

it('perdido_usa_el_primer_motivo_activo_si_renombraron_dijo_que_no', async () => {
  prismaMock.crmLostReason.findMany.mockResolvedValue([
    { id: 'creasonold000000000000001', name: 'Ya no', active: false },
    { id: PRECIO, name: 'Precio', active: true },
  ])
  await applyHubspot(admin, CONTACTS_HEADER, `${NO_DEALS}9103,Tres,Closed Lost,\n`)

  expect(accountOf('hubspot:deal:9103')).toMatchObject({ stageId: PERDIDO, lostReasonId: PRECIO })
})

it('repetido_si_su_correo_o_telefono_ya_esta_en_el_crm', async () => {
  // Dani filled the landing; Gil was typed by hand with his phone.
  db.accounts.push(
    { id: 'caccountlnd0000000000001', source: 'LANDING', externalKey: 'dani@x.mx', name: 'Estética Dani', stageId: PROSPECTO },
    { id: 'caccountman0000000000001', source: 'MANUAL', externalKey: null, name: 'Gimnasio Gil', stageId: PROSPECTO },
  )
  db.contacts.push(
    { accountId: 'caccountlnd0000000000001', name: 'Dani Soto', email: 'dani@x.mx', phoneE164: null, isPrimary: true },
    { accountId: 'caccountman0000000000001', name: 'Gil', email: null, phoneE164: '+525512345607', isPrimary: true },
  )

  const preview = await previewHubspot(CONTACTS, DEALS)
  expect(preview).toMatchObject({ nuevos: 6, repetidos: 2, archivados: 4, negocios: 2 })

  const applied = await applyHubspot(admin, CONTACTS, DEALS)
  expect(applied).toMatchObject({ aplicados: 6 })
  expect(accountOf('hubspot:contact:104')).toBeUndefined()
  expect(accountOf('hubspot:contact:107')).toBeUndefined()
  // Neither the landing account nor the hand-made one is touched: not archived, no new person, no event.
  expect(db.accounts.find(account => account.id === 'caccountlnd0000000000001')!.archivedAt).toBeUndefined()
  expect(contactsOf('caccountlnd0000000000001')).toHaveLength(1)
  expect(contactsOf('caccountman0000000000001')).toHaveLength(1)
  expect(db.events.filter(event => event.accountId === 'caccountlnd0000000000001')).toHaveLength(0)
})

it('un_telefono_que_solo_trajo_esta_importacion_no_vuelve_repetido_a_nadie', async () => {
  // Ana (in «Café Ana») and Dani (no deal) share the business's phone. A first run that died after writing the deal…
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n104,Dani,Soto,5512345601,dani@x.mx,Café Ana\n`
  const deals = `${NO_DEALS}9001,Café Ana,Demo,101\n`
  await applyHubspot(admin, `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n`, deals)

  // …and the next run still brings Dani in, exactly as one clean run would have.
  const preview = await previewHubspot(contacts, deals)
  expect(preview).toMatchObject({ nuevos: 1, repetidos: 1, archivados: 1, negocios: 0 })
  await applyHubspot(admin, contacts, deals)
  expect(accountOf('hubspot:contact:104')).toMatchObject({ archivedAt: expect.any(Date) })
})

it('negocio_con_alguien_que_ya_esta_en_el_crm_entra_y_se_avisa', async () => {
  db.accounts.push({ id: 'caccountlnd0000000000001', source: 'LANDING', externalKey: 'ana@cafe.mx', name: 'Café Ana', stageId: PROSPECTO })
  db.contacts.push({ accountId: 'caccountlnd0000000000001', name: 'Ana López', email: 'ana@cafe.mx', phoneE164: null, isPrimary: true })

  const preview = await previewHubspot(CONTACTS, DEALS)
  // Ruling 33: a deal is «repetido» only by its key. The team hears about the landing account, to merge them.
  expect(preview).toMatchObject({ negocios: 2, repetidos: 0 })
  expect(preview.avisos).toEqual([expect.stringMatching(/fila 2.*Café Ana.*ya está en el CRM/)])
})

it('una_tanda_que_falla_no_deshace_las_anteriores_y_reimportar_completa', async () => {
  // 250 contacts without a deal: a batch of 200 and one of 50.
  const rows = Array.from({ length: 250 }, (_, i) => `${1000 + i},Persona ${i},,,c${i}@x.mx,Negocio ${i}`)
  const contacts = `${CONTACTS_HEADER}${rows.join('\n')}\n`
  const create = prismaMock.crmContact.create.getMockImplementation()
  let failed = false
  prismaMock.crmContact.create.mockImplementation(async (args: any) => {
    if (args.data.email === 'c230@x.mx' && !failed) {
      failed = true
      throw new Error('connection reset')
    }
    return create(args)
  })

  const first = await applyHubspot(admin, contacts, NO_DEALS)
  expect(first).toMatchObject({ nuevos: 250, aplicados: 200, fallaron: 50 })
  expect(db.accounts).toHaveLength(200)

  const second = await applyHubspot(admin, contacts, NO_DEALS)
  expect(second).toMatchObject({ nuevos: 50, repetidos: 200, aplicados: 50, fallaron: 0 })
  expect(db.accounts).toHaveLength(250)
  expect(new Set(db.accounts.map(account => account.externalKey)).size).toBe(250)
})
