/**
 * «Mis reservas de clase» (`GET /public/venues/:venueSlug/customer/class-reservations`): las clases que la clienta del token ya
 * reservó, en la MISMA ventana de fechas que el horario público. El widget la usa para marcar «Reservada» en el horario y, tras un
 * error de red al confirmar, para revisar si la reserva sí quedó (compara los `confirmationCode` de una `classSessionId`).
 *
 * 🔴 Córrela en DOS zonas: el horario lee los límites del día en la zona del PROCESO (cambiar eso es deuda aparte):
 *   TZ=UTC npx jest --selectProjects unit --testPathPattern "misReservasDeClase"
 *   TZ=America/Mexico_City npx jest --selectProjects unit --testPathPattern "misReservasDeClase"
 * Las dos rutas leen `dateFrom`/`dateTo` con la misma función (`leerRangoDelHorario`), así que lo que sale en el horario sale aquí
 * en cualquier zona. No se puede cambiar la zona dentro de la prueba: Jest le da al sandbox su propio `process.env`.
 */
jest.mock('@/services/wallet/stampLedger.service', () => ({ __esModule: true, getStampCardStatus: jest.fn() }))

import fs from 'fs'
import path from 'path'
import { prismaMock } from '@tests/__helpers__/setup'
import type { ContactoProbado } from '@/jwt.service'
import * as settingsService from '@/services/dashboard/reservationSettings.service'
import * as horarioController from '@/controllers/public/reservation.public.controller'
import * as portalController from '@/controllers/public/customerPortal.public.controller'
import { filtroDeReservasDeLaClienta, getCustomerPortal } from '@/services/public/customerPortal.public.service'
import { leerRangoDelHorario } from '@/services/reservation/rangoDelHorario'
import { LUGAR_DEL_PASE } from '@/services/credits/ilimitado'
import { customerClassReservationsSchema } from '@/schemas/dashboard/creditPack.schema'

// Valores de prueba armados por una función, para que ningún escáner los tome por secretos.
const fijo = (n: string) => `Fijo-${n}-1!`

const ZONA = Intl.DateTimeFormat().resolvedOptions().timeZone
const VENUE = 'cvenue000000000000000000a'
const OTRO_VENUE = 'cvenue000000000000000000b'
const ANA = { id: 'cana00000000000000000000a', phone: '55 1111 2222' }
const OTRA = 'cotra0000000000000000000a'
const TEL: ContactoProbado = { tipo: 'PHONE', valor: '+525511112222', metodo: 'WHATSAPP', probadoEn: 1_800_000_000 }
const CORREO: ContactoProbado = { tipo: 'EMAIL', valor: 'ana@gmail.com', metodo: 'GOOGLE', probadoEn: 1_800_000_000 }
const SESION = { customerId: ANA.id, venueId: VENUE, tipo: 'SESION', contactos: [TEL, CORREO], accountActivatedAt: new Date() }
const AJUSTES = {
  scheduling: { onlineCapacityPercent: 100, minNoticeMin: 0, maxAdvanceDays: 0 },
  publicBooking: { enabled: true },
  operatingHours: null,
} as any

// ── Una base falsa que entiende las consultas de Prisma que usan estas dos rutas ──────────────────────────────────────────────

interface Sesion {
  id: string
  venueId: string
  startsAt: Date
  endsAt: Date
  status: string
  capacity: number
  productId: string
  product: { id: string; name: string; imageUrl: null; type: string; active: boolean }
  assignedStaff: null
  reservations: never[]
}
interface Canje {
  id: string
  venueId: string
  type: string
  customerId: string
  creditItemBalance: { unlimited: boolean }
  reservation?: Reserva
}
interface Reserva {
  id: string
  venueId: string
  status: string
  customerId: string | null
  guestPhone: string | null
  guestEmail: string | null
  classSessionId: string | null
  classSession: Sesion | null
  confirmationCode: string
  cancelSecret: string
  spotIds: string[]
  depositStatus: string | null
  startsAt: Date
  creditTransactions: Canje[]
}

let sesiones: Sesion[] = []
let reservas: Reserva[] = []

const OPERADORES = new Set(['in', 'gte', 'lte', 'gt', 'lt', 'equals', 'mode', 'not'])
const igual = (a: any, b: any) =>
  a instanceof Date || b instanceof Date ? a != null && b != null && new Date(a).getTime() === new Date(b).getTime() : a === b

function cumpleCampo(valor: any, cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return igual(valor, cond)
  const llaves = Object.keys(cond)
  if (llaves.length > 0 && llaves.every(k => OPERADORES.has(k))) {
    return llaves.every(k => {
      switch (k) {
        case 'in':
          return cond.in.some((x: any) => igual(valor, x))
        case 'gte':
          return valor != null && valor >= cond.gte
        case 'lte':
          return valor != null && valor <= cond.lte
        case 'gt':
          return valor != null && valor > cond.gt
        case 'lt':
          return valor != null && valor < cond.lt
        case 'equals':
          return cond.mode === 'insensitive'
            ? String(valor ?? '').toLowerCase() === String(cond.equals).toLowerCase()
            : igual(valor, cond.equals)
        case 'not':
          return !cumpleCampo(valor, cond.not)
        default:
          return true // mode
      }
    })
  }
  // Una relación: `{ is: {...} }`, `{ some: {...} }` o el atajo `{ campo: ... }`.
  if (valor == null) return false
  if ('is' in cond) return cumple(valor, cond.is)
  if ('some' in cond) return Array.isArray(valor) && valor.some(x => cumple(x, cond.some))
  return cumple(valor, cond)
}

function cumple(fila: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([llave, cond]) => {
    if (llave === 'AND') return (cond as any[]).every(w => cumple(fila, w))
    if (llave === 'OR') return (cond as any[]).some(w => cumple(fila, w))
    if (llave === 'NOT') return !cumple(fila, cond)
    return cumpleCampo(fila[llave], cond)
  })
}

const porInicioEId = (a: Reserva, b: Reserva) =>
  a.classSession!.startsAt.getTime() - b.classSession!.startsAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function proyectar(r: Reserva, select: any) {
  const fila: any = {}
  for (const llave of Object.keys(select)) {
    if (llave === 'creditTransactions') {
      const sel = select.creditTransactions
      fila.creditTransactions = r.creditTransactions
        .filter(t => cumple(t, sel.where))
        .slice(0, sel.take)
        .map(t => ({ id: t.id }))
    } else if (llave === 'classSession') {
      fila.classSession = r.classSession ? { startsAt: r.classSession.startsAt } : null
    } else {
      fila[llave] = (r as any)[llave]
    }
  }
  return fila
}

function montarBase() {
  prismaMock.customer.findFirst
    .mockReset()
    .mockImplementation(async ({ where }: any) => (where.id === ANA.id && where.venueId === VENUE ? { ...ANA } : null))
  prismaMock.reservation.findMany.mockReset().mockImplementation(async (args: any) => {
    expect(args.take).toBeDefined()
    return reservas
      .filter(r => cumple(r, args.where))
      .sort(porInicioEId)
      .slice(0, args.take)
      .map(r => proyectar(r, args.select))
  })
  prismaMock.reservation.count.mockReset().mockImplementation(async (args: any) => reservas.filter(r => cumple(r, args.where)).length)
  prismaMock.creditTransaction.findMany.mockReset().mockImplementation(async (args: any) => {
    expect(args.take).toBeDefined()
    const canjes = reservas.flatMap(r => r.creditTransactions.map(t => ({ ...t, reservation: r })))
    return canjes
      .filter(t => cumple(t, args.where))
      .slice(0, args.take)
      .map(t => ({ reservation: { classSessionId: t.reservation.classSessionId } }))
  })
  prismaMock.classSession.findMany
    .mockReset()
    .mockImplementation(async (args: any) =>
      sesiones.filter(s => cumple(s, args.where)).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
    )
  prismaMock.reservationSettings.findUnique.mockReset().mockResolvedValue(null)
  prismaMock.venue.findFirst.mockReset().mockResolvedValue({
    id: VENUE,
    name: 'Un estudio',
    slug: 'un-estudio',
    logo: null,
    type: 'FITNESS',
    timezone: 'America/Mexico_City',
    website: null,
  })
  jest.spyOn(settingsService, 'getReservationSettings').mockResolvedValue(AJUSTES)
}

let consecutivo = 0
function sesion(startsAt: string | Date, extra: Partial<Sesion> = {}): Sesion {
  const inicio = new Date(startsAt)
  const s: Sesion = {
    id: `csesion${String(++consecutivo).padStart(18, '0')}`,
    venueId: VENUE,
    startsAt: inicio,
    endsAt: new Date(inicio.getTime() + 50 * 60_000),
    status: 'SCHEDULED',
    capacity: 12,
    productId: 'cproductolagree0000000001',
    product: { id: 'cproductolagree0000000001', name: 'Lagree', imageUrl: null, type: 'CLASS', active: true },
    assignedStaff: null,
    reservations: [],
    ...extra,
  }
  sesiones.push(s)
  return s
}
function reserva(s: Sesion | null, extra: Partial<Reserva> = {}): Reserva {
  const n = String(++consecutivo).padStart(18, '0')
  const r: Reserva = {
    id: `cres000${n}`,
    venueId: VENUE,
    status: 'CONFIRMED',
    customerId: ANA.id,
    guestPhone: null,
    guestEmail: null,
    classSessionId: s?.id ?? null,
    classSession: s,
    confirmationCode: `RES-${n.slice(-6)}`,
    cancelSecret: `secreto-${n}`,
    spotIds: [],
    depositStatus: null,
    startsAt: s?.startsAt ?? new Date('2026-12-01T17:00:00Z'),
    creditTransactions: [],
    ...extra,
  }
  reservas.push(r)
  return r
}
const canje = (unlimited: boolean, extra: Partial<Canje> = {}): Canje => ({
  id: `ccanje${String(++consecutivo).padStart(19, '0')}`,
  venueId: VENUE,
  type: 'REDEEM',
  customerId: ANA.id,
  creditItemBalance: { unlimited },
  ...extra,
})

// ── Las dos rutas, llamadas como las llama Express ─────────────────────────────────────────────────────────────────────────

function respuesta() {
  const res: any = { json: jest.fn(), status: jest.fn() }
  res.status.mockReturnValue(res)
  return res
}

/** Las clases que devuelve el horario público con esas fechas (sus `classSessionId`, en orden). */
async function horario(dateFrom: string, dateTo?: string): Promise<{ ids: string[]; body: any }> {
  const res = respuesta()
  const next = jest.fn()
  const query = { type: 'class', dateFrom, ...(dateTo ? { dateTo } : {}) }
  await horarioController.getAvailability({ params: { venueSlug: 'un-estudio' }, query } as any, res, next)
  if (next.mock.calls.length) throw next.mock.calls[0][0]
  const body = res.json.mock.calls[0][0]
  return { ids: body.slots.map((s: any) => s.classSessionId), body }
}

async function misReservas(query: Record<string, string>, auth: any = SESION) {
  const res = respuesta()
  const next = jest.fn()
  await portalController.listMyClassReservations({ params: { venueSlug: 'un-estudio' }, query, customerAuth: auth } as any, res, next)
  return { body: res.json.mock.calls[0]?.[0], error: next.mock.calls[0]?.[0] }
}

/** Todas las páginas, siguiendo `nextCursor`. */
async function todasMisReservas(query: Record<string, string>, auth: any = SESION) {
  const paginas: any[] = []
  let cursor: string | null = null
  do {
    const { body, error } = await misReservas(cursor ? { ...query, cursor } : query, auth)
    if (error) throw error
    paginas.push(body)
    cursor = body.nextCursor
  } while (cursor && paginas.length < 20)
  return { paginas, filas: paginas.flatMap(p => p.reservations) }
}

beforeEach(() => {
  sesiones = []
  reservas = []
  montarBase()
})

describe(`misReservasDeClase · zona del proceso: ${ZONA}`, () => {
  describe('de quién son', () => {
    it('sólo las de la clienta del token en ese venue, incluida una de invitada con el teléfono que probó; la de OTRA ficha con su correo NO sale (ni su cancelSecret)', async () => {
      const s = sesion('2026-12-01T17:00:00Z')
      const suya = reserva(s)
      const invitadaFicha = reserva(s, { customerId: null, guestPhone: '55 1111 2222' })
      const invitadaProbado = reserva(s, { customerId: null, guestPhone: '+525511112222' })
      const invitadaCorreo = reserva(s, { customerId: null, guestEmail: 'ANA@gmail.com' })
      reserva(s, { customerId: OTRA, guestEmail: 'ana@gmail.com', cancelSecret: fijo('secreto-de-otra-ficha') })
      reserva(s, { customerId: OTRA, guestPhone: '+525511112222', cancelSecret: fijo('secreto-de-otra-ficha-2') })
      reserva(s, { customerId: null, guestPhone: '+525599998888', cancelSecret: fijo('secreto-de-otra-invitada') })
      reserva(s, { venueId: OTRO_VENUE, cancelSecret: fijo('secreto-de-otro-negocio') })

      const { body, error } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-01' })

      expect(error).toBeUndefined()
      expect(body.reservations.map((r: any) => r.confirmationCode).sort()).toEqual(
        [suya, invitadaFicha, invitadaProbado, invitadaCorreo].map(r => r.confirmationCode).sort(),
      )
      expect(body.total).toBe(4)
      const texto = JSON.stringify(body)
      expect(texto).not.toContain('secreto-de-otra-ficha')
      expect(texto).not.toContain('secreto-de-otra-invitada')
      expect(texto).not.toContain('secreto-de-otro-negocio')
    })

    it('sin contactos probados (token de reservas de hoy) ⇒ sólo las de su ficha', async () => {
      const s = sesion('2026-12-01T17:00:00Z')
      const suya = reserva(s)
      reserva(s, { customerId: null, guestPhone: '+525511112222' })

      const { body } = await misReservas(
        { dateFrom: '2026-12-01', dateTo: '2026-12-01' },
        { ...SESION, tipo: 'RESERVAS_DE_HOY', contactos: [] },
      )

      expect(body.reservations.map((r: any) => r.confirmationCode)).toEqual([suya.confirmationCode])
    })

    it('una ficha que no es de ese venue no ve nada', async () => {
      reserva(sesion('2026-12-01T17:00:00Z'))
      const { body } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-01' }, { ...SESION, venueId: OTRO_VENUE })
      expect(body).toEqual({ reservations: [], total: 0, nextCursor: null, unlimitedUsedSessionIds: [] })
    })

    it('filtroDeReservasDeLaClienta: la ficha, o una INVITADA (sin ficha) con un contacto probado', () => {
      expect(filtroDeReservasDeLaClienta(ANA, [TEL, CORREO])).toEqual({
        OR: [
          { customerId: ANA.id },
          {
            customerId: null,
            OR: [
              { guestPhone: { in: ['+525511112222', '55 1111 2222'] } },
              { guestEmail: { equals: 'ana@gmail.com', mode: 'insensitive' } },
            ],
          },
        ],
      })
      expect(filtroDeReservasDeLaClienta(ANA, [])).toEqual({ OR: [{ customerId: ANA.id }] })
    })
  })

  describe('qué reservas', () => {
    it('excluye canceladas, las que no son de clase y las ya terminadas; incluye la de quien ya llegó', async () => {
      const s = sesion('2026-12-01T17:00:00Z')
      const pendiente = reserva(s, { status: 'PENDING' })
      const confirmada = reserva(s, { status: 'CONFIRMED' })
      const llego = reserva(s, { status: 'CHECKED_IN' })
      reserva(s, { status: 'CANCELLED' })
      reserva(s, { status: 'COMPLETED' })
      reserva(s, { status: 'NO_SHOW' })
      reserva(null, { startsAt: new Date('2026-12-01T17:00:00Z') }) // una cita, sin clase

      const { body } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-01' })

      expect(body.reservations.map((r: any) => r.confirmationCode).sort()).toEqual(
        [pendiente, confirmada, llego].map(r => r.confirmationCode).sort(),
      )
      expect(body.reservations.find((r: any) => r.confirmationCode === llego.confirmationCode)).toMatchObject({
        classSessionId: s.id,
        status: 'CHECKED_IN',
        cancelSecret: llego.cancelSecret,
        startsAt: '2026-12-01T17:00:00.000Z',
        spotIds: [],
      })
    })

    it('usedUnlimited verdadero sólo si canjeó un Ilimitado; depositStatus tal cual', async () => {
      const s = sesion('2026-12-01T17:00:00Z')
      const ilimitado = reserva(s, { depositStatus: 'PAID', spotIds: ['A1'], creditTransactions: [canje(true)] })
      const normal = reserva(s, { depositStatus: null, creditTransactions: [canje(false)] })
      const sinCanje = reserva(s, { depositStatus: 'PENDING' })
      const devuelto = reserva(s, { depositStatus: 'CARD_HOLD', creditTransactions: [canje(true, { type: 'REFUND' })] })

      const { body } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-01' })
      const de = (r: Reserva) => body.reservations.find((x: any) => x.confirmationCode === r.confirmationCode)

      expect(de(ilimitado)).toMatchObject({ usedUnlimited: true, depositStatus: 'PAID', spotIds: ['A1'] })
      expect(de(normal)).toMatchObject({ usedUnlimited: false, depositStatus: null })
      expect(de(sinCanje)).toMatchObject({ usedUnlimited: false, depositStatus: 'PENDING' })
      expect(de(devuelto)).toMatchObject({ usedUnlimited: false, depositStatus: 'CARD_HOLD' })
    })

    it('unlimitedUsedSessionIds: las clases del rango donde ya canjeó un Ilimitado (los estados que cuenta el SERVIDOR), sin marcarlas como reservadas', async () => {
      const terminada = sesion('2026-12-01T13:00:00Z')
      const falto = sesion('2026-12-01T14:00:00Z')
      const cancelada = sesion('2026-12-01T15:00:00Z')
      const viva = sesion('2026-12-01T16:00:00Z')
      const conPaqueteNormal = sesion('2026-12-01T17:00:00Z')
      const deOtra = sesion('2026-12-01T18:00:00Z')
      const fueraDelRango = sesion('2026-12-20T17:00:00Z')
      reserva(terminada, { status: 'COMPLETED', creditTransactions: [canje(true)] })
      reserva(falto, { status: 'NO_SHOW', creditTransactions: [canje(true)] })
      reserva(cancelada, { status: 'CANCELLED', creditTransactions: [canje(true)] })
      const reservaViva = reserva(viva, { status: 'CONFIRMED', creditTransactions: [canje(true)] })
      reserva(conPaqueteNormal, { status: 'CONFIRMED', creditTransactions: [canje(false)] })
      reserva(deOtra, { customerId: OTRA, status: 'CONFIRMED', creditTransactions: [canje(true, { customerId: OTRA })] })
      reserva(fueraDelRango, { status: 'CONFIRMED', creditTransactions: [canje(true)] })

      const { body } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-02' })

      expect([...body.unlimitedUsedSessionIds].sort()).toEqual([terminada.id, falto.id, viva.id].sort())
      // «Terminada» y «No asistió» no se marcan como reservadas: no salen en `reservations`.
      expect(body.reservations.map((r: any) => r.classSessionId).sort()).toEqual([viva.id, conPaqueteNormal.id].sort())
      expect(body.reservations.find((r: any) => r.confirmationCode === reservaViva.confirmationCode).usedUnlimited).toBe(true)
      // Los estados son los del servidor (`LUGAR_DEL_PASE`), no una copia.
      const [args] = (prismaMock.creditTransaction.findMany as jest.Mock).mock.calls[0]
      expect(args.where.reservation.is.status.in).toBe(LUGAR_DEL_PASE)
    })
  })

  describe('la misma ventana que el horario', () => {
    it('una clase de las 18:30 de CDMX que sale en el horario con cierto dateFrom sale aquí con el mismo dateFrom', async () => {
      const s = sesion('2026-12-02T00:30:00Z') // martes 1-dic, 18:30 en CDMX
      reserva(s)
      let vecesEnElHorario = 0
      for (const dia of ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']) {
        const { ids } = await horario(dia, dia)
        const { body } = await misReservas({ dateFrom: dia, dateTo: dia })
        const aqui = body.reservations.map((r: any) => r.classSessionId)
        expect({ dia, aqui: aqui.includes(s.id) }).toEqual({ dia, aqui: ids.includes(s.id) })
        if (ids.includes(s.id)) vecesEnElHorario++
      }
      expect(vecesEnElHorario).toBe(1)
    })

    it.each([
      ['2026-12-01', '2026-12-03'],
      ['2026-12-02', '2026-12-02'],
      ['2026-12-04', undefined], // sin dateTo: los dos toman +30 días
    ])(
      'con dateFrom=%s y dateTo=%s, toda clase del horario que es suya sale aquí, también la primera y la última del rango',
      async (dateFrom, dateTo) => {
        // Una clase cada 30 minutos del 30-nov al 9-dic (UTC), más una en el último milisegundo del rango en cada zona.
        for (let t = Date.parse('2026-11-30T00:00:00Z'); t < Date.parse('2026-12-09T00:00:00Z'); t += 30 * 60_000) sesion(new Date(t))
        sesion('2026-12-03T23:59:59.999Z') // fin del 3-dic en UTC
        sesion('2026-12-04T05:59:59.999Z') // fin del 3-dic en CDMX
        sesion('2026-12-02T23:59:59.999Z')
        sesion('2026-12-03T05:59:59.999Z')
        for (const s of sesiones) reserva(s)

        const { ids: delHorario } = await horario(dateFrom, dateTo)
        const query = { dateFrom, ...(dateTo ? { dateTo } : {}) }
        const { filas } = await todasMisReservas(query)
        const aqui = new Set(filas.map((r: any) => r.classSessionId))

        expect(delHorario.length).toBeGreaterThan(0)
        expect(aqui).toContain(delHorario[0])
        expect(aqui).toContain(delHorario[delHorario.length - 1])
        expect(delHorario.filter(id => !aqui.has(id))).toEqual([])
        // Sin aviso mínimo ni horizonte, las dos ventanas son la misma: nada de más.
        expect(aqui.size).toBe(delHorario.length)
      },
    )

    it('la ventana es la del horario: medianoche y fin del día en la zona del proceso', () => {
      const r = leerRangoDelHorario('2026-12-01', '2026-12-03')
      expect(r).toEqual({
        ok: true,
        desde: new Date('2026-12-01T00:00:00'),
        hasta: new Date('2026-12-03T23:59:59.999'),
        dateTo: '2026-12-03',
        pasaDelTope: false,
      })
    })

    it('más de 60 días ⇒ 400 en español, sin tocar la base; 60 días exactos sí', async () => {
      const { error } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2027-01-31' })
      expect(error).toMatchObject({ statusCode: 400, code: 'DATE_RANGE_TOO_LONG' })
      expect(error.message).toMatch(/60 días/)
      expect(prismaMock.reservation.findMany).not.toHaveBeenCalled()

      const { body, error: sinError } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2027-01-30' })
      expect(sinError).toBeUndefined()
      expect(body.total).toBe(0)
      // El horario con esas fechas recorta (no falla): misma función, misma regla del tope.
      expect(leerRangoDelHorario('2026-12-01', '2027-01-31')).toMatchObject({ ok: true, pasaDelTope: true, dateTo: '2027-01-30' })
      expect((await horario('2026-12-01', '2027-01-31')).body.dateTo).toBe('2027-01-30')
    })

    it.each([
      [{ dateFrom: '2026-12-03', dateTo: '2026-12-01' }, /anterior/],
      [{ dateFrom: '2026-13-40' }, /inicio/],
      [{ dateFrom: '2026-12-01', dateTo: '2026-12-99' }, /final/],
      [{ dateFrom: '1 de diciembre' }, /AAAA-MM-DD/],
    ])('fechas inválidas %j ⇒ 400 en español', async (query, texto) => {
      const { error } = await misReservas(query as any)
      expect(error).toMatchObject({ statusCode: 400, code: 'INVALID_DATE_RANGE' })
      expect(error.message).toMatch(texto)
      expect(prismaMock.reservation.findMany).not.toHaveBeenCalled()
    })
  })

  describe('por páginas', () => {
    it('con 250 reservas ⇒ tres páginas (100, 100, 50), total 250 y nextCursor nulo al final; un `limit` hostil no cambia la página', async () => {
      // 84 clases con 3 reservas cada una (la última con 1): la frontera de las páginas parte una clase en dos.
      const clases = Array.from({ length: 84 }, (_, i) => sesion(new Date(Date.parse('2026-12-01T12:00:00Z') + i * 6 * 3_600_000)))
      for (const s of clases) for (let k = 0; k < 3 && reservas.length < 250; k++) reserva(s)

      const { paginas, filas } = await todasMisReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-31', limit: '5000' })

      expect(paginas.map(p => p.reservations.length)).toEqual([100, 100, 50])
      expect(paginas.map(p => p.total)).toEqual([250, 250, 250])
      expect(paginas[0].nextCursor).toEqual(expect.any(String))
      expect(paginas[2].nextCursor).toBeNull()
      const esperado = [...reservas].sort(porInicioEId).map(r => r.confirmationCode)
      expect(filas.map((r: any) => r.confirmationCode)).toEqual(esperado)
      for (const [args] of (prismaMock.reservation.findMany as jest.Mock).mock.calls) {
        expect(args.take).toBe(101)
        expect(args.orderBy).toEqual([{ classSession: { startsAt: 'asc' } }, { id: 'asc' }])
      }
    })

    it('vacío: sin reservas en el rango ⇒ página vacía, total 0', async () => {
      reserva(sesion('2026-12-20T17:00:00Z'))
      const { body } = await misReservas({ dateFrom: '2026-12-01', dateTo: '2026-12-02' })
      expect(body).toEqual({ reservations: [], total: 0, nextCursor: null, unlimitedUsedSessionIds: [] })
    })

    it('un cursor mal formado ⇒ 400 en español', async () => {
      const { error } = await misReservas({ dateFrom: '2026-12-01', cursor: 'no-es-un-cursor' })
      expect(error).toMatchObject({ statusCode: 400, message: 'Cursor inválido' })
    })
  })

  describe('el cerco y lo que no cambia', () => {
    it('la ruta usa el mismo cerco que /customer/portal, sin el candado de plan de las reservas nuevas', () => {
      const fuente = fs.readFileSync(path.resolve(__dirname, '../../../../src/routes/public.routes.ts'), 'utf8')
      expect(fuente).toMatch(
        /router\.get\(\s*'\/venues\/:venueSlug\/customer\/class-reservations',\s*portalReadLimit,\s*resolveVenueBySlug,\s*authenticateCustomer,\s*activarReservasSiFalta,\s*validateRequest\(customerClassReservationsSchema\),\s*customerPortalController\.listMyClassReservations,\s*\)/,
      )
    })

    it('la validación de la ruta habla en español y no acepta un `limit` que cambie la página', () => {
      const sinFecha = customerClassReservationsSchema.safeParse({ params: { venueSlug: 'un-estudio' }, query: {} })
      expect(sinFecha.success).toBe(false)
      expect(JSON.stringify(sinFecha)).toContain('Falta la fecha de inicio')
      const mala = customerClassReservationsSchema.safeParse({ params: { venueSlug: 'un-estudio' }, query: { dateFrom: '01/12/2026' } })
      expect(JSON.stringify(mala)).toContain('AAAA-MM-DD')
      const buena = customerClassReservationsSchema.safeParse({
        params: { venueSlug: 'un-estudio' },
        query: { dateFrom: '2026-12-01', dateTo: '2026-12-31', limit: '5000' },
      })
      expect(buena.success).toBe(true)
    })

    it('el portal sigue igual: sus reservas de invitada se buscan con los mismos filtros de antes', async () => {
      prismaMock.customer.findFirst.mockResolvedValue({ ...ANA, firstName: 'Ana', lastName: null, email: 'ana@gmail.com' })
      prismaMock.creditPackPurchase.findMany.mockResolvedValue([])
      prismaMock.reservation.findMany.mockReset().mockResolvedValue([])
      prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)

      await getCustomerPortal(VENUE, ANA.id, { contactos: [TEL, CORREO] })

      const filtros = (prismaMock.reservation.findMany as jest.Mock).mock.calls.map(([q]) => q.where.OR)
      const antes = [
        { customerId: ANA.id },
        { guestPhone: { in: ['+525511112222', '55 1111 2222'] } },
        { guestEmail: { equals: 'ana@gmail.com', mode: 'insensitive' } },
      ]
      expect(filtros).toEqual([antes, antes])
    })

    it('el horario conserva sus mensajes, su +30 días por omisión y su recorte a 60', async () => {
      await expect(horario('2026-13-40')).rejects.toMatchObject({ statusCode: 400, message: 'dateFrom is not a valid date' })
      await expect(horario('2026-12-03', '2026-12-01')).rejects.toMatchObject({
        statusCode: 400,
        message: 'dateTo must be on or after dateFrom',
      })
      expect((await horario('2026-12-01')).body.dateTo).toBe('2026-12-31')
      expect((await horario('2026-12-01', '2027-03-01')).body.dateTo).toBe('2027-01-30')
    })
  })
})
