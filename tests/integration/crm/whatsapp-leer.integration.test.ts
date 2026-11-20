/**
 * Reading the sales WhatsApp in the CRM, against a real Postgres, the real JWT and the whole app through supertest (promesa
 * Avoqado/docs/audit/2026-11-20-crm-whatsapp-leer/promesa.md, «Casos que deben tener prueba»).
 *
 * The unit project's Prisma mock cannot prove these: the grouping SQL, the keyset over `(lastAt, phone)` and `(sentAt, id)`,
 * the photo (`receivedAt <= hasta`) and the guard that turns a seller away before reading their key row.
 *
 * Run with (the cloud creates and migrates its own database):
 *   ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration --runTestsByPath tests/integration/crm/whatsapp-leer.integration.test.ts --ci
 */
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import { getInitialStage } from '@/services/crm/accounts.service'
import prisma from '@/utils/prismaClient'

const suffix = `crmwa${Date.now()}`
// Seven digits shared by every phone of this file: `q` with them scopes the list to what this file created.
const P7 = String(Date.now()).slice(-7)
const phone = (area: string) => `+52${area}${P7}`
const A = phone('222') // Alfa: 60 messages, two of the same second on a page boundary
const B = phone('442') // nobody's: «sin prospecto»
const C1 = phone('664') // Gama, first person
const C2 = phone('777') // Gama, second person
const D = phone('998') // Delta, archived
const E = phone('871') // two businesses
const G = `+999${P7}0` // a number the webhook could not read: stored as `+digits`
const H = phone('614') // nobody's, with a profile name that has digits and no letters (Codex r3 #3)
const PHONES = [A, B, C1, C2, D, E, G, H]

const T0 = new Date('2026-11-20T15:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

let server: Server
let founderToken: string
let sellerToken: string
let sellerEmail: string
const staffIds: string[] = []
const accountIds: string[] = []
let orgId: string
let venueId: string
let alfa: string
let gama: string
let epsDos: string
let epsMasViejo: string

let wamidSeq = 0
type Extra = Partial<{ direction: string; origin: string; body: string | null; contactName: string; type: string }>
const msg = (contactPhone: string, sentAt: Date, extra: Extra = {}) => ({
  wamid: `wamid.${suffix}.${(wamidSeq += 1)}`,
  phoneNumberId: '172120165993202',
  contactPhone,
  contactName: extra.contactName ?? null,
  direction: extra.direction ?? 'ENTRA',
  origin: extra.origin ?? 'MENSAJE',
  type: extra.type ?? 'text',
  body: 'body' in extra ? (extra.body ?? null) : `hola ${wamidSeq}`,
  sentAt,
  raw: {},
})

const get = (path: string, token = founderToken) => request(server).get(path).set('Authorization', `Bearer ${token}`)
const chats = (query: Record<string, string>) => get(`/api/v1/crm/whatsapp/chats?${new URLSearchParams({ q: P7, ...query })}`)
const thread = (query: Record<string, string>) => get(`/api/v1/crm/whatsapp/messages?${new URLSearchParams(query)}`)

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(done => server.once('listening', () => done()))

  orgId = (await prisma.organization.create({ data: { name: `Org ${suffix}`, email: `org-${suffix}@test.mx`, phone: '5555555555' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Venue ${suffix}`, slug: `venue-${suffix}` } })).id

  const founder = await prisma.staff.create({
    data: { email: `founder-${suffix}@test.mx`, firstName: 'Founder', lastName: 'WA', emailVerified: true },
  })
  await prisma.staffVenue.create({ data: { staffId: founder.id, venueId, role: StaffRole.SUPERADMIN, active: true } })
  sellerEmail = `seller-${suffix}@test.mx`
  const seller = await prisma.staff.create({ data: { email: sellerEmail, firstName: 'Seller', lastName: 'WA', emailVerified: true } })
  await prisma.staffVenue.create({ data: { staffId: seller.id, venueId, role: StaffRole.VIEWER, active: true } })
  // Every key, unclaimed (`staffId: null`): a 403 must not claim it (Codex r1 #8).
  await prisma.platformAccess.create({
    data: {
      email: sellerEmail,
      verScope: 'todos',
      editarScope: 'todos',
      contactar: true,
      campanas: true,
      exportar: true,
      ventas: true,
      admin: true,
      cerrar: true,
      bajas: true,
      plantillas: true,
      preparar: true,
      mandar: true,
      verCampanas: true,
      equipo: true,
      configurar: true,
      createdById: founder.id,
    },
  })
  staffIds.push(founder.id, seller.id)
  const sign = (sub: string, role: StaffRole) =>
    jwt.sign({ sub, orgId, venueId, role }, process.env.ACCESS_TOKEN_SECRET as string, { expiresIn: '15m' })
  founderToken = sign(founder.id, StaffRole.SUPERADMIN)
  sellerToken = sign(seller.id, StaffRole.VIEWER)

  const stageId = (await getInitialStage()).id
  const account = async (name: string, phones: string[], archivedAt: Date | null = null) => {
    const { id } = await prisma.crmAccount.create({
      data: {
        name: `${name} ${suffix}`,
        source: 'MANUAL',
        stageId,
        archivedAt,
        contacts: { create: phones.map((phoneE164, i) => ({ name: `${name} ${i}`, phoneE164, isPrimary: i === 0 })) },
      },
    })
    accountIds.push(id)
    return id
  }
  alfa = await account('Alfa', [A])
  gama = await account('Gama', [C1, C2])
  await account('Delta', [D], new Date())
  // Two businesses with E: the OLDER business gets its person with E only AFTER the newer one (Codex r2 #5).
  const epsUno = await account('Eps uno', [])
  epsDos = await account('Eps dos', [E])
  await prisma.crmContact.create({ data: { accountId: epsUno, name: 'Eps uno 0', phoneE164: E } })
  epsMasViejo = epsUno

  // Alfa: 60 messages, 1 per minute; the 11th and 12th (from the oldest) share the same second. With the message the list
  // test adds mid-walk there are 61, so a page of 50 from the newest ends right between those two.
  const alfaRows = Array.from({ length: 60 }, (_, i) =>
    msg(A, at(i < 11 ? i * 60 : (i - 1) * 60), { direction: i % 2 ? 'SALE' : 'ENTRA', origin: i % 2 ? 'ECO' : 'MENSAJE' }),
  )
  await prisma.crmWhatsappMessage.createMany({
    data: [
      ...alfaRows,
      msg(B, at(4000), { contactName: 'Beto Suelto' }),
      msg(B, at(4100), { direction: 'SALE', origin: 'ECO', body: 'Te paso precios' }),
      msg(C1, at(5000), { body: 'soy la dueña' }),
      msg(C2, at(5100), { body: 'soy el gerente' }),
      msg(D, at(6000)),
      msg(E, at(7000), { contactName: 'Ernesto' }),
      msg(G, at(8000), { type: 'image', body: null }),
      msg(H, at(3000), { contactName: '📦 2026' }),
    ],
  })
})

afterAll(async () => {
  try {
    // Every delete is keyed by what this file created: a `where` with an undefined value would wipe the table.
    await prisma.crmWhatsappMessage.deleteMany({ where: { contactPhone: { in: PHONES } } })
    if (accountIds.length) await prisma.crmAccount.deleteMany({ where: { id: { in: accountIds } } })
    await prisma.platformAccess.deleteMany({ where: { email: sellerEmail } })
    if (staffIds.length) {
      await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffIds } } })
      await prisma.staff.deleteMany({ where: { id: { in: staffIds } } })
    }
    if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  } finally {
    await new Promise<void>(done => server.close(() => done()))
  }
})

describe('quién lee', () => {
  it('caso 1: un vendedor con TODAS las llaves recibe 403 en las dos rutas, y su fila de llaves queda sin reclamar', async () => {
    const before = await prisma.platformAccess.findUnique({ where: { email: sellerEmail }, select: { staffId: true, llavesVersion: true } })

    const lista = await get(`/api/v1/crm/whatsapp/chats`, sellerToken)
    const hilo = await get(`/api/v1/crm/whatsapp/messages?phone=${encodeURIComponent(A)}`, sellerToken)

    expect([lista.status, hilo.status]).toEqual([403, 403])
    expect(lista.body.code).toBe('CRM_FORBIDDEN')
    expect(JSON.stringify([lista.body, hilo.body])).not.toContain(P7)
    const after = await prisma.platformAccess.findUnique({ where: { email: sellerEmail }, select: { staffId: true, llavesVersion: true } })
    expect(after).toEqual(before)
    expect(after?.staffId).toBeNull()
  })

  it('el superadmin sí entra', async () => {
    expect((await chats({})).status).toBe(200)
  })
})

describe('la lista de chats', () => {
  it('una fila por teléfono, la más reciente arriba, con su último mensaje, su conteo y su negocio', async () => {
    const res = await chats({})

    expect(res.status).toBe(200)
    expect(res.body.meta.total).toBe(8)
    expect(res.body.data.map((row: { telefono: string }) => row.telefono)).toEqual([G, E, D, C2, C1, B, A, H])
    const byPhone = Object.fromEntries(res.body.data.map((row: { telefono: string }) => [row.telefono, row]))
    expect(byPhone[A]).toMatchObject({ mensajes: 60, negocio: { id: alfa, archivado: false }, otrosNegocios: 0 })
    expect(byPhone[B]).toMatchObject({
      mensajes: 2,
      nombre: 'Beto Suelto',
      negocio: null,
      ultimo: { texto: 'Te paso precios', direccion: 'SALE', origen: 'ECO' },
    })
    expect(byPhone[C1].negocio.id).toBe(gama)
    expect(byPhone[D].negocio.archivado).toBe(true)
    // Caso: un teléfono en dos negocios dice el primero y cuántos más.
    expect(byPhone[E]).toMatchObject({ nombre: 'Ernesto', otrosNegocios: 1, negocio: { id: epsMasViejo } })
    expect(byPhone[E].negocio.id).not.toBe(epsDos)
    expect(byPhone[G]).toMatchObject({ negocio: null, telefonoValido: false, ultimo: { tipo: 'image', texto: null } })
    expect(byPhone[B].telefonoValido).toBe(true)
  })

  it('caso 6: «sin prospecto» no trae los de un prospecto archivado', async () => {
    const res = await chats({ sinProspecto: 'true' })

    expect(res.body.data.map((row: { telefono: string }) => row.telefono)).toEqual([G, B, H])
    expect(res.body.meta.total).toBe(3)
  })

  it('caso 8: q busca por el nombre de perfil, en el servidor; sólo dígitos busca el teléfono', async () => {
    const res = await get(`/api/v1/crm/whatsapp/chats?q=beto%20sue`)
    expect(res.body.data.map((row: { telefono: string }) => row.telefono)).toEqual([B])

    const porTelefono = await get(`/api/v1/crm/whatsapp/chats?q=${encodeURIComponent(`(442) ${P7}`)}`)
    expect(porTelefono.body.data.map((row: { telefono: string }) => row.telefono)).toEqual([B])

    // Digits with an emoji is a name too: «📦 2026» is found by its profile name, not only by the phone (Codex r3 #3).
    const conEmoji = await get(`/api/v1/crm/whatsapp/chats?q=${encodeURIComponent('📦 2026')}`)
    expect(conEmoji.body.data.map((row: { telefono: string }) => row.telefono)).toContain(H)
  })

  it('casos 4 y 7: paginar no repite ni salta, el total no cambia, aunque un chat reciba un mensaje a media recorrida', async () => {
    const seen: string[] = []
    const totals: number[] = []
    let cursor: string | null = null
    let page = 0
    do {
      const res: request.Response = await chats({ limit: '2', ...(cursor ? { cursor } : {}) })
      expect(res.status).toBe(200)
      seen.push(...res.body.data.map((row: { telefono: string }) => row.telefono))
      totals.push(res.body.meta.total)
      cursor = res.body.meta.nextCursor
      page += 1
      // After the first page, a chat of a later page gets a new message (the newest of all).
      if (page === 1) await prisma.crmWhatsappMessage.create({ data: msg(A, new Date(), { body: 'nuevo a media recorrida' }) })
    } while (cursor)

    expect(seen).toEqual([G, E, D, C2, C1, B, A, H])
    expect(new Set(totals)).toEqual(new Set([8]))
    // A new first page sees it on top.
    const fresh = await chats({ limit: '1' })
    expect(fresh.body.data[0]).toMatchObject({ telefono: A, ultimo: { texto: 'nuevo a media recorrida' } })
  })

  it('la foto: el chat que va en la segunda página sigue ahí aunque le llegue un mensaje', async () => {
    const first = await chats({ limit: '7' })
    const enPrimera = new Set(first.body.data.map((row: { telefono: string }) => row.telefono))
    const pendiente = PHONES.find(p => !enPrimera.has(p)) as string
    await prisma.crmWhatsappMessage.create({ data: msg(pendiente, new Date(), { body: 'llegó después de la foto' }) })
    const second = await chats({ limit: '7', cursor: first.body.meta.nextCursor })

    expect(second.body.data.map((row: { telefono: string }) => row.telefono)).toEqual([pendiente])
    expect(second.body.data[0].ultimo.texto).not.toBe('llegó después de la foto')
    expect(second.body.meta.total).toBe(first.body.meta.total)
  })
})

describe('el hilo', () => {
  it('casos 2 y 3: 60 mensajes = 50 + 10 en orden, sin huecos ni repetidos, con dos de la misma hora en la frontera', async () => {
    const first = await thread({ accountId: alfa })
    expect(first.status).toBe(200)
    // The message written mid-walk above is the 61st.
    expect(first.body.meta.total).toBe(61)
    expect(first.body.data).toHaveLength(50)
    const second = await thread({ accountId: alfa, cursor: first.body.meta.nextCursor })
    expect(second.body.data).toHaveLength(11)
    expect(second.body.meta.nextCursor).toBeNull()

    const all = [...second.body.data, ...first.body.data]
    expect(new Set(all.map((m: { id: string }) => m.id)).size).toBe(61)
    const keys = all.map((m: { sentAt: string; id: string }) => `${m.sentAt}|${m.id}`)
    expect(keys).toEqual([...keys].sort())
  })

  it('caso 5: un negocio con dos personas junta sus dos chats y cada mensaje dice su teléfono', async () => {
    const res = await thread({ accountId: gama })

    expect(res.body.data.map((m: { contactPhone: string; body: string }) => [m.contactPhone, m.body])).toEqual([
      [C1, 'soy la dueña'],
      [C2, 'soy el gerente'],
    ])
  })

  it('caso 4: el teléfono en cualquier forma (521…, sin +) abre el mismo chat', async () => {
    const res = await thread({ phone: `521222${P7}`, limit: '1' })

    expect(res.body.data[0].contactPhone).toBe(A)
    expect(res.body.meta.total).toBe(61)
  })

  it('el chat de un número que el webhook no pudo leer (+dígitos) también se abre', async () => {
    const res = await thread({ phone: G })

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ contactPhone: G, type: 'image', body: null })
  })

  it('caso 9: negocio que no existe 404, teléfono que no se entiende 400, ninguno o los dos 400, cursor roto 400', async () => {
    expect((await thread({ accountId: 'cnoexiste0000000000000000' })).status).toBe(404)
    expect((await thread({ phone: 'hola' })).status).toBe(400)
    expect((await thread({})).status).toBe(400)
    expect((await thread({ phone: A, accountId: alfa })).status).toBe(400)
    expect((await thread({ phone: A, cursor: 'no-es-un-cursor' })).status).toBe(400)
  })
})

it('caso 10: leer no escribe nada', async () => {
  const before = await prisma.crmWhatsappMessage.count({ where: { contactPhone: { in: PHONES } } })

  await chats({})
  await thread({ accountId: alfa })

  expect(await prisma.crmWhatsappMessage.count({ where: { contactPhone: { in: PHONES } } })).toBe(before)
})
