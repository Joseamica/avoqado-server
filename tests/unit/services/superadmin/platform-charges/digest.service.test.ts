import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import emailService from '@/services/email.service'
import { generateAllActive } from '@/services/superadmin/platform-charges/charges.service'
import {
  __resetPlatformChargeDigestForTests,
  buildPlatformChargeDigest,
  runPlatformChargeDigest,
} from '@/services/superadmin/platform-charges/digest.service'
import { calendarDayToDb } from '@/services/superadmin/platform-charges/schedule'

jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendEmailWithResult: jest.fn() } }))
jest.mock('@/services/superadmin/platform-charges/charges.service', () => ({
  ...jest.requireActual('@/services/superadmin/platform-charges/charges.service'),
  generateAllActive: jest.fn(),
}))

/**
 * «Por cobrar» — el correo diario al founder (spec 2026-11-02-por-cobrar-superadmin §7).
 *
 * Es dinero y fechas, así que esta suite se corre también con `TZ=UTC` y con otras zonas: todo «ahora» es un instante fijo y el día
 * sale siempre de CDMX. Las dos tablas (`PlatformChargeDigest` y `PlatformChargeOccurrence`) son dobles en memoria que EJECUTAN los
 * filtros que el servicio les manda (un operador que el doble no conoce lanza, y se niega a leer sin `take`), así que lo que se
 * afirma es qué filas entran al correo y cuáles no, no la forma exacta de cada llamada a Prisma. Qué NO prueba un doble: que Postgres
 * resuelva igual un `none` sobre la relación ni el orden con un `@db.Date`; esto no usa ninguna base real.
 *
 * 🔴 Quién puede mandar: la llave `por-cobrar:<día>` y el correo de verdad son de PRODUCCIÓN. Fuera de ella la vuelta no hace nada si no
 * está `PLATFORM_CHARGES_SANDBOX=true`, y con la bandera sale «[PRUEBA]» con la llave `por-cobrar-prueba:<día>`. Por eso las pruebas de
 * la vuelta que fijan `por-cobrar:<día>` declaran `NODE_ENV=production` (`asProduction`), y el `afterEach` lo restaura.
 */

const send = emailService.sendEmailWithResult as jest.Mock
const generate = generateAllActive as jest.Mock
const mockLoggerError = (logger as unknown as { error: jest.Mock }).error
const mockLoggerWarn = (logger as unknown as { warn: jest.Mock }).warn
/** Los avisos y errores de ESTE módulo (el logger es global y otros módulos también escriben en él). */
const ours = (mock: jest.Mock) => mock.mock.calls.filter(([message]) => String(message).startsWith('[platform-charges]'))

const MIN = 60_000
const HOUR = 60 * MIN
/** Lunes 2-nov-2026, 9:00:39 en CDMX (UTC−6 todo el año desde 2022): la primera vuelta que puede mandar. */
const T0 = new Date('2026-11-02T15:00:39Z')
const DAY = '2026-11-02'
const YESTERDAY = '2026-11-01'
const KEY = `por-cobrar:${DAY}`
const RECIPIENT = 'jose@avoqado.io'
/** Ayer a las 23:45 en CDMX: lo que reservó un proceso que murió casi a medianoche. */
const LAST_NIGHT = new Date('2026-11-02T05:45:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN)

const ORIGINAL_ENV = {
  sandbox: process.env.PLATFORM_CHARGES_SANDBOX,
  url: process.env.SUPERADMIN_URL,
  nodeEnv: process.env.NODE_ENV,
}
/** Una asignación de `undefined` escribiría el texto "undefined": se borra la variable. */
function restoreEnv(name: 'PLATFORM_CHARGES_SANDBOX' | 'SUPERADMIN_URL' | 'NODE_ENV', value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
/** El `afterEach` de abajo restaura `NODE_ENV`: cada prueba que lo cambia lo deja como estaba. */
const asProduction = () => restoreEnv('NODE_ENV', 'production')

// ── Doble de PlatformChargeDigest ───────────────────────────────────────────────────────────────────────────────────────────

interface DigestRow {
  day: string
  status: string
  attempts: number
  reservedAt: Date
  createdAt: Date
  content: unknown
}
let digests: DigestRow[]
/** Cuántas marcas «ENVIADO» siguen reventando: el proceso murió justo después de que Resend tomó el correo. */
let crashesAfterSend: number

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Array<Record<string, unknown>>).some(alt => matches(row, alt))
    const value = row[field]
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
    if (cond && typeof cond === 'object') {
      const op = cond as { in?: unknown[]; lt?: number | Date; gt?: number | Date }
      if (op.in) return op.in.includes(value)
      if (op.lt !== undefined) return (value as number | Date) < op.lt
      if (op.gt !== undefined) return (value as number | Date) > op.gt
      throw new Error(`operador no soportado en ${field}`)
    }
    return value === cond
  })

// ── Doble de PlatformChargeOccurrence ───────────────────────────────────────────────────────────────────────────────────────

interface OccRow {
  id: string
  dueDate: Date
  concepts: unknown
  totalCents: number
  status: string
  invoiceMode: string
  paidAt: Date | null
  /** Las facturas ligadas (`PlatformCfdi.platformChargeOccurrenceId`), sólo con su estado. */
  invoices: Array<{ status: string }>
  charge: { customerName: string }
}
let occurrences: OccRow[]
let seq = 0

const RENTA = { description: 'Renta de terminal', amountCents: 50000, ivaMode: 'WITHOUT_IVA', satProductKey: '81112401', satUnitKey: 'E48' }
const LICENCIA = { description: 'Licencia', amountCents: 49900, ivaMode: 'WITH_IVA', satProductKey: '43232611', satUnitKey: 'E48' }

function occ(over: Partial<OccRow> = {}): OccRow {
  seq += 1
  return {
    id: `coccdigest${String(seq).padStart(15, '0')}`,
    dueDate: calendarDayToDb(DAY),
    concepts: [RENTA],
    totalCents: 58000,
    status: 'PENDING',
    invoiceMode: 'AUTOMATIC',
    paidAt: null,
    invoices: [],
    charge: { customerName: 'Estética Luna' },
    ...over,
  }
}
/** Vence hoy (CDMX) y sigue pendiente. */
const dueToday = (over: Partial<OccRow> = {}) => occ({ dueDate: calendarDayToDb(DAY), ...over })
/** Venció en `day` y sigue pendiente. */
const overdue = (day: string, over: Partial<OccRow> = {}) => occ({ dueDate: calendarDayToDb(day), ...over })
/** Pagada hace `days` días (de 24 h), automática, sin factura ligada. */
const paid = (days: number, over: Partial<OccRow> = {}) =>
  occ({ status: 'PAID', paidAt: new Date(T0.getTime() - days * 24 * HOUR), dueDate: calendarDayToDb('2026-10-20'), ...over })

/** El doble ejecuta SÓLO los filtros que el correo usa: un operador nuevo o desconocido lanza en vez de pasar en silencio. */
function matchesOcc(row: OccRow, where: Record<string, any>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    switch (field) {
      case 'status':
      case 'invoiceMode':
        if (typeof cond !== 'string') throw new Error(`operador no soportado en ${field}`)
        return row[field] === cond
      case 'dueDate':
        if (cond instanceof Date) return row.dueDate.getTime() === cond.getTime()
        if (cond && Object.keys(cond).join() === 'lt') return row.dueDate.getTime() < cond.lt.getTime()
        throw new Error('operador no soportado en dueDate')
      case 'paidAt':
        if (cond && Object.keys(cond).join() === 'gte') return row.paidAt !== null && row.paidAt.getTime() >= cond.gte.getTime()
        throw new Error('operador no soportado en paidAt')
      case 'invoices':
        // `none`: ninguna factura ligada cumple. Una relación `some` o `every` aquí cambiaría el significado: lanza.
        if (cond?.none?.status?.in) return !row.invoices.some(invoice => cond.none.status.in.includes(invoice.status))
        throw new Error('operador no soportado en invoices')
      default:
        throw new Error(`filtro no soportado: ${field}`)
    }
  })
}

function sortOcc(rows: OccRow[], orderBy: Array<Record<string, any>>): OccRow[] {
  const key = (row: OccRow, spec: Record<string, any>): number | string => {
    const [field] = Object.keys(spec)
    if (field === 'dueDate') return row.dueDate.getTime()
    if (field === 'paidAt') return row.paidAt?.getTime() ?? 0
    if (field === 'charge') return row.charge.customerName
    if (field === 'id') return row.id
    throw new Error(`orden no soportado: ${field}`)
  }
  return [...rows].sort((a, b) => {
    for (const spec of orderBy) {
      const [x, y] = [key(a, spec), key(b, spec)]
      if (x !== y) return (x < y ? -1 : 1) * (Object.values(spec)[0] === 'desc' ? -1 : 1)
    }
    return 0
  })
}

const sentEmails = () => send.mock.calls.map(([email]) => email)

beforeEach(() => {
  __resetPlatformChargeDigestForTests()
  digests = []
  occurrences = []
  crashesAfterSend = 0
  seq = 0
  delete process.env.PLATFORM_CHARGES_SANDBOX
  process.env.SUPERADMIN_URL = 'https://superadmin.test'
  send.mockReset().mockResolvedValue({ ok: true, transient: false })
  generate.mockReset().mockResolvedValue(undefined)

  prismaMock.platformChargeDigest.findUnique.mockReset().mockImplementation(async ({ where }: { where: { day: string } }) => {
    const row = digests.find(d => d.day === where.day)
    return row ? { ...row } : null
  })
  prismaMock.platformChargeDigest.findMany
    .mockReset()
    .mockImplementation(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      if (take === undefined) throw new Error('findMany sin take')
      return digests
        .filter(d => matches({ ...d }, where))
        .sort((a, b) => (a.day < b.day ? -1 : 1))
        .slice(0, take)
        .map(d => ({ ...d }))
    })
  prismaMock.platformChargeDigest.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: Omit<DigestRow, 'attempts'> & { attempts?: number } }) => {
      if (digests.some(d => d.day === data.day)) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
      }
      const created = { attempts: 0, ...data }
      digests.push(created)
      return { ...created }
    })
  prismaMock.platformChargeDigest.updateMany
    .mockReset()
    .mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (data.status === 'ENVIADO' && crashesAfterSend > 0) {
        crashesAfterSend--
        throw new Error('the process died after sending')
      }
      const hit = digests.filter(d => matches({ ...d }, where))
      for (const d of hit) {
        const { attempts, ...rest } = data as { attempts?: number | { increment: number } }
        Object.assign(d, rest)
        if (attempts !== undefined) d.attempts = typeof attempts === 'number' ? attempts : d.attempts + attempts.increment
      }
      return { count: hit.length }
    })

  prismaMock.platformChargeOccurrence.findMany
    .mockReset()
    .mockImplementation(
      async ({ where, orderBy, take }: { where: Record<string, any>; orderBy: Array<Record<string, any>>; take?: number }) => {
        if (take === undefined) throw new Error('findMany sin take')
        if (!orderBy?.length || Object.keys(orderBy[orderBy.length - 1])[0] !== 'id') throw new Error('el orden debe terminar en id')
        return sortOcc(
          occurrences.filter(o => matchesOcc(o, where)),
          orderBy,
        )
          .slice(0, take)
          .map(o => ({ ...o }))
      },
    )
  prismaMock.platformChargeOccurrence.count
    .mockReset()
    .mockImplementation(async ({ where }: { where: Record<string, any> }) => occurrences.filter(o => matchesOcc(o, where)).length)
})

afterEach(() => {
  restoreEnv('PLATFORM_CHARGES_SANDBOX', ORIGINAL_ENV.sandbox)
  restoreEnv('SUPERADMIN_URL', ORIGINAL_ENV.url)
  restoreEnv('NODE_ENV', ORIGINAL_ENV.nodeEnv)
})

const SAVED = { to: RECIPIENT, subject: 'Por cobrar: 2 vencidos', html: '<p>guardado</p>', text: 'guardado' }
const leftover = (over: Partial<DigestRow> = {}): DigestRow => ({
  day: DAY,
  status: 'FALLO',
  attempts: 1,
  reservedAt: at(-20),
  createdAt: at(-20),
  content: SAVED,
  ...over,
})

describe('runPlatformChargeDigest — cuándo manda', () => {
  beforeEach(asProduction)

  it('a las 9:00 con algo por cobrar: aparta, manda a jose@avoqado.io con la llave del día y marca ENVIADO', async () => {
    occurrences = [dueToday()]

    await runPlatformChargeDigest(T0)

    expect(send).toHaveBeenCalledTimes(1)
    const [email] = sentEmails()
    expect(email).toEqual(expect.objectContaining({ to: RECIPIENT, idempotencyKey: KEY }))
    // La fila guarda el correo TAL CUAL: es lo que una retoma repetirá con la misma llave.
    expect(digests).toEqual([
      expect.objectContaining({
        day: DAY,
        status: 'ENVIADO',
        attempts: 0,
        reservedAt: T0,
        createdAt: T0,
        content: { to: RECIPIENT, subject: email.subject, html: email.html, text: email.text },
      }),
    ])
  })

  it('genera las ocurrencias ANTES de armar el correo, para que lo que vence hoy ya exista', async () => {
    occurrences = [dueToday()]
    await runPlatformChargeDigest(T0)

    expect(generate).toHaveBeenCalledWith(T0)
    expect(generate.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.platformChargeDigest.create.mock.invocationCallOrder[0])
  })

  it('a las 8:59 no crea el correo del día (ni genera), pero sí termina lo pendiente', async () => {
    digests = [leftover({ day: YESTERDAY, attempts: 1 })]
    occurrences = [dueToday(), overdue('2026-10-28')]

    await runPlatformChargeDigest(at(-1)) // 8:59:39 en CDMX

    // Sólo salió lo que había quedado a medias, con el contenido guardado y la llave de SU día.
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ ...SAVED, idempotencyKey: `por-cobrar:${YESTERDAY}` })
    expect(digests.map(d => [d.day, d.status])).toEqual([[YESTERDAY, 'ENVIADO']])
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()

    // Un minuto después sí sale el de hoy, aparte y con su propia llave.
    await runPlatformChargeDigest(T0)
    expect(sentEmails().map(email => email.idempotencyKey)).toEqual([`por-cobrar:${YESTERDAY}`, KEY])
  })

  it('la hora es la de CDMX: a las 03:00 de CDMX (09:00 UTC) todavía no sale, y a las 23:30 de CDMX sale y «hoy» sigue siendo hoy', async () => {
    occurrences = [dueToday()]

    await runPlatformChargeDigest(new Date('2026-11-02T09:00:39Z')) // 03:00 en CDMX: un código en UTC creería que ya son las 9
    expect(send).not.toHaveBeenCalled()
    await runPlatformChargeDigest(new Date('2026-11-03T14:59:39Z')) // 08:59 del 3-nov en CDMX
    expect(send).not.toHaveBeenCalled()

    // 23:30 del 2-nov en CDMX; en UTC ya es el 3-nov. La fila de hoy sigue siendo «Hoy» y el día de la llave es el 2.
    await runPlatformChargeDigest(new Date('2026-11-03T05:30:39Z'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentEmails()[0].idempotencyKey).toBe(KEY)
    expect(sentEmails()[0].text).toMatch(/HOY \(1\)/)
    expect(sentEmails()[0].text).not.toMatch(/VENCIDOS/)
  })

  it('sin nada que decir no crea fila; el cobro que aparece después sale en la vuelta siguiente', async () => {
    await runPlatformChargeDigest(T0)
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(digests).toEqual([])

    // Un cobro dado de alta a las 14:00 que vence hoy: sale a las 14:15, no hasta mañana.
    occurrences = [dueToday()]
    await runPlatformChargeDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
    expect(digests).toEqual([expect.objectContaining({ day: DAY, status: 'ENVIADO' })])
  })

  it('lo próximo no provoca correo, y cuando otra cosa lo provoca, lo próximo no aparece en él', async () => {
    occurrences = [
      occ({ dueDate: calendarDayToDb('2026-11-03'), charge: { customerName: 'Próximo Uno' } }),
      occ({ dueDate: calendarDayToDb('2026-11-09'), charge: { customerName: 'Próximo Dos' } }),
    ]
    await runPlatformChargeDigest(T0)
    expect(send).not.toHaveBeenCalled()
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()

    occurrences.push(overdue('2026-10-30', { charge: { customerName: 'Vencido Uno' } }))
    await runPlatformChargeDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
    const [email] = sentEmails()
    expect(email.text).toContain('Vencido Uno')
    expect(email.text).not.toContain('Próximo')
    expect(email.html).not.toContain('Próximo')
  })

  it('🔴 con la fila ENVIADO de hoy no manda otro, aunque aparezca un cobro nuevo (Review Focus)', async () => {
    occurrences = [dueToday()]
    await runPlatformChargeDigest(T0)
    expect(send).toHaveBeenCalledTimes(1)

    occurrences.push(overdue('2026-10-29', { charge: { customerName: 'Cobro Nuevo' } }))
    for (const minutes of [15, 30, 45, 60]) await runPlatformChargeDigest(at(minutes))

    expect(send).toHaveBeenCalledTimes(1)
    expect(digests).toHaveLength(1)
    expect(digests[0].status).toBe('ENVIADO')
  })

  it('🔴 un cobro que vence HOY y se da de alta DESPUÉS del correo no provoca otro hoy, y mañana a las 9:00 sale en «Vencidos» (Review Focus)', async () => {
    // El correo de hoy sale a las 9:00 por un cobro que ya había vencido.
    occurrences = [overdue('2026-10-30', { charge: { customerName: 'Vencido De Antes' } })]
    await runPlatformChargeDigest(T0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentEmails()[0].text).toContain('Vencido De Antes')

    // A las 14:00 se da de alta un cobro que vence HOY. Ya hay fila de hoy: ninguna vuelta del resto del día (hasta las 23:59) manda otro.
    occurrences.push(dueToday({ charge: { customerName: 'Cobro De Hoy Tardío' } }))
    for (const minutes of [300, 315, 600, 899]) await runPlatformChargeDigest(at(minutes))
    expect(send).toHaveBeenCalledTimes(1)
    expect(digests).toHaveLength(1)

    // Mañana a las 9:00 ese mismo cobro ya está vencido: sale en «Vencidos» del correo de mañana, con la llave de mañana, y no en «Hoy».
    await runPlatformChargeDigest(new Date(T0.getTime() + 24 * HOUR))
    expect(send).toHaveBeenCalledTimes(2)
    const second = sentEmails()[1]
    expect(second.idempotencyKey).toBe('por-cobrar:2026-11-03')
    expect(second.text).toMatch(/VENCIDOS \(2\)[\s\S]*Cobro De Hoy Tardío: \$580\.00 \(Renta de terminal · venció el 2 nov\)/)
    expect(second.text).not.toMatch(/HOY \(/)
    expect(digests.map(d => [d.day, d.status])).toEqual([
      [DAY, 'ENVIADO'],
      ['2026-11-03', 'ENVIADO'],
    ])
  })

  it('la fila de hoy, sea cual sea su estado, impide armar otro correo: un cierre por rechazo permanente no se reabre con un cobro nuevo', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'UNDELIVERABLE_RECIPIENT' })
    occurrences = [dueToday()]
    await runPlatformChargeDigest(T0)
    expect(digests).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])

    occurrences.push(overdue('2026-10-29'))
    await runPlatformChargeDigest(at(15))
    await runPlatformChargeDigest(at(30))

    expect(send).toHaveBeenCalledTimes(1)
    expect(prismaMock.platformChargeDigest.create).toHaveBeenCalledTimes(1)
  })

  it('dos corridas a la vez reservan UNA fila y mandan UN correo: la llave primaria, no la suerte, decide quién manda', async () => {
    occurrences = [dueToday()]

    await Promise.all([runPlatformChargeDigest(T0), runPlatformChargeDigest(T0)])

    expect(send).toHaveBeenCalledTimes(1)
    expect(digests).toEqual([expect.objectContaining({ status: 'ENVIADO', attempts: 0 })])
    // Las dos llegaron al insert: el choque (P2002) se ignora.
    expect(prismaMock.platformChargeDigest.create).toHaveBeenCalledTimes(2)
    expect(mockLoggerError).not.toHaveBeenCalled()

    await runPlatformChargeDigest(at(15))
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('runPlatformChargeDigest — terminar lo pendiente', () => {
  beforeEach(asProduction)

  it('🔴 un APARTADO de ayer a las 23:45 con más de 10 min se retoma hoy con el contenido guardado y la misma llave, sin armar otro', async () => {
    digests = [leftover({ day: YESTERDAY, status: 'APARTADO', attempts: 0, reservedAt: LAST_NIGHT, createdAt: LAST_NIGHT })]

    await runPlatformChargeDigest(T0)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ ...SAVED, idempotencyKey: `por-cobrar:${YESTERDAY}` })
    expect(digests).toEqual([expect.objectContaining({ day: YESTERDAY, status: 'ENVIADO', reservedAt: T0 })])
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()
  })

  it('un APARTADO de hace menos de 10 min no se toca: puede que su dueño siga mandándolo', async () => {
    digests = [leftover({ status: 'APARTADO', attempts: 0, reservedAt: at(-9), createdAt: at(-9) })]

    await runPlatformChargeDigest(T0)

    expect(send).not.toHaveBeenCalled()
    expect(digests[0].status).toBe('APARTADO')
    // Y como ya hay fila de hoy, tampoco arma otro.
    occurrences = [dueToday()]
    await runPlatformChargeDigest(at(1))
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()
  })

  it('un FALLO con 2 intentos se reintenta; con 3 no', async () => {
    digests = [leftover({ attempts: 2 })]
    await runPlatformChargeDigest(T0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ ...SAVED, idempotencyKey: KEY })
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', attempts: 2 }))

    send.mockClear()
    digests = [leftover({ attempts: 3 })]
    await runPlatformChargeDigest(at(15))
    expect(send).not.toHaveBeenCalled()
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 3 }))
  })

  it('un correo que no sale se intenta tres veces ese día, con una sola llave, y nunca una cuarta', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit' })
    occurrences = [dueToday()]

    for (const minutes of [0, 15, 30, 45, 60]) await runPlatformChargeDigest(at(minutes))

    expect(send).toHaveBeenCalledTimes(3)
    expect(new Set(sentEmails().map(email => email.idempotencyKey))).toEqual(new Set([KEY]))
    // Los tres con el MISMO correo: Resend rechaza una llave repetida con otro contenido.
    expect(new Set(sentEmails().map(email => email.html)).size).toBe(1)
    expect(digests).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])
  })

  it('🔴 sólo el intento que CIERRA el día se registra como error: los dos primeros fallos son aviso, el tercero es error', async () => {
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit' })
    occurrences = [dueToday()]

    await runPlatformChargeDigest(at(0))
    await runPlatformChargeDigest(at(15))
    // Dos intentos fallidos y todavía se reintenta: aviso, nunca error (una alerta de log no debe saltar).
    expect(ours(mockLoggerWarn)).toHaveLength(2)
    expect(ours(mockLoggerError)).toEqual([])

    await runPlatformChargeDigest(at(30)) // el tercero: ya no hay cuarto
    expect(ours(mockLoggerWarn)).toHaveLength(2)
    expect(ours(mockLoggerError)).toEqual([
      [
        expect.stringMatching(/no salió y el día se cierra sin correo/),
        expect.objectContaining({ day: DAY, error: 'rate_limit', attempt: 3 }),
      ],
    ])
    await runPlatformChargeDigest(at(45)) // y el día cerrado ya no escribe nada más
    expect(ours(mockLoggerWarn)).toHaveLength(2)
    expect(ours(mockLoggerError)).toHaveLength(1)
  })

  it('un envío que LANZA en el tercer intento también cierra el día con un error; en los anteriores es aviso', async () => {
    send.mockRejectedValue(new Error('socket hang up'))
    occurrences = [dueToday()]

    for (const minutes of [0, 15]) await runPlatformChargeDigest(at(minutes))
    expect(ours(mockLoggerWarn).map(([, detail]) => detail)).toEqual([
      expect.objectContaining({ error: 'socket hang up', attempt: 1 }),
      expect.objectContaining({ error: 'socket hang up', attempt: 2 }),
    ])
    expect(ours(mockLoggerError)).toEqual([])

    await runPlatformChargeDigest(at(30))
    expect(ours(mockLoggerError)).toEqual([[expect.any(String), expect.objectContaining({ error: 'socket hang up', attempt: 3 })]])
    expect(digests).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])
  })

  it('una retoma que lleva 2 intentos y falla cierra el día: sus intentos previos salen de la fila, no de la memoria', async () => {
    digests = [leftover({ attempts: 2 })]
    send.mockResolvedValue({ ok: false, transient: true, errorCode: 'timeout' })

    await runPlatformChargeDigest(T0)

    expect(ours(mockLoggerWarn)).toEqual([])
    expect(ours(mockLoggerError)).toEqual([[expect.any(String), expect.objectContaining({ day: DAY, error: 'timeout', attempt: 3 })]])
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'FALLO', attempts: 3 }))
  })

  it('un rechazo permanente (dirección no entregable) cierra el día: ni se reintenta ni cuenta intentos', async () => {
    send.mockResolvedValue({ ok: false, transient: false, errorCode: 'UNDELIVERABLE_RECIPIENT' })
    occurrences = [dueToday()]

    await runPlatformChargeDigest(T0)
    expect(digests).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 3 })])

    await runPlatformChargeDigest(at(15))
    await runPlatformChargeDigest(at(30))
    expect(send).toHaveBeenCalledTimes(1)
    // Cierra el día en el PRIMER intento: se registra como error (la alerta de log lo lee como «hoy no hay correo»), no como aviso.
    expect(ours(mockLoggerError)).toEqual([
      [
        expect.stringMatching(/no salió y el día se cierra sin correo/),
        expect.objectContaining({ day: DAY, error: 'UNDELIVERABLE_RECIPIENT', permanent: true, attempt: 1 }),
      ],
    ])
    expect(ours(mockLoggerWarn)).toEqual([])
  })

  it('un envío que lanza cuenta como intento fallido, no tumba la vuelta ni se reintenta dentro de ella', async () => {
    send.mockRejectedValueOnce(new Error('socket hang up'))
    occurrences = [dueToday()]

    await runPlatformChargeDigest(T0)

    expect(send).toHaveBeenCalledTimes(1)
    expect(digests).toEqual([expect.objectContaining({ status: 'FALLO', attempts: 1 })])
    await runPlatformChargeDigest(at(15))
    expect(send).toHaveBeenCalledTimes(2)
    expect(digests[0].status).toBe('ENVIADO')
  })

  it('una fila de hace más de 24 h no se retoma: la llave de Resend ya venció y repetirla mandaría otro correo', async () => {
    const old = at(-25 * 60)
    digests = [
      leftover({ day: YESTERDAY, status: 'APARTADO', attempts: 0, reservedAt: old, createdAt: old }),
      // Reservada otra vez hace 1 h por una retoma que murió: la llave sigue contando desde el PRIMER envío (createdAt).
      leftover({ day: '2026-10-31', status: 'FALLO', attempts: 1, reservedAt: at(-60), createdAt: old }),
    ]
    await runPlatformChargeDigest(T0)

    expect(send).not.toHaveBeenCalled()
    expect(digests.map(d => d.status)).toEqual(['APARTADO', 'FALLO'])
  })

  it('caída tras enviar: la retoma repite el MISMO correo con la MISMA llave, así que Resend entrega uno solo', async () => {
    occurrences = [dueToday()]
    crashesAfterSend = 2

    await expect(runPlatformChargeDigest(T0)).rejects.toThrow('the process died after sending') // mandó y murió antes de marcar
    expect(digests[0].status).toBe('APARTADO')
    // Retomó, mandó y la marca volvió a fallar: una retoma que falla se registra y no tumba la vuelta (la fila sigue reservada).
    await runPlatformChargeDigest(at(11))
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('[platform-charges]'), expect.objectContaining({ day: DAY }))
    expect(digests[0].status).toBe('APARTADO')
    // Para entonces ya cambió el cobro; nada se arma de nuevo: lo guardado es lo que se repite.
    occurrences.push(overdue('2026-10-29', { charge: { customerName: 'Llegó después' } }))
    await runPlatformChargeDigest(at(22))

    expect(send).toHaveBeenCalledTimes(3)
    expect(sentEmails().map(email => email.idempotencyKey)).toEqual([KEY, KEY, KEY])
    expect(sentEmails()[2]).toEqual(sentEmails()[0])
    expect(sentEmails()[2].text).not.toContain('Llegó después')
    expect(digests[0].status).toBe('ENVIADO')
  })

  it('dos retomas a la vez de la misma fila mandan UNA vez (compare-and-set sobre su estado y su reservación)', async () => {
    digests = [leftover({ status: 'APARTADO', attempts: 0, reservedAt: at(-11), createdAt: at(-11) })]

    await Promise.all([runPlatformChargeDigest(at(1)), runPlatformChargeDigest(at(1))])

    expect(send).toHaveBeenCalledTimes(1)
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: at(1) }))
  })

  it('una retoma lenta que perdió su reservación nunca pisa la marca de quien la tomó', async () => {
    // 9:00: el correo se queda más de 10 min en Resend.
    let finishFirst: (result: { ok: boolean; transient: boolean; errorCode?: string }) => void = () => undefined
    send.mockImplementationOnce(() => new Promise(resolve => (finishFirst = resolve)))
    occurrences = [dueToday()]
    const first = runPlatformChargeDigest(T0)
    await new Promise(resolve => setImmediate(resolve))
    expect(send).toHaveBeenCalledTimes(1)

    // 9:11: otra vuelta la retoma y su envío sale.
    await runPlatformChargeDigest(at(11))
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', reservedAt: at(11) }))

    // El de las 9:00 por fin falla: su marca ya no coincide con la fila, así que «ENVIADO» se queda.
    finishFirst({ ok: false, transient: true, errorCode: 'timeout' })
    await first
    expect(digests[0]).toEqual(expect.objectContaining({ status: 'ENVIADO', attempts: 0 }))
  })

  it('una fila guardada sin su correo no se puede repetir: se registra y la vuelta sigue con lo demás', async () => {
    digests = [leftover({ day: YESTERDAY, content: { to: RECIPIENT } })]
    occurrences = [dueToday()]

    await runPlatformChargeDigest(T0)

    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('[platform-charges]'), expect.objectContaining({ day: YESTERDAY }))
    expect(sentEmails().map(email => email.idempotencyKey)).toEqual([KEY]) // el de hoy salió igual
  })

  it('la primera lectura se reintenta ante un corte de conexión (P1001); el envío nunca se reintenta dentro de la vuelta', async () => {
    jest.useFakeTimers()
    try {
      prismaMock.platformChargeDigest.findMany.mockRejectedValueOnce(
        Object.assign(new Error("Can't reach database server"), { code: 'P1001' }),
      )
      send.mockResolvedValue({ ok: false, transient: true, errorCode: 'rate_limit' })
      occurrences = [dueToday()]

      const run = runPlatformChargeDigest(T0)
      await jest.advanceTimersByTimeAsync(5_000)
      await run

      expect(prismaMock.platformChargeDigest.findMany).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('un error que no es de conexión en la primera lectura no se reintenta: la vuelta lo propaga', async () => {
    prismaMock.platformChargeDigest.findMany.mockRejectedValueOnce(new Error('boom'))
    await expect(runPlatformChargeDigest(T0)).rejects.toThrow('boom')
    expect(prismaMock.platformChargeDigest.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('runPlatformChargeDigest — la generación diaria de ocurrencias', () => {
  beforeEach(asProduction)

  it('corre una vez al día por proceso: a las 9:00 sí, a las 9:15 y 9:30 no, y al día siguiente otra vez', async () => {
    await runPlatformChargeDigest(at(-1)) // 8:59: todavía no
    expect(generate).not.toHaveBeenCalled()

    // `generateAllActive` atrapa y registra él mismo el fallo de cada cobro y regresa normal: esos cobros esperan a mañana.
    await runPlatformChargeDigest(T0)
    await runPlatformChargeDigest(at(15))
    await runPlatformChargeDigest(at(30))
    expect(generate).toHaveBeenCalledTimes(1)

    await runPlatformChargeDigest(new Date(T0.getTime() + 24 * HOUR))
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('corre aunque ya haya fila de hoy: la generación no depende de que falte el correo', async () => {
    digests = [leftover({ status: 'ENVIADO' })]
    await runPlatformChargeDigest(T0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('si falla la lectura de los cobros activos (lo único que `generateAllActive` deja salir), el correo sale igual y se reintenta en la vuelta siguiente', async () => {
    generate.mockRejectedValueOnce(new Error("Can't reach database server"))
    occurrences = [dueToday()]

    await runPlatformChargeDigest(T0)

    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('[platform-charges]'), expect.objectContaining({ day: DAY }))
    expect(send).toHaveBeenCalledTimes(1)

    await runPlatformChargeDigest(at(15))
    expect(generate).toHaveBeenCalledTimes(2)
    await runPlatformChargeDigest(at(30))
    expect(generate).toHaveBeenCalledTimes(2) // ya salió bien: no vuelve a correr
  })
})

describe('runPlatformChargeDigest — quién puede mandar (producción, la bandera de prueba, o nada)', () => {
  /**
   * Lo que una vuelta que «no hace nada» NO toca: ninguna lectura ni escritura de las dos tablas, ni la generación, ni un correo.
   * Se revisan TODAS las operaciones que el servicio usa, para que una lectura de más no pase por «no mandó nada».
   */
  const expectNothingAtAll = () => {
    for (const model of [prismaMock.platformChargeDigest, prismaMock.platformChargeOccurrence]) {
      for (const operation of ['findMany', 'findUnique', 'count', 'create', 'updateMany']) {
        expect({ operation, calls: model[operation].mock.calls.length }).toEqual({ operation, calls: 0 })
      }
    }
    expect(generate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  }

  /** Con trabajo de sobra: una entrega a medias de ayer que retomar y un cobro que vence hoy. Si algo corriera, se notaría. */
  const seedSomethingToDo = () => {
    digests = [leftover({ day: YESTERDAY, attempts: 1 })]
    occurrences = [dueToday(), overdue('2026-10-28')]
  }

  it.each([['development'], ['test'], ['staging'], [undefined]])(
    '🔴 fuera de producción (NODE_ENV=%s) y sin la bandera no hace NADA: ni lee, ni retoma, ni genera, ni manda',
    async nodeEnv => {
      restoreEnv('NODE_ENV', nodeEnv)
      delete process.env.PLATFORM_CHARGES_SANDBOX
      seedSomethingToDo()

      await expect(runPlatformChargeDigest(T0)).resolves.toBeUndefined()

      expectNothingAtAll()
      // La entrega a medias sigue exactamente como estaba: ni la tomó.
      expect(digests).toEqual([leftover({ day: YESTERDAY, attempts: 1 })])
    },
  )

  it.each([['1'], ['TRUE'], ['yes'], ['false'], ['']])(
    'la bandera sólo vale con el texto exacto «true»: %j fuera de producción tampoco hace nada',
    async flag => {
      restoreEnv('NODE_ENV', 'development')
      process.env.PLATFORM_CHARGES_SANDBOX = flag
      seedSomethingToDo()

      await runPlatformChargeDigest(T0)

      expectNothingAtAll()
    },
  )

  it.each([['development'], ['test']])(
    '🔴 fuera de producción (NODE_ENV=%s) con la bandera: «[PRUEBA]» en el asunto y la llave propia por-cobrar-prueba:<día>, también en una retoma',
    async nodeEnv => {
      restoreEnv('NODE_ENV', nodeEnv)
      process.env.PLATFORM_CHARGES_SANDBOX = 'true'
      seedSomethingToDo()

      await runPlatformChargeDigest(T0)

      // Dos correos: la retoma de ayer (lo guardado, tal cual) y el de hoy. Los dos con la llave de PRUEBA de su día.
      expect(send).toHaveBeenCalledTimes(2)
      expect(send).toHaveBeenNthCalledWith(1, { ...SAVED, idempotencyKey: `por-cobrar-prueba:${YESTERDAY}` })
      const today = sentEmails()[1]
      expect(today.to).toBe(RECIPIENT)
      expect(today.idempotencyKey).toBe(`por-cobrar-prueba:${DAY}`)
      expect(today.subject).toMatch(/^\[PRUEBA\] Por cobrar: /)
      // La fila guarda ese mismo correo: es lo que una retoma repetirá.
      expect(digests.find(d => d.day === DAY)).toEqual(
        expect.objectContaining({
          status: 'ENVIADO',
          content: { to: RECIPIENT, subject: today.subject, html: today.html, text: today.text },
        }),
      )
      expect(generate).toHaveBeenCalledTimes(1)
      // Y ninguna llave de producción: la de un servidor de pruebas nunca puede cerrarle el día al de verdad.
      expect(
        sentEmails()
          .map(email => email.idempotencyKey)
          .filter(key => key.startsWith('por-cobrar:')),
      ).toEqual([])
    },
  )

  it('en producción sin la bandera sale el correo de verdad: asunto sin prefijo y la llave por-cobrar:<día>, también en una retoma', async () => {
    asProduction()
    delete process.env.PLATFORM_CHARGES_SANDBOX
    seedSomethingToDo()

    await runPlatformChargeDigest(T0)

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, { ...SAVED, idempotencyKey: `por-cobrar:${YESTERDAY}` })
    const today = sentEmails()[1]
    expect(today.idempotencyKey).toBe(KEY)
    expect(today.subject).toMatch(/^Por cobrar: /)
    expect(today.subject).not.toMatch(/PRUEBA/)
    expect(
      sentEmails()
        .map(email => email.idempotencyKey)
        .filter(key => key.includes('prueba')),
    ).toEqual([])
  })

  it('🔴 en producción con la bandera se niega en voz alta ANTES de todo: sin leer, sin retomar, sin generar y sin mandar', async () => {
    asProduction()
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    seedSomethingToDo()

    await expect(runPlatformChargeDigest(T0)).rejects.toThrow(/PLATFORM_CHARGES_SANDBOX/)
    // Tampoco a las 8:59: la decisión va antes que la hora y antes de terminar lo pendiente.
    await expect(runPlatformChargeDigest(at(-1))).rejects.toThrow(/PLATFORM_CHARGES_SANDBOX/)

    expectNothingAtAll()
    expect(digests).toEqual([leftover({ day: YESTERDAY, attempts: 1 })])
  })

  it('el asunto y la llave salen de UNA decisión: nunca «[PRUEBA]» con la llave de producción ni al revés', async () => {
    const modes: Array<[nodeEnv: string, flag: string | undefined, prefix: RegExp, keyPrefix: string]> = [
      ['production', undefined, /^Por cobrar: /, 'por-cobrar:'],
      ['development', 'true', /^\[PRUEBA\] Por cobrar: /, 'por-cobrar-prueba:'],
    ]
    for (const [nodeEnv, flag, subject, keyPrefix] of modes) {
      send.mockClear()
      digests = []
      occurrences = [dueToday()]
      __resetPlatformChargeDigestForTests()
      restoreEnv('NODE_ENV', nodeEnv)
      restoreEnv('PLATFORM_CHARGES_SANDBOX', flag)

      await runPlatformChargeDigest(T0)

      expect(sentEmails()).toEqual([
        expect.objectContaining({ subject: expect.stringMatching(subject), idempotencyKey: `${keyPrefix}${DAY}` }),
      ])
    }
  })
})

describe('buildPlatformChargeDigest — el contenido', () => {
  it('«Hoy», «Vencidos» y «Pagados sin factura», cada uno con su cliente, sus conceptos y su total', async () => {
    occurrences = [
      dueToday({ charge: { customerName: 'Estética Luna' }, concepts: [RENTA, LICENCIA], totalCents: 107900 }),
      overdue('2026-10-28', { charge: { customerName: 'Café Ana' }, totalCents: 173884 }),
      paid(5, { charge: { customerName: 'Gimnasio Sol' }, totalCents: 58000 }),
    ]

    const email = await buildPlatformChargeDigest(T0)

    expect(email).not.toBeNull()
    const { text, html } = email!
    expect(text).toMatch(/HOY \(1\)[\s\S]*Estética Luna: \$1,079\.00 \(Renta de terminal, Licencia\)/)
    expect(text).toMatch(/VENCIDOS \(1\)[\s\S]*Café Ana: \$1,738\.84 \(Renta de terminal · venció el 28 oct\)/)
    expect(text).toMatch(/PAGADOS SIN FACTURA \(1\)[\s\S]*Gimnasio Sol: \$580\.00 \(Renta de terminal · pagado el 28 oct\)/)
    // Hoy, Vencidos, Pagados sin factura: el orden del spec.
    expect(text.indexOf('HOY (1)')).toBeLessThan(text.indexOf('VENCIDOS (1)'))
    expect(text.indexOf('VENCIDOS (1)')).toBeLessThan(text.indexOf('PAGADOS SIN FACTURA (1)'))
    expect(html).toContain('$1,738.84')
    expect(html).toContain('Estética Luna')
  })

  it('el dinero sale al centavo desde los centavos enteros, sin pasar por flotantes', async () => {
    occurrences = [dueToday({ totalCents: 173884 }), dueToday({ totalCents: 1999 }), dueToday({ totalCents: 100_000_000 })]

    const { text } = (await buildPlatformChargeDigest(T0))!

    expect(text).toContain('$1,738.84')
    expect(text).toContain('$19.99')
    expect(text).toContain('$1,000,000.00')
  })

  it('«Pagados sin factura»: sólo automáticas, de los últimos 30 días y sin factura viva (STAMPED o CANCEL_REQUESTED)', async () => {
    const name = (customerName: string) => ({ charge: { customerName } })
    occurrences = [
      paid(5, name('Sin Factura')),
      paid(5, { ...name('Timbrando'), invoices: [{ status: 'STAMPING' }] }), // un intento a medias no es una factura
      paid(5, { ...name('Timbre Fallido'), invoices: [{ status: 'STAMP_FAILED' }] }),
      paid(5, { ...name('Factura Cancelada'), invoices: [{ status: 'CANCELLED' }] }), // ya no hay factura viva
      paid(5, { ...name('Con Factura'), invoices: [{ status: 'STAMPED' }] }),
      paid(5, { ...name('Cancelando'), invoices: [{ status: 'CANCEL_REQUESTED' }] }),
      paid(5, { ...name('Con Factura Y Un Intento'), invoices: [{ status: 'STAMP_FAILED' }, { status: 'STAMPED' }] }),
      paid(5, { ...name('Manual'), invoiceMode: 'MANUAL' }),
      paid(31, name('Muy Vieja')),
      occ({ ...name('Omitida'), status: 'SKIPPED' }),
      occ({ ...name('Pendiente Futura'), dueDate: calendarDayToDb('2026-11-05') }),
    ]

    const { text } = (await buildPlatformChargeDigest(T0))!

    const listed = (customer: string) => text.includes(customer)
    expect(['Sin Factura', 'Timbrando', 'Timbre Fallido', 'Factura Cancelada'].map(listed)).toEqual([true, true, true, true])
    expect(
      ['Con Factura:', 'Cancelando', 'Con Factura Y Un Intento', 'Manual', 'Muy Vieja', 'Omitida', 'Pendiente Futura'].map(listed),
    ).toEqual(Array(7).fill(false))
    expect(text).toContain('PAGADOS SIN FACTURA (4)')
    // La frontera de los 30 días se mide en instantes: justo adentro entra y justo afuera no.
    occurrences = [paid(30, { charge: { customerName: 'Justo Adentro' }, paidAt: new Date(T0.getTime() - 30 * 24 * HOUR + 1) })]
    expect((await buildPlatformChargeDigest(T0))!.text).toContain('Justo Adentro')
    occurrences = [paid(30, { charge: { customerName: 'Justo Afuera' }, paidAt: new Date(T0.getTime() - 30 * 24 * HOUR - 1) })]
    expect(await buildPlatformChargeDigest(T0)).toBeNull()
  })

  it('🔴 una fecha pagada en MANUAL y sin factura NO sale en «Pagados sin factura»: es a propósito', async () => {
    // A propósito (spec 2026-11-03-por-cobrar-desde-factura-y-filtros, «Anexar»): anexar una factura pasa la fecha a MANUAL y quitarla la deja
    // en MANUAL, «para que deshacer el vínculo no timbre solo ni lo esconda». El correo sólo avisa de lo AUTOMÁTICO que quedó sin factura;
    // una MANUAL sin factura es de quien cobra, y su fila sigue ofreciendo «Facturar». No lo cambies sin decidirlo: aquí lo fija esta prueba.
    occurrences = [paid(5, { charge: { customerName: 'Factura Quitada' }, invoiceMode: 'MANUAL', invoices: [] })]

    expect(await buildPlatformChargeDigest(T0)).toBeNull()
  })

  it('sólo «Pagados sin factura» también es algo que decir; sin las tres secciones, nada (null)', async () => {
    occurrences = [paid(2)]
    expect(await buildPlatformChargeDigest(T0)).not.toBeNull()

    occurrences = [occ({ dueDate: calendarDayToDb('2026-11-04') }), occ({ status: 'SKIPPED' }), paid(2, { invoiceMode: 'MANUAL' })]
    expect(await buildPlatformChargeDigest(T0)).toBeNull()
    expect(await buildPlatformChargeDigest(T0)).toBeNull() // y no deja nada escrito
    expect(prismaMock.platformChargeDigest.create).not.toHaveBeenCalled()
  })

  it('cada sección lleva hasta 50 filas y «y N más» con N del conteo de su mismo filtro; con 50 exactas no hay «más»', async () => {
    occurrences = Array.from({ length: 60 }, (_, i) =>
      overdue('2026-10-20', { charge: { customerName: `Vencido ${String(i).padStart(2, '0')}` } }),
    )
    occurrences.push(...Array.from({ length: 50 }, (_, i) => dueToday({ charge: { customerName: `Hoy ${String(i).padStart(2, '0')}` } })))

    const { text, html } = (await buildPlatformChargeDigest(T0))!

    expect(text).toContain('VENCIDOS (60)')
    expect(text.match(/Vencido \d\d:/g)).toHaveLength(50)
    expect(text).toContain('y 10 más')
    expect(html).toContain('y 10 más')
    expect(text).toContain('HOY (50)')
    expect(text.match(/Hoy \d\d:/g)).toHaveLength(50)
    expect(text.match(/y \d+ más/g)).toEqual(['y 10 más']) // la de «Hoy» no inventa un «y 0 más»
    // Los 50 que sobreviven son los más viejos y de orden estable: nunca una lectura sin tope ni un orden sin `id` al final.
    const takes = prismaMock.platformChargeOccurrence.findMany.mock.calls.map(([args]: [{ take: number }]) => args.take)
    expect(takes).toEqual([50, 50, 50])
    expect(text).toContain('Vencido 00:')
    expect(text).not.toContain('Vencido 59:')
  })

  it('🔴 el nombre del cliente y los conceptos salen escapados en el HTML (Review Focus) y tal cual en el texto', async () => {
    occurrences = [
      dueToday({
        charge: { customerName: 'Café <Luna> & Co' },
        concepts: [{ ...RENTA, description: 'Renta <b>"doble"</b> & más' }],
      }),
    ]

    const { html, text } = (await buildPlatformChargeDigest(T0))!

    expect(html).toContain('Café &lt;Luna&gt; &amp; Co')
    expect(html).toContain('Renta &lt;b&gt;&quot;doble&quot;&lt;/b&gt; &amp; más')
    expect(html).not.toContain('<Luna>')
    expect(html).not.toContain('<b>')
    expect(text).toContain('Café <Luna> & Co')
  })

  it('un nombre con saltos de línea no parte el texto: se acomoda en una sola línea', async () => {
    occurrences = [dueToday({ charge: { customerName: 'Café\n  Luna\r\nCentro' } })]
    const { text } = (await buildPlatformChargeDigest(T0))!
    expect(text).toContain('- Café Luna Centro:')
  })

  it('la liga lleva a ${SUPERADMIN_URL}/por-cobrar (sin doble diagonal) y, sin la variable, al SUPERADMIN de producción', async () => {
    occurrences = [dueToday()]
    process.env.SUPERADMIN_URL = 'https://admin.example.com/'

    const withUrl = (await buildPlatformChargeDigest(T0))!
    expect(withUrl.html).toContain('href="https://admin.example.com/por-cobrar"')
    expect(withUrl.text).toContain('https://admin.example.com/por-cobrar')
    expect(withUrl.text).not.toContain('com//por-cobrar')

    delete process.env.SUPERADMIN_URL
    expect((await buildPlatformChargeDigest(T0))!.text).toContain('https://superadmin.avoqado.io/por-cobrar')
  })

  it('con PLATFORM_CHARGES_SANDBOX=true sólo cambia el asunto: «[PRUEBA]» al frente', async () => {
    occurrences = [dueToday(), overdue('2026-10-30')]
    const real = (await buildPlatformChargeDigest(T0))!

    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    const sandbox = (await buildPlatformChargeDigest(T0))!

    expect(real.subject.startsWith('[PRUEBA]')).toBe(false)
    expect(sandbox.subject).toBe(`[PRUEBA] ${real.subject}`)
    expect(sandbox.html.replace(sandbox.subject, real.subject)).toBe(real.html) // el título del HTML repite el asunto
    expect(sandbox.text).toBe(real.text)

    // Cualquier otro valor no es el modo de prueba.
    process.env.PLATFORM_CHARGES_SANDBOX = '1'
    expect((await buildPlatformChargeDigest(T0))!.subject).toBe(real.subject)
  })

  it('un servidor de producción con el modo de prueba puesto se niega a armar el correo (la misma regla de sandbox.ts)', async () => {
    occurrences = [dueToday()]
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    process.env.NODE_ENV = 'production'

    await expect(buildPlatformChargeDigest(T0)).rejects.toThrow(/PLATFORM_CHARGES_SANDBOX/)
  })

  it.each([
    ['sólo vencidos', () => [overdue('2026-10-30')], false],
    ['las tres secciones', () => [dueToday(), overdue('2026-10-30'), paid(3)], false],
    ['las tres secciones y el modo de prueba', () => [dueToday(), overdue('2026-10-30'), paid(3)], true],
  ])('el asunto tiene 60 caracteres o menos, sin emoji: %s', async (_label, rows, sandbox) => {
    occurrences = rows()
    if (sandbox) process.env.PLATFORM_CHARGES_SANDBOX = 'true'

    const { subject } = (await buildPlatformChargeDigest(T0))!

    expect(subject.length).toBeLessThanOrEqual(60)
    expect(subject).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(subject).toContain('Por cobrar')
  })

  it('el asunto sigue en 60 con conteos enormes: lo que no cabe se queda en el cuerpo', async () => {
    occurrences = [dueToday(), overdue('2026-10-30'), paid(3)]
    prismaMock.platformChargeOccurrence.count.mockResolvedValue(1_234_567)
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'

    const { subject, text } = (await buildPlatformChargeDigest(T0))!

    expect(subject.length).toBeLessThanOrEqual(60)
    // «Hoy», «Vencidos» y luego «sin factura», como en el cuerpo: el tercero ya no cabe y se queda sólo en el cuerpo.
    expect(subject).toBe('[PRUEBA] Por cobrar: 1234567 hoy, 1234567 vencidos')
    expect(text).toContain('PAGADOS SIN FACTURA (1234567)')
  })

  it('1 cobro va en singular, y un día sin vencidos ni «hoy» no los nombra', async () => {
    occurrences = [overdue('2026-10-30')]
    expect((await buildPlatformChargeDigest(T0))!.subject).toBe('Por cobrar: 1 vencido')

    occurrences = [dueToday(), dueToday(), paid(3)]
    expect((await buildPlatformChargeDigest(T0))!.subject).toBe('Por cobrar: 2 hoy, 1 sin factura')
  })

  it('sigue el estándar de correos de Avoqado: el isotipo arriba y abajo, el botón negro, texto plano y sin emoji', async () => {
    occurrences = [dueToday(), overdue('2026-10-30'), paid(3)]

    const { html, text, subject } = (await buildPlatformChargeDigest(T0))!

    expect(html.match(/https:\/\/avoqado\.io\/isotipo\.svg/g)).toHaveLength(2)
    expect(html).toContain('background-color:#000000')
    expect(html).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('<title>')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text).toContain('Por cobrar')
    expect(text).toContain('Servicios Tecnologicos Avo S.A. de C.V.')
    expect(`${subject}${html}${text}`).not.toMatch(/\p{Extended_Pictographic}/u)
    // Sólo lo recibe el founder: no hay liga de baja.
    expect(html).not.toMatch(/unsubscribe|darse de baja|dejar de recibir/i)
  })
})
