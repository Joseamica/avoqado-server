/**
 * C2 · Ficha editable (plan 2026-11-06, Tareas 1–3): los datos del negocio y sus personas con «lo que se vio».
 *
 * Un doble en memoria de las tablas que toca (`installFichaFake`): guarda RESULTADOS (una persona, un evento, una fila de
 * permiso) y no «se llamó a create». Lo que sólo prueba la base (el candado, dos a la vez) va en
 * `tests/integration/crm/ficha-editable.integration.test.ts`.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import type { CrmAccess } from '@/services/crm/access.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { findDuplicates } from '@/services/crm/accounts.service'
import { addContact, removeContact, updateAccount, updateContact } from '@/services/crm/ficha.service'

type Row = Record<string, any>

const STAFF = 'cstaffana0000000000000001'
const OTRO = 'cstaffbeto000000000000001'
const ACCOUNT = 'caccounta0000000000000001'
const ORG = 'corgclient000000000000001'

const access = (over: Partial<CrmAccess> = {}): CrmAccess =>
  ({
    staffId: STAFF,
    isSuperadmin: false,
    ver: 'todos',
    editar: 'todos',
    contactar: false,
    exportar: false,
    ventas: false,
    cerrar: false,
    bajas: false,
    plantillas: false,
    preparar: false,
    mandar: false,
    verCampanas: false,
    equipo: false,
    configurar: false,
    campanas: false,
    admin: false,
    ...over,
  }) as CrmAccess

let db: ReturnType<typeof installFichaFake>

/** Las tablas que toca la ficha, con la semántica que sus escritores esperan. */
function installFichaFake() {
  const db = {
    accounts: [] as Row[],
    contacts: [] as Row[],
    events: [] as Row[],
    consents: [] as Row[],
    erased: [] as Row[],
    logs: [] as Row[],
  }
  let seq = 0
  const nextId = (prefix: string) => `c${prefix}${String(++seq).padStart(24 - prefix.length, '0')}`
  const fieldMatches = (value: unknown, filter: any): boolean => {
    if (filter === null) return (value ?? null) === null
    if (filter && typeof filter === 'object' && !(filter instanceof Date)) {
      if ('in' in filter) return filter.in.includes(value)
      if ('not' in filter) return value !== filter.not
      if ('equals' in filter)
        return filter.mode === 'insensitive'
          ? String(value ?? '').toLowerCase() === String(filter.equals).toLowerCase()
          : value === filter.equals
      if ('lt' in filter) return value instanceof Date && value < filter.lt
      throw new Error(`El doble no conoce el filtro ${JSON.stringify(filter)}`)
    }
    return (value ?? null) === filter
  }
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([field, filter]) => {
      if (field === 'AND') return (filter as Row[]).every(branch => matches(row, branch))
      if (field === 'OR') return (filter as Row[]).some(branch => matches(row, branch))
      if (field === 'contacts') return db.contacts.some(c => c.accountId === row.id && matches(c, filter.some))
      return fieldMatches(row[field], filter)
    })
  const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k] ?? null])) : { ...row })

  for (const model of ['crmAccount', 'crmContact', 'crmTimelineEvent', 'crmEmailConsent', 'crmErased', 'activityLog', 'staff']) {
    for (const fn of Object.values(prismaMock[model])) (fn as jest.Mock).mockReset()
  }
  prismaMock.$queryRaw.mockReset().mockResolvedValue([])

  prismaMock.crmAccount.findFirst.mockImplementation(async ({ where, select }: Row) => {
    const row = db.accounts.find(account => matches(account, where))
    return row ? pick(row, select) : null
  })
  prismaMock.crmAccount.findUniqueOrThrow.mockImplementation(async ({ where, select }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)
    if (!row) throw new Error('No CrmAccount found')
    return pick(row, select)
  })
  prismaMock.crmAccount.findMany.mockImplementation(async ({ where, take }: Row) =>
    db.accounts
      .filter(account => matches(account, where))
      .slice(0, take)
      .map(account => ({ ...account, owner: null })),
  )
  prismaMock.crmAccount.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const rows = db.accounts.filter(account => matches(account, where))
    rows.forEach(row => Object.assign(row, data))
    return { count: rows.length }
  })
  prismaMock.crmAccount.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.accounts.find(account => account.id === where.id)!
    Object.assign(row, data)
    return { id: row.id }
  })
  prismaMock.crmTimelineEvent.createMany.mockImplementation(async ({ data: [event] }: Row) => {
    if (event.sourceKey && db.events.some(e => e.sourceKey === event.sourceKey)) return { count: 0 }
    db.events.push({ id: nextId('event'), createdAt: new Date(), ...event })
    return { count: 1 }
  })
  prismaMock.crmTimelineEvent.findUnique.mockImplementation(async ({ where, select }: Row) => {
    const row = db.events.find(event => event.sourceKey === where.sourceKey)
    return row ? pick(row, select) : null
  })
  prismaMock.crmContact.findFirst.mockImplementation(async ({ where, select }: Row) => {
    const row = db.contacts.find(contact => matches(contact, where))
    return row ? pick(row, select) : null
  })
  prismaMock.crmContact.count.mockImplementation(async ({ where }: Row) => db.contacts.filter(c => matches(c, where)).length)
  prismaMock.crmContact.create.mockImplementation(async ({ data }: Row) => {
    const row = { id: nextId('cont'), createdAt: new Date(), email: null, phoneE164: null, role: null, ...data }
    db.contacts.push(row)
    return { id: row.id }
  })
  prismaMock.crmContact.update.mockImplementation(async ({ where, data }: Row) => {
    const row = db.contacts.find(contact => contact.id === where.id)!
    Object.assign(row, data)
    return { id: row.id }
  })
  prismaMock.crmContact.updateMany.mockImplementation(async ({ where, data }: Row) => {
    const rows = db.contacts.filter(contact => matches(contact, where))
    rows.forEach(row => Object.assign(row, data))
    return { count: rows.length }
  })
  prismaMock.crmContact.delete.mockImplementation(async ({ where }: Row) => {
    const i = db.contacts.findIndex(contact => contact.id === where.id)
    const [row] = db.contacts.splice(i, 1)
    return row
  })
  // ON CONFLICT (email) DO NOTHING: nunca pisa un permiso que ya había.
  prismaMock.crmEmailConsent.createMany.mockImplementation(async ({ data }: Row) => {
    let count = 0
    for (const row of data) {
      if (db.consents.some(consent => consent.email === row.email)) continue
      db.consents.push(row)
      count++
    }
    return { count }
  })
  prismaMock.crmEmailConsent.findUnique.mockImplementation(async ({ where }: Row) => db.consents.find(c => c.email === where.email) ?? null)
  prismaMock.crmErased.findMany.mockImplementation(async ({ where }: Row) =>
    db.erased.filter(row => where.keyHash.in.includes(row.keyHash)),
  )
  // `logAction` va simulado en todo el proyecto (setup.ts): lo que pide escribir queda aquí.
  jest.mocked(logAction).mockImplementation(async params => {
    db.logs.push(params)
  })

  // 🔴 Codex código r1 #3: la transacción recibe SU cliente, distinto del `prisma` global. Una consulta por el global
  // mientras hay una transacción abierta (otra conexión del pool) truena aquí, como se agotaría el pool en producción.
  let enTx = false
  let viaTx = false
  const modelos = ['crmAccount', 'crmContact', 'crmTimelineEvent', 'crmEmailConsent', 'crmErased']
  const tx: Row = {}
  const vigilar = (fn: jest.Mock) => {
    const impl = fn.getMockImplementation()
    if (!impl) return
    fn.mockImplementation((...args: unknown[]) => {
      const desdeTx = viaTx
      viaTx = false
      if (enTx && !desdeTx) throw new Error('Se usó el prisma global dentro de una transacción (otra conexión)')
      return impl(...args)
    })
  }
  const porTx =
    (fn: jest.Mock) =>
    (...args: unknown[]) => {
      viaTx = true
      return fn(...args)
    }
  for (const model of modelos) {
    tx[model] = {}
    for (const [name, fn] of Object.entries(prismaMock[model]) as Array<[string, jest.Mock]>) {
      vigilar(fn)
      tx[model][name] = porTx(fn)
    }
  }
  vigilar(prismaMock.$queryRaw)
  tx.$queryRaw = porTx(prismaMock.$queryRaw)
  prismaMock.$transaction.mockImplementation(async (callback: (client: Row) => unknown) => {
    enTx = true
    try {
      return await callback(tx)
    } finally {
      enTx = false
    }
  })
  return db
}

/** Un negocio de la base, como lo dejan la landing o el alta a mano. */
function seedAccount(over: Row = {}) {
  const row = {
    id: ACCOUNT,
    name: 'Café Ana',
    giro: 'Cafetería',
    ventasRango: '500k-1m',
    sucursales: 2,
    modulos: ['mesas'],
    referidoPor: null,
    organizationId: ORG,
    ownerStaffId: STAFF,
    lastTouchAt: new Date(Date.now() - 86_400_000),
    qualifiedAt: null,
    qualificationAvailable: false,
    ...over,
  }
  db.accounts.push(row)
  return row
}

const flush = () => new Promise(resolve => setImmediate(resolve))
const eventos = (kind: string) => db.events.filter(event => event.kind === kind)

beforeEach(() => {
  db = installFichaFake()
})

describe('Tarea 1 · updateAccount: datos del negocio con «lo que se vio»', () => {
  it('cambia el giro: guarda, un ACCOUNT_EDIT {campo, de, a}, toque y ActivityLog sólo con campos', async () => {
    const account = seedAccount()
    const antes = account.lastTouchAt

    await expect(updateAccount(access(), ACCOUNT, { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } })).resolves.toEqual({
      accountId: ACCOUNT,
      cambiados: ['giro'],
    })
    await flush()

    expect(account).toMatchObject({ giro: 'Bar', qualificationAvailable: true })
    expect(account.qualifiedAt).toBeInstanceOf(Date)
    expect(account.lastTouchAt.getTime()).toBeGreaterThan(antes.getTime())
    expect(eventos('ACCOUNT_EDIT')).toEqual([
      expect.objectContaining({ actorStaffId: STAFF, data: { campo: 'giro', de: 'Cafetería', a: 'Bar' } }),
    ])
    expect(db.logs).toEqual([
      expect.objectContaining({
        action: 'CRM_ACCOUNT_UPDATED',
        entityId: ACCOUNT,
        organizationId: ORG,
        venueId: null,
        data: { campos: ['giro'] },
      }),
    ])
  })

  it('🔴 vio.giro distinto de lo guardado → 409 CRM_CAMBIO_AL_EDITAR con ahora y sin update, evento ni logAction', async () => {
    seedAccount({ giro: 'Restaurante' })

    await expect(updateAccount(access(), ACCOUNT, { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_CAMBIO_AL_EDITAR',
      details: { ahora: { giro: 'Restaurante' } },
    })
    await flush()
    expect(prismaMock.crmAccount.update).not.toHaveBeenCalled()
    expect(db.events).toEqual([])
    expect(db.logs).toEqual([])
  })

  it('🔴 pedir lo ya guardado con un vio viejo → no-op (cambiados: []) sin 409, sin toque', async () => {
    const account = seedAccount({ giro: 'Bar' })
    const antes = account.lastTouchAt

    await expect(updateAccount(access(), ACCOUNT, { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } })).resolves.toEqual({
      accountId: ACCOUNT,
      cambiados: [],
    })
    await flush()
    expect(account.lastTouchAt).toBe(antes)
    expect(db.events).toEqual([])
    expect(db.logs).toEqual([])
  })

  it('giro y sucursales: sólo el que cambia se compara', async () => {
    seedAccount({ giro: 'Bar', sucursales: 2 })
    // La pantalla vio otro giro, pero el giro que pide ya es el guardado: sólo cuenta sucursales.
    await expect(
      updateAccount(access(), ACCOUNT, { cambios: { giro: 'Bar', sucursales: 3 }, vio: { giro: 'Cafetería', sucursales: 2 } }),
    ).resolves.toEqual({ accountId: ACCOUNT, cambiados: ['sucursales'] })
  })

  it("' Cafetería ' guarda igual que 'Cafetería' (mismoTexto); módulos se comparan limpios y en orden", async () => {
    seedAccount({ modulos: ['mesas', 'cocina'] })
    await expect(
      updateAccount(access(), ACCOUNT, {
        cambios: { giro: ' Cafetería ', modulos: [' mesas', 'cocina', 'mesas', ''] },
        vio: { giro: 'x', modulos: [] },
      }),
    ).resolves.toEqual({ accountId: ACCOUNT, cambiados: [] })
    await expect(
      updateAccount(access(), ACCOUNT, { cambios: { modulos: ['cocina', 'mesas'] }, vio: { modulos: ['mesas', 'cocina'] } }),
    ).resolves.toEqual({ accountId: ACCOUNT, cambiados: ['modulos'] })
  })

  it('cambiar sucursales fija qualifiedAt y qualificationAvailable; cambiar name no', async () => {
    const account = seedAccount()
    await updateAccount(access(), ACCOUNT, { cambios: { name: 'Café Ana Centro' }, vio: { name: 'Café Ana' } })
    expect(account).toMatchObject({ name: 'Café Ana Centro', qualifiedAt: null, qualificationAvailable: false })

    await updateAccount(access(), ACCOUNT, { cambios: { sucursales: 3 }, vio: { sucursales: 2 } })
    expect(account).toMatchObject({ sucursales: 3, qualificationAvailable: true })
    expect(account.qualifiedAt).toBeInstanceOf(Date)
  })

  it('🔴 el evento de name y el de referidoPor no llevan de ni a', async () => {
    seedAccount()
    await updateAccount(access(), ACCOUNT, {
      cambios: { name: 'Café Ana Centro', referidoPor: 'Luis Pérez' },
      vio: { name: 'Café Ana', referidoPor: null },
    })
    expect(eventos('ACCOUNT_EDIT').map(event => event.data)).toEqual([{ campo: 'name' }, { campo: 'referidoPor' }])
    expect(JSON.stringify(db.events)).not.toContain('Luis')
  })

  it('null borra un texto (y "" también)', async () => {
    const account = seedAccount({ referidoPor: 'Luis' })
    await updateAccount(access(), ACCOUNT, {
      cambios: { referidoPor: null, giro: '' as any },
      vio: { referidoPor: 'Luis', giro: 'Cafetería' },
    })
    expect(account).toMatchObject({ referidoPor: null, giro: null })
  })

  it('🔴 A «propios» sobre la cuenta de B → 404; ver todos / editar propios → 403 CRM_NO_ES_TUYO', async () => {
    seedAccount({ ownerStaffId: OTRO })
    const cambio = { cambios: { giro: 'Bar' }, vio: { giro: 'Cafetería' } }
    await expect(updateAccount(access({ ver: 'propios', editar: 'propios' }), ACCOUNT, cambio)).rejects.toMatchObject({ statusCode: 404 })
    await expect(updateAccount(access({ ver: 'todos', editar: 'propios' }), ACCOUNT, cambio)).rejects.toMatchObject({
      statusCode: 403,
      code: 'CRM_NO_ES_TUYO',
    })
    expect(db.accounts[0].giro).toBe('Cafetería')
  })
})

// ── Tarea 2 · Agregar persona ─────────────────────────────────────────────────────────────────────────────────────────

const K1 = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'

function seedContact(over: Row = {}) {
  const row = {
    id: `ccontact${String(db.contacts.length + 1).padStart(17, '0')}`,
    accountId: ACCOUNT,
    name: 'Beto',
    email: null,
    phoneE164: null,
    role: null,
    isPrimary: false,
    createdAt: new Date(Date.now() - 60_000),
    ...over,
  }
  db.contacts.push(row)
  return row
}
const persona = (over: Row = {}) => ({ name: 'Ana López', phone: '55 1234 5678', email: 'ana@cafe.mx', clientRequestId: K1, ...over })

describe('Tarea 2 · addContact: agregar persona', () => {
  it('la primera persona nace principal; el evento y el ActivityLog no llevan nombre, correo ni teléfono', async () => {
    seedAccount()
    const r = await addContact(access(), ACCOUNT, persona())
    await flush()

    expect(r).toMatchObject({ permisoDelCorreo: false, consentimientoRegistrado: false, repetido: false })
    expect(db.contacts).toEqual([
      expect.objectContaining({ id: r.contactId, name: 'Ana López', email: 'ana@cafe.mx', phoneE164: '+525512345678', isPrimary: true }),
    ])
    expect(eventos('CONTACT_ADDED')).toEqual([
      expect.objectContaining({
        sourceKey: `contacto:${ACCOUNT}:${K1}`,
        data: expect.objectContaining({ contactId: r.contactId, principal: true }),
      }),
    ])
    const todo = JSON.stringify({ events: db.events, logs: db.logs })
    for (const dato of ['Ana', 'ana@cafe.mx', '5512345678']) expect(todo).not.toContain(dato)
    expect(db.logs).toEqual([
      expect.objectContaining({ action: 'CRM_CONTACT_ADDED', data: expect.objectContaining({ contactId: r.contactId }) }),
    ])
  })

  it('isPrimary true → las demás quedan en false; sin isPrimary, la segunda no es principal', async () => {
    seedAccount()
    const beto = seedContact({ isPrimary: true })
    const r = await addContact(access(), ACCOUNT, persona({ isPrimary: true }))
    expect(beto.isPrimary).toBe(false)
    expect(db.contacts.find(c => c.id === r.contactId)!.isPrimary).toBe(true)
    const r2 = await addContact(access(), ACCOUNT, persona({ name: 'Caro', phone: null, email: 'caro@cafe.mx', clientRequestId: K2 }))
    expect(db.contacts.find(c => c.id === r2.contactId)!.isPrimary).toBe(false)
  })

  it('🔴 correo de otra persona del mismo negocio → 409 CRM_PERSONA_YA_ESTA con su contactId', async () => {
    seedAccount()
    const beto = seedContact({ email: 'ana@cafe.mx' })
    await expect(addContact(access(), ACCOUNT, persona({ email: 'ANA@cafe.mx', phone: null }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_PERSONA_YA_ESTA',
      details: { contactId: beto.id },
    })
    expect(db.contacts).toHaveLength(1)
  })

  it('🔴 teléfono de otro negocio → 409 CRM_POSIBLE_DUPLICADO con duplicates; con esOtroNegocio → se crea', async () => {
    seedAccount()
    db.accounts.push({ id: 'caccountb0000000000000001', name: 'Otro', ownerStaffId: null })
    seedContact({ accountId: 'caccountb0000000000000001', phoneE164: '+525512345678' })

    await expect(addContact(access(), ACCOUNT, persona({ email: null }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CRM_POSIBLE_DUPLICADO',
      details: { duplicates: [expect.objectContaining({ id: 'caccountb0000000000000001' })] },
    })
    // El reenvío con «es otro negocio», con la MISMA llave (el primero no creó nada): una sola persona.
    const r = await addContact(access(), ACCOUNT, persona({ email: null, esOtroNegocio: true }))
    expect(db.contacts.filter(c => c.accountId === ACCOUNT)).toEqual([expect.objectContaining({ id: r.contactId })])
  })

  it('🔴 findDuplicates con exceptAccountId no devuelve la propia cuenta', async () => {
    seedAccount()
    seedContact({ phoneE164: '+525599999999' })
    await expect(findDuplicates(access(), { phone: '+525599999999' })).resolves.toHaveLength(1)
    await expect(findDuplicates(access(), { phone: '+525599999999' }, { exceptAccountId: ACCOUNT })).resolves.toEqual([])
  })

  it('🔴 la persona 51 entra (no hay tope)', async () => {
    seedAccount()
    for (let i = 0; i < 50; i++) seedContact({ name: `P${i}` })
    await addContact(access(), ACCOUNT, persona())
    expect(db.contacts).toHaveLength(51)
  })

  it('🔴 casilla sobre un correo que ya tenía permiso → no lo pisa; consentimientoRegistrado false, permisoDelCorreo true', async () => {
    seedAccount()
    const previo = { email: 'ana@cafe.mx', source: 'LANDING', accountId: 'cotra' }
    db.consents.push(previo)
    const r = await addContact(access(), ACCOUNT, persona({ aceptaCorreos: true }))
    expect(r).toMatchObject({ permisoDelCorreo: true, consentimientoRegistrado: false })
    expect(db.consents).toEqual([previo])
  })

  it('con casilla sobre un correo sin permiso → escribe la fila MANUAL de ese correo y lo dice', async () => {
    seedAccount()
    const r = await addContact(access(), ACCOUNT, persona({ aceptaCorreos: true }))
    await flush()
    expect(r).toMatchObject({ permisoDelCorreo: true, consentimientoRegistrado: true })
    expect(db.consents).toEqual([
      expect.objectContaining({ email: 'ana@cafe.mx', source: 'MANUAL', accountId: ACCOUNT, grantedById: STAFF }),
    ])
    expect(db.logs.map(log => log.action)).toEqual(expect.arrayContaining(['CRM_CONTACT_ADDED', 'CRM_EMAIL_CONSENT_RECORDED']))
  })

  it('sin casilla → permisoDelCorreo false y sin fila', async () => {
    seedAccount()
    expect(await addContact(access(), ACCOUNT, persona())).toMatchObject({ permisoDelCorreo: false })
    expect(db.consents).toEqual([])
  })

  it('🔴 la misma llave con el mismo contenido dos veces (también sólo con nombre) → una persona, un evento, un ActivityLog; la segunda repetido sin toque', async () => {
    const account = seedAccount()
    const primera = await addContact(access(), ACCOUNT, { name: 'Sólo Nombre', clientRequestId: K1 })
    await flush()
    const toque = account.lastTouchAt
    const segunda = await addContact(access(), ACCOUNT, { name: ' Sólo Nombre ', clientRequestId: K1 })
    await flush()

    expect(segunda).toMatchObject({ contactId: primera.contactId, repetido: true })
    expect(db.contacts).toHaveLength(1)
    expect(eventos('CONTACT_ADDED')).toHaveLength(1)
    expect(db.logs.filter(log => log.action === 'CRM_CONTACT_ADDED')).toHaveLength(1)
    expect(account.lastTouchAt).toBe(toque)
  })

  it('🔴 Codex r3 H1: la llave K creó a Ana; K con otro correo, otro nombre o la casilla que no tenía → 409 CRM_LLAVE_CON_OTRO_CONTENIDO con ahora', async () => {
    seedAccount()
    const { contactId } = await addContact(access(), ACCOUNT, persona())
    for (const otro of [{ email: 'ana2@cafe.mx' }, { name: 'Ana María' }, { aceptaCorreos: true }]) {
      await expect(addContact(access(), ACCOUNT, persona(otro))).rejects.toMatchObject({
        statusCode: 409,
        code: 'CRM_LLAVE_CON_OTRO_CONTENIDO',
        details: { ahora: expect.objectContaining({ name: 'Ana López', email: 'ana@cafe.mx' }) },
      })
    }
    expect(db.contacts).toEqual([expect.objectContaining({ id: contactId })])
    expect(db.consents).toEqual([])
  })

  it('🔴 Codex r3 H2: K creó a Ana; se quita a Ana; llega K igual → 409 CRM_LLAVE_YA_NO_ESTA (nunca un id muerto)', async () => {
    seedAccount()
    const { contactId } = await addContact(access(), ACCOUNT, persona())
    db.contacts = db.contacts.filter(c => c.id !== contactId)
    await expect(addContact(access(), ACCOUNT, persona())).rejects.toMatchObject({ statusCode: 409, code: 'CRM_LLAVE_YA_NO_ESTA' })
  })

  it('🔴 agregar → quitar → volver a agregar el mismo correo con otra llave → se crea otra vez', async () => {
    seedAccount()
    const { contactId } = await addContact(access(), ACCOUNT, persona())
    db.contacts = db.contacts.filter(c => c.id !== contactId)
    const otra = await addContact(access(), ACCOUNT, persona({ clientRequestId: K2 }))
    expect(otra.contactId).not.toBe(contactId)
    expect(db.contacts).toHaveLength(1)
  })

  it('🔴 Codex r3 H3: el CONTACT_ADDED completo (sourceKey incluido) y el ActivityLog no contienen nombre, correo ni teléfono', async () => {
    seedAccount()
    await addContact(access(), ACCOUNT, persona({ name: 'Zoila Única', email: 'zoila@unica.mx', phone: '55 8765 4321', role: 'Gerente' }))
    await flush()
    const todo = JSON.stringify({ events: db.events, logs: db.logs })
    for (const dato of ['Zoila', 'zoila@unica.mx', '87654321', 'Gerente']) expect(todo).not.toContain(dato)
  })

  it('🔴 A «propios» sobre la cuenta de B → 404, nada escrito', async () => {
    seedAccount({ ownerStaffId: OTRO })
    await expect(addContact(access({ ver: 'propios', editar: 'propios' }), ACCOUNT, persona())).rejects.toMatchObject({ statusCode: 404 })
    expect(db.contacts).toEqual([])
  })
})

// ── Tarea 3 · Cambiar y quitar persona ────────────────────────────────────────────────────────────────────────────────

const vistaDe = (row: Row) => ({ name: row.name, phoneE164: row.phoneE164, email: row.email, role: row.role, isPrimary: row.isPrimary })

describe('Tarea 3 · updateContact: cambiar persona', () => {
  it('🔴 cambiar sólo el puesto de una persona cuyo correo tiene otro negocio → guarda (no compara lo que no cambia)', async () => {
    seedAccount()
    db.accounts.push({ id: 'caccountb0000000000000001', name: 'Otro', ownerStaffId: null })
    seedContact({ accountId: 'caccountb0000000000000001', email: 'mariana@cafe.mx' })
    const mariana = seedContact({ name: 'Mariana', email: 'mariana@cafe.mx', isPrimary: true })

    const r = await updateContact(access(), ACCOUNT, mariana.id, { cambios: { role: 'Gerente' }, vio: vistaDe(mariana) })
    await flush()

    expect(r).toMatchObject({ contactId: mariana.id, cambiados: ['role'], correoAnteriorConPermiso: false })
    expect(mariana.role).toBe('Gerente')
    expect(eventos('CONTACT_EDITED')).toEqual([expect.objectContaining({ data: { contactId: mariana.id, campos: ['role'] } })])
    expect(db.logs).toEqual([expect.objectContaining({ action: 'CRM_CONTACT_UPDATED', data: { contactId: mariana.id, campos: ['role'] } })])
  })

  it('🔴 persona de OTRA cuenta con este accountId → 404 CRM_PERSONA_NO_EXISTE', async () => {
    seedAccount()
    db.accounts.push({ id: 'caccountb0000000000000001', name: 'Otro', ownerStaffId: null })
    const ajena = seedContact({ accountId: 'caccountb0000000000000001' })
    await expect(updateContact(access(), ACCOUNT, ajena.id, { cambios: { role: 'X' }, vio: vistaDe(ajena) })).rejects.toMatchObject({
      statusCode: 404,
      code: 'CRM_PERSONA_NO_EXISTE',
    })
  })

  it('vio.email viejo al cambiar el correo → 409 con ahora (la persona completa)', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'ana2@cafe.mx' })
    await expect(
      updateContact(access(), ACCOUNT, ana.id, { cambios: { email: 'ana3@cafe.mx' }, vio: { ...vistaDe(ana), email: 'ana@cafe.mx' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMBIO_AL_EDITAR', details: { ahora: vistaDe(ana) } })
    expect(ana.email).toBe('ana2@cafe.mx')
  })

  it('🔴 Codex r1 H2: B cambió el correo; A cambia sólo el puesto y marca la casilla con su vio.email viejo → 409, sin permiso', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'nuevo@cafe.mx' })
    await expect(
      updateContact(access(), ACCOUNT, ana.id, {
        cambios: { role: 'Dueña' },
        vio: { ...vistaDe(ana), email: 'viejo@cafe.mx' },
        aceptaCorreos: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CRM_CAMBIO_AL_EDITAR' })
    expect(db.consents).toEqual([])
  })

  it('🔴 Codex r1 H3: sólo la casilla (cambios vacío) sobre una persona sin permiso → escribe la fila, CONTACT_EDITED {campos: [], consentimiento: true} y toque', async () => {
    const account = seedAccount()
    const antes = account.lastTouchAt
    const ana = seedContact({ name: 'Ana', email: 'ana@cafe.mx' })
    const r = await updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: vistaDe(ana), aceptaCorreos: true })
    await flush()
    expect(r).toMatchObject({ cambiados: [], permisoDelCorreo: true, consentimientoRegistrado: true })
    expect(db.consents).toEqual([expect.objectContaining({ email: 'ana@cafe.mx', source: 'MANUAL' })])
    expect(eventos('CONTACT_EDITED')).toEqual([expect.objectContaining({ data: { contactId: ana.id, campos: [], consentimiento: true } })])
    expect(account.lastTouchAt.getTime()).toBeGreaterThan(antes.getTime())
    expect(db.logs.map(log => log.action)).toEqual(expect.arrayContaining(['CRM_CONTACT_UPDATED', 'CRM_EMAIL_CONSENT_RECORDED']))
  })

  it('sólo la casilla sobre un correo que ya tenía permiso → no-op (sin evento ni toque), permisoDelCorreo true', async () => {
    const account = seedAccount()
    const antes = account.lastTouchAt
    const ana = seedContact({ name: 'Ana', email: 'ana@cafe.mx' })
    db.consents.push({ email: 'ana@cafe.mx', source: 'LANDING' })
    const r = await updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: vistaDe(ana), aceptaCorreos: true })
    await flush()
    expect(r).toMatchObject({ cambiados: [], permisoDelCorreo: true, consentimientoRegistrado: false })
    expect(db.events).toEqual([])
    expect(db.logs).toEqual([])
    expect(account.lastTouchAt).toBe(antes)
  })

  it('sólo la casilla sin correo → 422 CRM_SIN_CORREO', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', phoneE164: '+525512345678' })
    await expect(updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: vistaDe(ana), aceptaCorreos: true })).rejects.toMatchObject({
      code: 'CRM_SIN_CORREO',
    })
  })

  it('🔴 Codex r2 H4: { cambios.email nuevo@, vio.email anterior@, casilla } dos veces (la primera respuesta se perdió) → la segunda, éxito sin escribir', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'anterior@cafe.mx' })
    const pedido = { cambios: { email: 'nuevo@cafe.mx' }, vio: vistaDe(ana), aceptaCorreos: true }
    await updateContact(access(), ACCOUNT, ana.id, pedido)
    await flush()
    const [eventosAntes, logsAntes, toque] = [db.events.length, db.logs.length, db.accounts[0].lastTouchAt]

    const r = await updateContact(access(), ACCOUNT, ana.id, pedido)
    await flush()
    expect(r).toMatchObject({ cambiados: [], permisoDelCorreo: true, consentimientoRegistrado: false })
    expect([db.events.length, db.logs.length, db.accounts[0].lastTouchAt]).toEqual([eventosAntes, logsAntes, toque])
  })

  it('🔴 sólo la casilla dos veces → la segunda, éxito sin escribir', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'ana@cafe.mx' })
    await updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: vistaDe(ana), aceptaCorreos: true })
    const n = db.events.length
    await expect(updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: vistaDe(ana), aceptaCorreos: true })).resolves.toMatchObject({
      consentimientoRegistrado: false,
    })
    expect(db.events.length).toBe(n)
  })

  it('🔴 la casilla sola con vio.email viejo sigue siendo 409 aunque el correo de ahora ya tenga permiso', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'nuevo@cafe.mx' })
    db.consents.push({ email: 'nuevo@cafe.mx', source: 'LANDING' })
    await expect(
      updateContact(access(), ACCOUNT, ana.id, { cambios: {}, vio: { ...vistaDe(ana), email: 'viejo@cafe.mx' }, aceptaCorreos: true }),
    ).rejects.toMatchObject({ code: 'CRM_CAMBIO_AL_EDITAR' })
  })

  it('🔴 correo cambiado que tenía permiso: el nuevo sin fila, el viejo conserva la suya, correoAnteriorConPermiso true', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'viejo@cafe.mx' })
    db.consents.push({ email: 'viejo@cafe.mx', source: 'LANDING' })
    const r = await updateContact(access(), ACCOUNT, ana.id, { cambios: { email: 'nuevo@cafe.mx' }, vio: vistaDe(ana) })
    expect(r).toMatchObject({ cambiados: ['email'], permisoDelCorreo: false, correoAnteriorConPermiso: true })
    expect(db.consents.map(c => c.email)).toEqual(['viejo@cafe.mx'])
  })

  it('el correo nuevo de otra persona del mismo negocio → CRM_PERSONA_YA_ESTA; de otro negocio → CRM_POSIBLE_DUPLICADO', async () => {
    seedAccount()
    const beto = seedContact({ name: 'Beto', email: 'beto@cafe.mx' })
    const ana = seedContact({ name: 'Ana', email: 'ana@cafe.mx' })
    await expect(updateContact(access(), ACCOUNT, ana.id, { cambios: { email: 'beto@cafe.mx' }, vio: vistaDe(ana) })).rejects.toMatchObject(
      { code: 'CRM_PERSONA_YA_ESTA', details: { contactId: beto.id } },
    )
    db.accounts.push({ id: 'caccountb0000000000000001', name: 'Otro', ownerStaffId: null })
    seedContact({ accountId: 'caccountb0000000000000001', phoneE164: '+525500000001' })
    await expect(updateContact(access(), ACCOUNT, ana.id, { cambios: { phone: '55 0000 0001' }, vio: vistaDe(ana) })).rejects.toMatchObject(
      { code: 'CRM_POSIBLE_DUPLICADO' },
    )
    await expect(
      updateContact(access(), ACCOUNT, ana.id, { cambios: { phone: '55 0000 0001' }, vio: vistaDe(ana), esOtroNegocio: true }),
    ).resolves.toMatchObject({ cambiados: ['phone'] })
    expect(ana.phoneE164).toBe('+525500000001')
  })

  it('hacerla principal deja a las demás en false', async () => {
    seedAccount()
    const beto = seedContact({ name: 'Beto', isPrimary: true })
    const ana = seedContact({ name: 'Ana' })
    await updateContact(access(), ACCOUNT, ana.id, { cambios: { isPrimary: true }, vio: vistaDe(ana) })
    expect([beto.isPrimary, ana.isPrimary]).toEqual([false, true])
  })

  it('🔴 A «propios» cambia una persona de la cuenta de B → 404', async () => {
    seedAccount({ ownerStaffId: OTRO })
    const ana = seedContact({ name: 'Ana' })
    await expect(
      updateContact(access({ ver: 'propios', editar: 'propios' }), ACCOUNT, ana.id, { cambios: { name: 'X' }, vio: vistaDe(ana) }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(ana.name).toBe('Ana')
  })
})

describe('Tarea 3 · removeContact: quitar persona', () => {
  it('quita, CONTACT_REMOVED {contactId, eraPrincipal}, ActivityLog sólo con el id; quitar a la principal no promueve a nadie', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', isPrimary: true })
    const beto = seedContact({ name: 'Beto' })
    await expect(removeContact(access(), ACCOUNT, ana.id, { vio: vistaDe(ana) })).resolves.toEqual({ contactId: ana.id, yaNoEstaba: false })
    await flush()
    expect(db.contacts).toEqual([beto])
    expect(beto.isPrimary).toBe(false)
    expect(eventos('CONTACT_REMOVED')).toEqual([expect.objectContaining({ data: { contactId: ana.id, eraPrincipal: true } })])
    expect(db.logs).toEqual([expect.objectContaining({ action: 'CRM_CONTACT_REMOVED', data: { contactId: ana.id } })])
  })

  it('quitar con vio viejo → 409, nada borrado', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'nuevo@cafe.mx' })
    await expect(removeContact(access(), ACCOUNT, ana.id, { vio: { ...vistaDe(ana), email: 'viejo@cafe.mx' } })).rejects.toMatchObject({
      code: 'CRM_CAMBIO_AL_EDITAR',
      details: { ahora: vistaDe(ana) },
    })
    expect(db.contacts).toHaveLength(1)
  })

  it('🔴 pasada §c3: quitar dos veces (la primera respuesta se perdió) → yaNoEstaba sin escribir; con un contactId de otra cuenta, lo mismo', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana' })
    await removeContact(access(), ACCOUNT, ana.id, { vio: vistaDe(ana) })
    const n = db.events.length
    await expect(removeContact(access(), ACCOUNT, ana.id, { vio: vistaDe(ana) })).resolves.toEqual({ contactId: ana.id, yaNoEstaba: true })
    db.accounts.push({ id: 'caccountb0000000000000001', name: 'Otro', ownerStaffId: null })
    const ajena = seedContact({ accountId: 'caccountb0000000000000001' })
    await expect(removeContact(access(), ACCOUNT, ajena.id, { vio: vistaDe(ajena) })).resolves.toEqual({
      contactId: ajena.id,
      yaNoEstaba: true,
    })
    expect(db.events.length).toBe(n)
    expect(db.contacts).toEqual([ajena])
  })
})

// ── Codex código r1 ───────────────────────────────────────────────────────────────────────────────────────────────────

/** ¿Es el candado de una identidad? (`$queryRaw` llega como plantilla o como `Prisma.sql`). */
const esCandado = (call: unknown[]) => Array.isArray(call[0]) && (call[0] as string[]).join('?').includes('pg_advisory_xact_lock')

describe('Codex código r1: llave con otro «principal», identidades entre cuentas y la transacción', () => {
  it('🔴 #1: K creó a Ana como principal; llega K con isPrimary false → 409 CRM_LLAVE_CON_OTRO_CONTENIDO', async () => {
    seedAccount()
    seedContact({ name: 'Beto', isPrimary: true })
    await addContact(access(), ACCOUNT, persona({ isPrimary: true }))
    await expect(addContact(access(), ACCOUNT, persona({ isPrimary: false }))).rejects.toMatchObject({
      code: 'CRM_LLAVE_CON_OTRO_CONTENIDO',
    })
  })

  it('🔴 #1: K creó a Ana secundaria; alguien la hace principal; llega K igual → 409 (lo creado, leído hoy, ya es otro)', async () => {
    seedAccount()
    seedContact({ name: 'Beto', isPrimary: true })
    const { contactId } = await addContact(access(), ACCOUNT, persona({ isPrimary: false }))
    db.contacts.find(c => c.id === contactId)!.isPrimary = true
    await expect(addContact(access(), ACCOUNT, persona({ isPrimary: false }))).rejects.toMatchObject({
      code: 'CRM_LLAVE_CON_OTRO_CONTENIDO',
    })
  })

  it('#1 regresión: la primera persona, sin pedir principal, nace principal y su reintento sigue siendo repetido', async () => {
    seedAccount()
    const r = await addContact(access(), ACCOUNT, persona())
    await expect(addContact(access(), ACCOUNT, persona())).resolves.toMatchObject({ contactId: r.contactId, repetido: true })
  })

  it('🔴 #2: antes de buscar duplicados toma el candado de cada identidad que escribe, en orden fijo', async () => {
    seedAccount()
    await addContact(access(), ACCOUNT, persona({ email: 'Zeta@cafe.mx', phone: '55 1234 5678' }))
    const candados = prismaMock.$queryRaw.mock.calls.filter(esCandado).map((call: unknown[]) => call[1])
    expect(candados).toEqual(['crm:identidad:email:zeta@cafe.mx', 'crm:identidad:telefono:+525512345678'])
    const ordenCandado = prismaMock.$queryRaw.mock.invocationCallOrder[prismaMock.$queryRaw.mock.calls.findIndex(esCandado)]
    expect(ordenCandado).toBeLessThan(prismaMock.crmAccount.findMany.mock.invocationCallOrder[0])
  })

  it('🔴 #2: cambiar el correo también toma su candado; cambiar sólo el puesto no toma ninguno', async () => {
    seedAccount()
    const ana = seedContact({ name: 'Ana', email: 'ana@cafe.mx' })
    const candados = () => prismaMock.$queryRaw.mock.calls.filter(esCandado)
    await updateContact(access(), ACCOUNT, ana.id, { cambios: { role: 'Dueña' }, vio: vistaDe(ana) })
    expect(candados()).toHaveLength(0)
    await updateContact(access(), ACCOUNT, ana.id, { cambios: { email: 'nueva@cafe.mx' }, vio: vistaDe(ana) })
    expect(candados().map((call: unknown[]) => call[1])).toEqual(['crm:identidad:email:nueva@cafe.mx'])
  })
})
