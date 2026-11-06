/**
 * «Importar lo de HubSpot», una sola vez (spec 2026-10-30 §5.3.4, plan task 8, rulings 4, 28, 30 and 33).
 *
 * What these pin beyond the happy path: the preview writes nothing and its counts add up; importing the same files
 * twice — one after the other, or both at once — leaves one account per HubSpot id; a contact already in the CRM is
 * «repetido» and is never touched; a deal's contacts go inside the deal's account instead of getting their own; a bad
 * file is refused whole, before anything is written; and a batch that fails keeps what the earlier batches wrote, so
 * importing again completes it.
 */
import { createHash } from 'node:crypto'
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
  cerrar: false,
  bajas: true,
  plantillas: true,
  preparar: true,
  mandar: true,
  verCampanas: true,
  equipo: true,
  configurar: true,
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
  // The accounts this import already created, by their HubSpot key; or the names of accounts, by id.
  prismaMock.crmAccount.findMany.mockImplementation(async ({ where }: any) =>
    where.id
      ? db.accounts.filter(account => where.id.in.includes(account.id)).map(account => ({ id: account.id, name: account.name }))
      : db.accounts
          .filter(account => account.source === where.source && where.externalKey.in.includes(account.externalKey))
          .map(account => ({ externalKey: account.externalKey })),
  )
  // GROUP BY one column with MIN(accountId): each value once, whatever the number of people that share it — of any
  // account (ruling 65), or of the sources an `account.source.not` leaves.
  prismaMock.crmContact.groupBy.mockImplementation(async ({ by: [field], where }: any) => {
    const sourceOf = (contact: any) => db.accounts.find(account => account.id === contact.accountId)?.source
    const firstAccount = new Map<string, string>()
    for (const contact of db.contacts) {
      const value = contact[field]
      if (!value || !where[field].in.includes(value)) continue
      if (where.account && sourceOf(contact) === where.account.source.not) continue
      const current = firstAccount.get(value)
      if (!current || contact.accountId < current) firstAccount.set(value, contact.accountId)
    }
    return [...firstAccount].map(([value, accountId]) => ({ [field]: value, _min: { accountId } }))
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

it('un_contacto_con_el_telefono_de_un_negocio_es_la_misma_persona, en una corrida y tras una caída (ruling 65)', async () => {
  // Ana (in «Café Ana») and Dani (no deal) share the business's phone: for the CRM, the same person — one account.
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n104,Dani,Soto,5512345601,dani@x.mx,Café Ana\n`
  const deals = `${NO_DEALS}9001,Café Ana,Demo,101\n`

  // One clean run: Dani is «repetido» of the deal that comes in with her phone.
  expect(await previewHubspot(contacts, deals)).toMatchObject({ nuevos: 1, negocios: 1, archivados: 0, repetidos: 1 })

  // A first run that died after writing the deal, and the next run: the same answer, by the CRM this time.
  await applyHubspot(admin, `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n`, deals)
  expect(await previewHubspot(contacts, deals)).toMatchObject({ nuevos: 0, repetidos: 2 })
  await applyHubspot(admin, contacts, deals)
  expect(db.accounts.map(account => account.externalKey)).toEqual(['hubspot:deal:9001'])
})

it('persona_importada_sola_y_luego_su_negocio_no_da_dos_fichas (Codex exhaustiva #7)', async () => {
  const ana = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n`
  await applyHubspot(admin, ana, NO_DEALS)
  const archived = accountOf('hubspot:contact:101')!

  // Later, her business: «repetido» of the account she already has, with its aviso.
  const applied = await applyHubspot(admin, ana, `${NO_DEALS}9001,Café Ana,Demo,101\n`)

  expect(applied).toMatchObject({ nuevos: 0, repetidos: 1, aplicados: 0 })
  expect(applied.avisos).toEqual([expect.stringMatching(new RegExp(`Café Ana.*no entra.*Ana López.*\\(${archived.id}\\).*Demo`))])
  expect(db.accounts).toHaveLength(1)
})

it('dos_negocios_de_la_misma_persona_en_una_importacion_dan_una_ficha (Codex exhaustiva #7)', async () => {
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n102,Ana,L.,5512345699,ana@cafe.mx,Café Ana 2\n`
  const deals = `${NO_DEALS}9001,Café Ana,Contacto Inicial,101\n9003,Café Ana 2,Calificado,102\n`

  const preview = await previewHubspot(contacts, deals)
  expect(preview).toMatchObject({ nuevos: 1, negocios: 1, repetidos: 1 })
  expect(preview.avisos).toEqual([expect.stringMatching(/Café Ana 2.*no entra.*viene en «Café Ana» de este mismo archivo.*Calificado/)])

  await applyHubspot(admin, contacts, deals)
  expect(db.accounts.map(account => account.externalKey)).toEqual(['hubspot:deal:9001'])
})

it('alguien_que_llega_por_otro_camino_mientras_se_importa_no_da_otra_ficha (Codex exhaustiva #7)', async () => {
  // The plan reads an empty CRM; before the first batch writes, Ana fills the landing form.
  const plain = prismaMock.$transaction.getMockImplementation()!
  prismaMock.$transaction.mockImplementationOnce(async (callback: (tx: unknown) => unknown, options: unknown) => {
    db.accounts.push({
      id: 'caccountlnd0000000000001',
      source: 'LANDING',
      externalKey: 'ana@cafe.mx',
      name: 'Café Ana',
      stageId: PROSPECTO,
    })
    db.contacts.push({ id: 'ccontactlnd000000000001', accountId: 'caccountlnd0000000000001', name: 'Ana', email: 'ana@cafe.mx' })
    return plain(callback, options)
  })

  const applied = await applyHubspot(admin, CONTACTS, DEALS)

  expect(applied).toMatchObject({ nuevos: 8, aplicados: 7 })
  expect(accountOf('hubspot:deal:9001')).toBeUndefined()
  expect(applied.avisos).toContainEqual(
    expect.stringMatching(/Café Ana.*mientras se importaba.*caccountlnd0000000000001.*Contacto Inicial/),
  )
  // Nothing of the deal lands on the landing account.
  expect(contactsOf('caccountlnd0000000000001')).toHaveLength(1)
  expect(db.events.filter(event => event.accountId === 'caccountlnd0000000000001')).toHaveLength(0)
})

it('ids_asociados_repetidos_o_de_la_misma_persona_no_duplican_contactos (Codex exhaustiva #8)', async () => {
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n102,Ana,López,5512345601,Ana@Cafe.mx,Café Ana\n`
  await applyHubspot(admin, contacts, `${NO_DEALS}9001,Café Ana,Demo,101;101;102\n`)

  expect(contactsOf(accountOf('hubspot:deal:9001')!.id)).toEqual([
    expect.objectContaining({ email: 'ana@cafe.mx', phoneE164: '+525512345601', isPrimary: true }),
  ])
})

it('dos_telefonos_reconocidos_entran_los_dos (Codex exhaustiva #9)', async () => {
  const header = 'Record ID,First Name,Last Name,Phone Number,Mobile Phone Number,Email\n'
  await applyHubspot(admin, `${header}101,Ana,López,5512345601,5598765432,ana@cafe.mx\n`, NO_DEALS)

  expect(contactsOf(accountOf('hubspot:contact:101')!.id)).toEqual([
    expect.objectContaining({ email: 'ana@cafe.mx', phoneE164: '+525512345601', isPrimary: true }),
    expect.objectContaining({ email: null, phoneE164: '+525598765432', isPrimary: false }),
  ])
  // A WhatsApp from the second phone is the same person: importing it again is «repetido».
  expect(await previewHubspot(`${header}201,Ana,,5598765432,,\n`, NO_DEALS)).toMatchObject({ nuevos: 0, repetidos: 1 })
})

it('dos_correos_reconocidos_entran_los_dos (ruling 70, M6 de la re-revisión)', async () => {
  const header = 'Record ID,First Name,Last Name,Email,Correo\n'
  await applyHubspot(admin, `${header}101,Ana,López,ana@cafe.mx,Ana.Personal@Gmail.com\n`, NO_DEALS)

  expect(contactsOf(accountOf('hubspot:contact:101')!.id)).toEqual([
    expect.objectContaining({ email: 'ana@cafe.mx', phoneE164: null, isPrimary: true }),
    expect.objectContaining({ email: 'ana.personal@gmail.com', phoneE164: null, isPrimary: false }),
  ])
  // Someone who writes from the second email is the same person: importing them again is «repetido».
  expect(await previewHubspot(`${header}201,Ana,,,ana.personal@gmail.com\n`, NO_DEALS)).toMatchObject({ nuevos: 0, repetidos: 1 })
})

it('negocio_con_alguien_que_ya_esta_en_el_crm_es_repetido', async () => {
  // Ana filled the landing before HubSpot made her a deal (ruling 36: ruling 33 as written).
  db.accounts.push({ id: 'caccountlnd0000000000001', source: 'LANDING', externalKey: 'ana@cafe.mx', name: 'Café Ana', stageId: PROSPECTO })
  db.contacts.push({ accountId: 'caccountlnd0000000000001', name: 'Ana López', email: 'ana@cafe.mx', phoneE164: null, isPrimary: true })

  const aviso = /fila 2.*Café Ana.*no entra.*Ana López.*«Café Ana» \(caccountlnd0000000000001\).*Contacto Inicial/
  // «Café Ana» is repeated; «Tienda Carla» comes in; the 6 contacts without a deal too. Importing again, the same deal is
  // still repeated, with the same aviso — the other 7 now by their key.
  for (const expected of [
    { negocios: 1, repetidos: 1, archivados: 6, nuevos: 7 },
    { negocios: 0, repetidos: 8, archivados: 0, nuevos: 0 },
  ]) {
    const preview = await previewHubspot(CONTACTS, DEALS)
    expect(preview).toMatchObject(expected)
    // It names the account that already exists and the stage HubSpot had, for the seller to carry it over by hand.
    expect(preview.avisos).toEqual([expect.stringMatching(aviso)])

    // Applying never creates the deal nor touches the landing account.
    await applyHubspot(admin, CONTACTS, DEALS)
    expect(accountOf('hubspot:deal:9001')).toBeUndefined()
    expect(contactsOf('caccountlnd0000000000001')).toHaveLength(1)
    expect(db.events.filter(event => event.accountId === 'caccountlnd0000000000001')).toHaveLength(0)
    expect(db.accounts.find(account => account.id === 'caccountlnd0000000000001')).toEqual({
      id: 'caccountlnd0000000000001',
      source: 'LANDING',
      externalKey: 'ana@cafe.mx',
      name: 'Café Ana',
      stageId: PROSPECTO,
    })
    expect(db.accounts).toHaveLength(1 + 7)
  }
})

it('contactos_dentro_de_su_negocio_cuenta_solo_los_de_negocios_que_entran (T15 WARN-3)', async () => {
  // «Café Ana» (Ana + Beto) comes in; «Tienda Carla» is repeated because Carla is already in the CRM: her contact writes nothing.
  db.accounts.push({ id: 'caccountlnd0000000000002', source: 'LANDING', externalKey: 'carla@x.mx', name: 'Carla', stageId: PROSPECTO })
  db.contacts.push({ accountId: 'caccountlnd0000000000002', name: 'Carla', email: 'carla@x.mx', phoneE164: null, isPrimary: true })
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n102,Beto,Ruiz,5512345602,beto@cafe.mx,Café Ana\n103,Carla,Paz,5512345603,carla@x.mx,Tienda Carla\n`
  const deals = `${NO_DEALS}9001,Café Ana,Calificado,101;102\n9002,Tienda Carla,Calificado,103\n`
  expect(await previewHubspot(contacts, deals)).toMatchObject({
    negocios: 1,
    repetidos: 1,
    archivados: 0,
    nuevos: 1,
    contactosDeNegocios: 2,
  })

  // Two deals of the same file sharing a person: the second is «repetido» (sameFile) and only the first one's people count.
  const shared = `${CONTACTS_HEADER}201,Ana,López,5512345601,ana@cafe.mx,Café Ana\n202,Ana,L.,5512345699,ana@cafe.mx,Café Ana 2\n203,Dani,Gil,5512345603,dani@x.mx,Café Ana\n`
  const sharedDeals = `${NO_DEALS}9001,Café Ana,Calificado,201;203\n9003,Café Ana 2,Calificado,202\n`
  expect(await previewHubspot(shared, sharedDeals)).toMatchObject({ negocios: 1, repetidos: 1, contactosDeNegocios: 2 })
})

it('contactos_dentro_de_su_negocio_anuncia_lo_que_se_escribe (T15 ronda 1)', async () => {
  const count = async (contacts: string, deals: string) => {
    const preview = await previewHubspot(contacts, deals)
    await applyHubspot(admin, contacts, deals)
    return { announced: preview.contactosDeNegocios, written: db.contacts.length }
  }
  // Two ids with the same email and phone in one deal: one row.
  expect(
    await count(
      `${CONTACTS_HEADER}1,Ana,López,5512345601,ana@cafe.mx,Café Ana\n2,Ana,López,5512345601,ana@cafe.mx,Café Ana\n`,
      `${NO_DEALS}9001,Café Ana,Calificado,1;2\n`,
    ),
  ).toEqual({ announced: 1, written: 1 })
})

it('contactos_dentro_de_su_negocio_cuenta_un_contacto_por_telefono_extra (T15 ronda 1)', async () => {
  const contacts = 'Record ID,First Name,Last Name,Phone Number,Mobile Phone Number,Email\n1,Ana,López,5512345601,5598765432,ana@cafe.mx\n'
  const deals = `${NO_DEALS}9001,Café Ana,Calificado,1\n`
  const preview = await previewHubspot(contacts, deals)
  await applyHubspot(admin, contacts, deals)
  expect(db.contacts).toHaveLength(2)
  expect(preview.contactosDeNegocios).toBe(db.contacts.length)
})

it('contactos_dentro_de_su_negocio_sin_correo_ni_telefono_en_dos_negocios_cuenta_dos (T15 ronda 1)', async () => {
  const contacts = `${CONTACTS_HEADER}1,Ana,López,,,\n`
  const deals = `${NO_DEALS}9001,Café Ana,Calificado,1\n9002,Café Ana 2,Calificado,1\n`
  const preview = await previewHubspot(contacts, deals)
  await applyHubspot(admin, contacts, deals)
  expect(preview.contactosDeNegocios).toBe(db.contacts.length)
  expect(db.contacts).toHaveLength(2)
})

it('contactos_dentro_de_su_negocio_es_cero_al_importar_otra_vez (T15 WARN-3)', async () => {
  await applyHubspot(admin, CONTACTS, DEALS)
  expect(await previewHubspot(CONTACTS, DEALS)).toMatchObject({ nuevos: 0, repetidos: 8, contactosDeNegocios: 0 })
})

it('contacto_de_un_negocio_que_no_puede_entrar_se_avisa_antes_de_aplicar', async () => {
  // Beto's row has an error and 999 is not in the file: once the deal is in, importing again cannot add them.
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n102,,,,beto@x.mx,\n`
  const deals = `${NO_DEALS}9001,Café Ana,Calificado,101;102;999\n`
  const preview = await previewHubspot(contacts, deals)

  expect(preview.conError).toEqual([{ archivo: 'contactos', fila: 3, razon: 'Sin nombre ni teléfono' }])
  expect(preview.avisos).toEqual([
    expect.stringMatching(/fila 2.*Café Ana.*sin el contacto 102 \(contactos, fila 3, con error\).*después ya no se agrega/),
    expect.stringMatching(/fila 2.*Café Ana.*sin el contacto 999.*no viene en el archivo de contactos.*después ya no se agrega/),
  ])
})

it('cabecera_de_mas_de_2000_columnas_no_se_lee', async () => {
  const header = (columns: number) => ['Record ID', ...Array.from({ length: columns - 1 }, (_, i) => `x${i}`)].join(',')

  // «Export all properties» gives several hundred: up to 2000 is read (ruling 37, amended).
  const wide = await previewHubspot(`${header(2000)}\n`, NO_DEALS)
  expect(wide.conError).toEqual([])
  expect(wide.columnasIgnoradasTotal.contactos).toBe(1999)

  const tooWide = await previewHubspot(`${header(2001)}\n`, NO_DEALS)
  expect(tooWide.conError).toEqual([
    { archivo: 'contactos', fila: 1, razon: 'Tiene 2001 columnas y el máximo es 2000: en HubSpot exporta sólo las columnas de la vista' },
  ])
  expect(tooWide.nuevos).toBe(0)
})

it('listas_con_tope_de_100_y_su_total', async () => {
  const errors = Array.from({ length: 150 }, (_, i) => `${2000 + i},,,,e${i}@x.mx,`)
  const warned = Array.from({ length: 150 }, (_, i) => `${3000 + i},Persona ${i},,abc,,`)
  const preview = await previewHubspot(`${CONTACTS_HEADER}${[...errors, ...warned].join('\n')}\n`, NO_DEALS)

  // The first 100 of each list, in the order of the file, and the real total: nothing is cut in silence.
  expect(preview.conError).toHaveLength(100)
  expect(preview.conErrorTotal).toBe(150)
  expect(preview.conError[0]).toEqual({ archivo: 'contactos', fila: 2, razon: 'Sin nombre ni teléfono' })
  expect(preview.conError[99].fila).toBe(101)
  expect(preview.avisos).toHaveLength(100)
  expect(preview.avisosTotal).toBe(150)
  // The counts are never capped.
  expect(preview.archivados).toBe(150)

  const unknown = Array.from({ length: 150 }, (_, i) => `x${i}`)
  const wide = await previewHubspot(`${['Record ID', ...unknown].join(',')}\n`, NO_DEALS)
  expect(wide.columnasIgnoradas.contactos).toEqual(unknown.slice(0, 100))
  expect(wide.columnasIgnoradasTotal).toEqual({ contactos: 150, negocios: 0 })
})

it('comillas_sin_cerrar_no_se_lee_el_archivo', async () => {
  // Papa folds every row after the open quote into one cell: 103 would vanish from the counts without a word.
  const contacts = `${CONTACTS_HEADER}101,Ana,López,5512345601,ana@cafe.mx,Café Ana\n102,"Beto,Ruiz,5512345602,b@x.mx,Café\n103,Carla,Díaz,5512345603,c@x.mx,Tienda\n`
  const preview = await previewHubspot(contacts, NO_DEALS)

  expect(preview.conError).toEqual([
    { archivo: 'contactos', fila: 3, razon: 'Tiene comillas sin cerrar: no se pudo leer nada desde esta fila' },
  ])
  expect(preview.nuevos).toBe(0)
  await expect(applyHubspot(admin, contacts, NO_DEALS)).rejects.toMatchObject({ statusCode: 422, code: 'CRM_IMPORT_ARCHIVO_INVALIDO' })
  expect(db.accounts).toHaveLength(0)
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

describe('la casilla «Aceptaron recibir correos»', () => {
  const ONE = `${CONTACTS_HEADER}101,Ana,López,5512345601,Ana@Cafe.mx,Café Ana\n102,Beto,Ruiz,5512345602,beto@cafe.mx,Café Beto\n`
  const consentOf = (email: string) => db.consents.find(consent => consent.email === email)

  it('con_la_casilla_cada_registro_que_entra_deja_el_permiso_de_sus_correos_con_IMPORTACION', async () => {
    const applied = await applyHubspot(admin, ONE, NO_DEALS, { aceptaronCorreos: true })
    expect(applied).toMatchObject({ aplicados: 2, conPermiso: 2 })
    expect(consentOf('ana@cafe.mx')).toMatchObject({
      source: 'IMPORTACION',
      grantedById: ADMIN,
      entryId: null,
      noticeVersion: 'casilla-del-equipo-v1',
      accountId: accountOf('hubspot:contact:101')!.id,
    })
    expect(consentOf('beto@cafe.mx')).toBeDefined()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CRM_HUBSPOT_IMPORTED', data: expect.objectContaining({ aceptaronCorreos: true, conPermiso: 2 }) }),
    )
  })

  it('sin_la_casilla_no_escribe_ningun_permiso', async () => {
    const applied = await applyHubspot(admin, ONE, NO_DEALS)
    expect(db.consents).toHaveLength(0)
    expect(applied.conPermiso).toBeUndefined()
    const off = await applyHubspot(admin, `${CONTACTS_HEADER}103,Cris,Paz,5512345603,cris@cafe.mx,Café Cris\n`, NO_DEALS, {
      aceptaronCorreos: false,
    })
    expect(off.conPermiso).toBeUndefined()
    expect(db.consents).toHaveLength(0)
  })

  it('🔴 un_repetido_no_escribe_permiso_ni_toca_el_que_ya_habia', async () => {
    await applyHubspot(admin, ONE, NO_DEALS)
    db.consents.push({
      id: 'cconsprev0000000000000001',
      email: 'ana@cafe.mx',
      source: 'LANDING',
      grantedById: null,
      noticeVersion: '2026-01-01',
    })
    const applied = await applyHubspot(admin, ONE, NO_DEALS, { aceptaronCorreos: true })
    expect(applied).toMatchObject({ aplicados: 0, conPermiso: 0 })
    expect(db.consents).toEqual([expect.objectContaining({ source: 'LANDING', grantedById: null, noticeVersion: '2026-01-01' })])
  })

  it('un_eliminado_no_vuelve_ni_con_permiso', async () => {
    const hash = createHash('sha256').update('EMAIL:ana@cafe.mx').digest('hex')
    db.erased.push({ keyHash: hash, scope: '', erasedAt: new Date() })
    const applied = await applyHubspot(admin, ONE, NO_DEALS, { aceptaronCorreos: true })
    expect(applied).toMatchObject({ aplicados: 1, conPermiso: 1 })
    expect(consentOf('ana@cafe.mx')).toBeUndefined()
    expect(accountOf('hubspot:contact:101')).toBeUndefined()
  })

  it('importar_dos_veces_con_la_casilla_no_duplica_ni_cuenta_dos_veces', async () => {
    const first = await applyHubspot(admin, ONE, NO_DEALS, { aceptaronCorreos: true })
    const second = await applyHubspot(admin, ONE, NO_DEALS, { aceptaronCorreos: true })
    expect(first.conPermiso).toBe(2)
    expect(second.conPermiso).toBe(0)
    expect(db.consents).toHaveLength(2)
  })

  it('un_eliminado_en_un_contacto_que_no_es_el_principal_frena_el_registro_entero_y_no_deja_permiso_a_nadie', async () => {
    // accountForTx asks the tombstone for EVERY email of the record: one erased person keeps the whole record out, so the
    // box never sees it (the helper's own tombstone check is the second line, for a deletion that lands in between).
    db.erased.push({ keyHash: createHash('sha256').update('EMAIL:otro@cafe.mx').digest('hex'), scope: '', erasedAt: new Date() })
    const header = 'Record ID,First Name,Last Name,Phone Number,Email,Correo,Company Name\n'
    const applied = await applyHubspot(admin, `${header}101,Ana,López,5512345601,ana@cafe.mx,otro@cafe.mx,Café Ana\n`, NO_DEALS, {
      aceptaronCorreos: true,
    })
    expect(applied).toMatchObject({ aplicados: 0, conPermiso: 0 })
    expect(db.consents).toHaveLength(0)
  })

  it('un_correo_mal_escrito_no_se_cuenta_ni_se_escribe', async () => {
    const bad = `${CONTACTS_HEADER}101,Ana,López,5512345601,sin-arroba,Café Ana\n`
    const applied = await applyHubspot(admin, bad, NO_DEALS, { aceptaronCorreos: true })
    expect(applied).toMatchObject({ aplicados: 1, conPermiso: 0 })
    expect(db.consents).toHaveLength(0)
  })

  it('la_vista_previa_no_escribe_permisos', async () => {
    await previewHubspot(ONE, NO_DEALS)
    expect(prismaMock.crmEmailConsent.createMany).not.toHaveBeenCalled()
  })
})
