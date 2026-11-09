/**
 * La checada del celular (App de campo, bloque 0, Tarea 6): cada regla de entrada y salida, con `TimeEntry` y sus descansos
 * en una tabla falsa en memoria que respeta los `where` condicionados, y un candado de verdad (mutex) en el
 * `pg_advisory_xact_lock` para que dos entradas a la vez se prueben de verdad.
 */
import { AttendanceDisabledError, assertAttendanceEnabled } from '@/services/dashboard/attendanceGate'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { registrarEntradaDeCampo, registrarSalidaDeCampo } from '@/services/tpv/campo/checadaDeCampo.service'

jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/services/dashboard/attendanceGate', () => ({
  ...jest.requireActual('@/services/dashboard/attendanceGate'),
  assertAttendanceEnabled: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const V = 'venue-A'
const STAFF = 'staff-1'
const q = { venueId: V, staffId: STAFF }
const LLAVE = '6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'
const LLAVE_2 = '7a2d3c9f-2e3b-4d4c-8f9a-1b2c3d4e5f60'
const LLAVE_ENTRADA = '8b3e4d0a-3f4c-4e5d-9a0b-2c3d4e5f6071'
/** Una hora del 3-nov (o del día que se diga) en CDMX. */
const t = (hhmm: string, dia = 3) => new Date(`2026-11-0${dia}T${hhmm}:00-06:00`)

// ── La tabla falsa ──────────────────────────────────────────────────────────────────────────────────────────────────
type Fila = Record<string, any>
let entradas: Fila[]
let descansos: Fila[]
let consecutivo: number
/** Se corre antes del primer `updateMany` de la entrada: simula a otro escritor (el cierre automático) en medio. */
let antesDeActualizar: (() => void) | null
let cola: Promise<void>
let zona: string

const igual = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
const OPERADORES: Record<string, (valor: any, x: any) => boolean> = {
  in: (valor, x) => x.includes(valor),
  gt: (valor, x) => valor != null && valor > x,
  lt: (valor, x) => valor != null && valor < x,
  not: (valor, x) => !igual(valor, x),
}
/** El `where` de Prisma que usa el servicio: igualdad, `in`/`gt`/`lt`/`not` y llaves compuestas (`staffId_llaveEntrada`). */
function coincide(f: Fila, where: Fila): boolean {
  return Object.entries(where).every(([k, w]) => {
    if (w === undefined) return true
    if (w && typeof w === 'object' && !(w instanceof Date)) {
      const ops = Object.keys(w)
      return ops.every(o => o in OPERADORES) ? ops.every(o => OPERADORES[o](f[k], w[o])) : coincide(f, w)
    }
    return igual(f[k], w)
  })
}
const ordenar = (filas: Fila[], orderBy?: Record<string, 'asc' | 'desc'>) => {
  if (!orderBy) return filas
  const [[k, dir]] = Object.entries(orderBy)
  return [...filas].sort((x, y) => (x[k] - y[k]) * (dir === 'desc' ? -1 : 1))
}
const conDescansos = (f: Fila) => ({ ...f, breaks: descansos.filter(b => b.timeEntryId === f.id).map(b => ({ ...b })) })
const tiempo = () => new Promise(listo => setImmediate(listo)) // cada consulta cede el turno, como la base

function armarBase() {
  const db: any = {
    timeEntry: {
      findUnique: jest.fn(async ({ where }) => (await tiempo(), entradas.filter(f => coincide(f, where)).map(conDescansos)[0] ?? null)),
      findFirst: jest.fn(
        async ({ where, orderBy }) => (
          await tiempo(),
          ordenar(
            entradas.filter(f => coincide(f, where)),
            orderBy,
          ).map(conDescansos)[0] ?? null
        ),
      ),
      create: jest.fn(async ({ data }) => {
        await tiempo()
        const fila = {
          id: `te-${++consecutivo}`,
          clockOutTime: null,
          autoClockOut: false,
          notes: null,
          totalHours: null,
          validationStatus: 'PENDING',
          ...data,
        }
        entradas.push(fila)
        return { ...fila }
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        await tiempo()
        if (antesDeActualizar) {
          const otro = antesDeActualizar
          antesDeActualizar = null
          otro()
        }
        const cuales = entradas.filter(f => coincide(f, where))
        cuales.forEach(f => Object.assign(f, data))
        return { count: cuales.length }
      }),
    },
    venue: { findUnique: jest.fn(async () => (await tiempo(), { timezone: zona })) },
    timeEntryBreak: {
      update: jest.fn(async ({ where, data }) => {
        await tiempo()
        const b = descansos.find(d => d.id === where.id)
        Object.assign(b!, data)
        return { ...b }
      }),
    },
    // El candado: un mutex que se suelta al terminar la transacción, como `pg_advisory_xact_lock`.
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      let soltar: () => void = () => {}
      const tx = {
        ...db,
        $queryRaw: jest.fn(async (...args: unknown[]) => {
          db.$queryRaw(...args)
          const antes = cola
          cola = new Promise<void>(listo => (soltar = listo))
          await antes
        }),
      }
      try {
        return await cb(tx)
      } finally {
        soltar()
      }
    }),
  }
  Object.assign(prisma, db)
}

const entrada = (extra: Fila = {}) => {
  const fila = {
    id: `te-${++consecutivo}`,
    staffId: STAFF,
    venueId: V,
    clockInTime: t('09:00'),
    clockOutTime: null,
    status: 'CLOCKED_IN',
    autoClockOut: false,
    notes: null,
    totalHours: null,
    llaveEntrada: null,
    llaveSalida: null,
    validationStatus: 'PENDING',
    validatedBy: null,
    validatedAt: null,
    validationNote: null,
    ...extra,
  }
  entradas.push(fila)
  return fila
}
const descanso = (timeEntryId: string, startTime: Date, endTime: Date | null) => {
  const b = { id: `br-${++consecutivo}`, timeEntryId, startTime, endTime }
  descansos.push(b)
  return b
}

beforeEach(() => {
  jest.clearAllMocks()
  entradas = []
  descansos = []
  consecutivo = 0
  antesDeActualizar = null
  cola = Promise.resolve()
  zona = 'America/Mexico_City'
  armarBase()
  ;(assertAttendanceEnabled as jest.Mock).mockResolvedValue(undefined)
})

// ── Entrada ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('registrarEntradaDeCampo', () => {
  it('crea la entrada con la hora del celular, de dónde salió, la ubicación falsa, el GPS, las fotos y la llave', async () => {
    const ahora = t('12:00')
    const r = await registrarEntradaDeCampo(
      q,
      {
        llave: LLAVE,
        ocurrioAt: t('09:00').toISOString(),
        origenHora: 'RELOJ_ANCLADO',
        latitude: 19.4,
        longitude: -99.1,
        accuracy: 12,
        ubicacionFalsa: true,
        checkInPhotoUrl: 'https://fotos.test/selfie.jpg',
        facadePhotoUrl: 'https://fotos.test/fachada.jpg',
      },
      ahora,
    )

    expect(r).toEqual({ timeEntryId: 'te-1', repetida: false, hora: t('09:00').toISOString() })
    expect(entradas).toHaveLength(1)
    expect(entradas[0]).toMatchObject({
      staffId: STAFF,
      venueId: V,
      clockInTime: t('09:00'),
      status: 'CLOCKED_IN',
      breakMinutes: 0,
      llaveEntrada: LLAVE,
      clockInOrigenHora: 'RELOJ_ANCLADO',
      clockInUbicacionFalsa: true,
      clockInLatitude: 19.4,
      clockInLongitude: -99.1,
      clockInAccuracy: 12,
      checkInPhotoUrl: 'https://fotos.test/selfie.jpg',
      facadePhotoUrl: 'https://fotos.test/fachada.jpg',
    })
    expect(assertAttendanceEnabled).toHaveBeenCalledWith(V)
  })

  it('una hora del celular de más de 2 min en el futuro no se cree: queda la del servidor', async () => {
    const ahora = t('09:00')
    const r = await registrarEntradaDeCampo(q, { llave: LLAVE, ocurrioAt: t('09:10').toISOString() }, ahora)

    expect(r.hora).toBe(ahora.toISOString())
    expect(entradas[0]).toMatchObject({ clockInTime: ahora, clockInOrigenHora: 'SERVIDOR' })
  })

  it('la misma llave devuelve la misma entrada (repetida) y no crea otra', async () => {
    const hecha = entrada({ llaveEntrada: LLAVE, clockInTime: t('09:00') })

    const r = await registrarEntradaDeCampo(q, { llave: LLAVE, ocurrioAt: t('09:05').toISOString() }, t('12:00'))

    expect(r).toEqual({ timeEntryId: hecha.id, repetida: true, hora: t('09:00').toISOString() })
    expect(entradas).toHaveLength(1)
  })

  it.each(['CLOCKED_IN', 'ON_BREAK'])(
    'otra entrada abierta (%s) de la persona en OTRA sucursal, hecha en una PAX → 409 YA_TIENE_ENTRADA con su id, sucursal y hora',
    async status => {
      const abierta = entrada({ venueId: 'venue-B', status, clockInTime: t('08:00') })

      const error = await registrarEntradaDeCampo(q, { llave: LLAVE }, t('09:00')).catch(e => e)

      expect(error).toMatchObject({
        statusCode: 409,
        code: 'YA_TIENE_ENTRADA',
        details: { timeEntryId: abierta.id, venueId: 'venue-B', clockInTime: t('08:00').toISOString() },
      })
      expect(entradas).toHaveLength(1)
    },
  )

  it('la entrada abierta de OTRA persona no estorba', async () => {
    entrada({ staffId: 'staff-2' })

    const r = await registrarEntradaDeCampo(q, { llave: LLAVE }, t('09:00'))

    expect(r.repetida).toBe(false)
    expect(entradas).toHaveLength(2)
  })

  it('una entrada de las 08:55 (guardada sin señal) que sube a las 18:00, cuando la persona hizo 09:00–17:00 en una PAX → 409 ENTRADA_SE_ENCIMA', async () => {
    const pax = entrada({ venueId: 'venue-B', clockInTime: t('09:00'), clockOutTime: t('17:00'), status: 'CLOCKED_OUT', totalHours: 8 })

    const error = await registrarEntradaDeCampo(q, { llave: LLAVE, ocurrioAt: t('08:55').toISOString() }, t('18:00')).catch(e => e)

    expect(error).toMatchObject({
      statusCode: 409,
      code: 'ENTRADA_SE_ENCIMA',
      details: { timeEntryId: pax.id, venueId: 'venue-B', clockInTime: t('09:00').toISOString(), clockOutTime: t('17:00').toISOString() },
    })
    expect(entradas).toHaveLength(1)
  })

  it('ENTRADA_SE_ENCIMA nombra el turno cerrado que termina más tarde', async () => {
    entrada({ clockInTime: t('07:00'), clockOutTime: t('08:00'), status: 'CLOCKED_OUT' })
    const ultimo = entrada({ clockInTime: t('09:00'), clockOutTime: t('17:00'), status: 'CLOCKED_OUT' })

    const error = await registrarEntradaDeCampo(q, { llave: LLAVE, ocurrioAt: t('06:00').toISOString() }, t('18:00')).catch(e => e)

    expect(error).toMatchObject({ code: 'ENTRADA_SE_ENCIMA', details: { timeEntryId: ultimo.id } })
  })

  it('una entrada justo a la hora de la salida anterior (17:00 = 17:00) sí se acepta; un turno de otra persona no cuenta', async () => {
    entrada({ clockInTime: t('09:00'), clockOutTime: t('17:00'), status: 'CLOCKED_OUT' })
    entrada({ staffId: 'staff-2', clockInTime: t('09:00'), clockOutTime: t('23:00'), status: 'CLOCKED_OUT' })

    const r = await registrarEntradaDeCampo(q, { llave: LLAVE, ocurrioAt: t('17:00').toISOString() }, t('18:00'))

    expect(r).toMatchObject({ repetida: false, hora: t('17:00').toISOString() })
    expect(entradas).toHaveLength(3)
  })

  it('con la asistencia apagada → el 403 de assertAttendanceEnabled y nada se crea', async () => {
    ;(assertAttendanceEnabled as jest.Mock).mockRejectedValue(new AttendanceDisabledError())

    const error = await registrarEntradaDeCampo(q, { llave: LLAVE }, t('09:00')).catch(e => e)

    expect(error).toMatchObject({ statusCode: 403, code: 'ATTENDANCE_DISABLED' })
    expect(entradas).toHaveLength(0)
  })

  it('toma el candado de la persona antes de leer nada', async () => {
    await registrarEntradaDeCampo(q, { llave: LLAVE }, t('09:00'))

    const [partes, valor] = (prisma as any).$queryRaw.mock.calls[0]
    expect(partes.join('?')).toMatch(/pg_advisory_xact_lock\(hashtext\(\?\)\)/)
    expect(valor).toBe(`checada:${STAFF}`)
    expect((prisma as any).$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      (prisma as any).timeEntry.findUnique.mock.invocationCallOrder[0],
    )
  })

  it('dos entradas a la vez con llaves distintas dejan UNA sola (el candado); la otra recibe YA_TIENE_ENTRADA', async () => {
    const [a, b] = await Promise.allSettled([
      registrarEntradaDeCampo(q, { llave: LLAVE }, t('09:00')),
      registrarEntradaDeCampo(q, { llave: LLAVE_2 }, t('09:00')),
    ])

    expect(entradas).toHaveLength(1)
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    const rechazo = (a.status === 'rejected' ? a : b) as PromiseRejectedResult
    expect(rechazo.reason).toMatchObject({ code: 'YA_TIENE_ENTRADA', details: { timeEntryId: entradas[0].id } })
  })
})

// ── Salida ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('registrarSalidaDeCampo', () => {
  it('cierra la entrada abierta que nombra por timeEntryId: hora, llave, hora de llegada, origen, ubicación y horas', async () => {
    const e = entrada()
    const ahora = t('17:01')

    const r = await registrarSalidaDeCampo(
      q,
      {
        llave: LLAVE,
        timeEntryId: e.id,
        ocurrioAt: t('17:00').toISOString(),
        origenHora: 'RELOJ_DEL_CELULAR',
        ubicacionFalsa: false,
        latitude: 19.4,
        longitude: -99.1,
        accuracy: 8,
        checkOutPhotoUrl: 'https://fotos.test/salida.jpg',
      },
      ahora,
    )

    expect(r).toEqual({ timeEntryId: e.id, repetida: false, hora: t('17:00').toISOString(), totalHours: 8 })
    expect(entradas[0]).toMatchObject({
      clockOutTime: t('17:00'),
      status: 'CLOCKED_OUT',
      totalHours: 8,
      breakMinutes: 0,
      llaveSalida: LLAVE,
      clockOutRecibidaAt: ahora,
      clockOutOrigenHora: 'RELOJ_DEL_CELULAR',
      clockOutUbicacionFalsa: false,
      clockOutLatitude: 19.4,
      clockOutLongitude: -99.1,
      clockOutAccuracy: 8,
      checkOutPhotoUrl: 'https://fotos.test/salida.jpg',
    })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('sin timeEntryId ni llaveEntrada → 400, nunca busca «la de la persona en la sucursal»', async () => {
    entrada()

    const error = await registrarSalidaDeCampo(q, { llave: LLAVE } as any, t('17:00')).catch(e => e)

    expect(error).toMatchObject({ statusCode: 400, code: 'SALIDA_SIN_ENTRADA' })
    expect((prisma as any).timeEntry.findFirst).not.toHaveBeenCalled()
    expect(entradas[0].clockOutTime).toBeNull()
  })

  it('la salida guardada sin señal nombra su entrada por llaveEntrada', async () => {
    const e = entrada({ llaveEntrada: LLAVE_ENTRADA })

    const r = await registrarSalidaDeCampo(
      q,
      { llave: LLAVE, llaveEntrada: LLAVE_ENTRADA, ocurrioAt: t('17:00').toISOString() },
      t('17:00'),
    )

    expect(r).toMatchObject({ timeEntryId: e.id, repetida: false, totalHours: 8 })
    expect(entradas[0].clockOutTime).toEqual(t('17:00'))
  })

  it('la misma llave de salida devuelve la misma salida (repetida) y no cambia nada', async () => {
    const e = entrada({ clockOutTime: t('17:00'), status: 'CLOCKED_OUT', totalHours: 8, llaveSalida: LLAVE })

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('18:00').toISOString() }, t('18:00'))

    expect(r).toEqual({ timeEntryId: e.id, repetida: true, hora: t('17:00').toISOString(), totalHours: 8 })
    expect((prisma as any).timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['no existe', () => 'te-que-no-existe'],
    ['es de otra persona', () => entrada({ staffId: 'staff-2' }).id],
    ['es de otra sucursal', () => entrada({ venueId: 'venue-B' }).id],
  ])('la entrada %s → 404 y no se toca nada', async (_caso, id) => {
    const timeEntryId = id()

    const error = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId }, t('17:00')).catch(e => e)

    expect(error).toMatchObject({ statusCode: 404 })
    expect((prisma as any).timeEntry.updateMany).not.toHaveBeenCalled()
  })

  it('una llaveEntrada que todavía no subió → 404', async () => {
    const error = await registrarSalidaDeCampo(q, { llave: LLAVE, llaveEntrada: LLAVE_ENTRADA }, t('17:00')).catch(e => e)

    expect(error).toMatchObject({ statusCode: 404 })
  })

  it('una salida antes que su entrada → 422 SALIDA_ANTES_DE_ENTRADA', async () => {
    const e = entrada({ clockInTime: t('09:00') })

    const error = await registrarSalidaDeCampo(
      q,
      { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('08:59').toISOString() },
      t('10:00'),
    ).catch(e => e)

    expect(error).toMatchObject({ statusCode: 422, code: 'SALIDA_ANTES_DE_ENTRADA' })
    expect(entradas[0].clockOutTime).toBeNull()
  })

  it('una entrada que cerró una persona (PAX, POS u otra salida del celular) → 409 YA_TIENE_SALIDA', async () => {
    const e = entrada({ clockOutTime: t('16:00'), status: 'CLOCKED_OUT', totalHours: 7, llaveSalida: LLAVE_2 })

    const error = await registrarSalidaDeCampo(
      q,
      { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() },
      t('17:00'),
    ).catch(e => e)

    expect(error).toMatchObject({ statusCode: 409, code: 'YA_TIENE_SALIDA' })
    expect(entradas[0]).toMatchObject({ clockOutTime: t('16:00'), totalHours: 7, llaveSalida: LLAVE_2 })
  })

  it('entrada 09:00, descanso abierto 12:00, salida 17:00 que llega al día siguiente → descanso cerrado a las 17:00, 3 h', async () => {
    const e = entrada({ status: 'ON_BREAK' })
    const b = descanso(e.id, t('12:00'), null)
    const ahora = t('08:00', 4)

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, ahora)

    expect(r).toMatchObject({ hora: t('17:00').toISOString(), totalHours: 3 })
    expect(descansos.find(d => d.id === b.id)!.endTime).toEqual(t('17:00'))
    expect(entradas[0]).toMatchObject({ clockOutTime: t('17:00'), clockOutRecibidaAt: ahora, breakMinutes: 300, status: 'CLOCKED_OUT' })
  })

  it('el cierre automático cerró a las 03:00 un descanso de las 12:00; la salida real de las 17:00 lo reemplaza: descanso a las 17:00, 3 h, autoClockOut = false, con nota y bitácora', async () => {
    const e = entrada({
      clockOutTime: t('03:00', 4),
      status: 'CLOCKED_OUT',
      totalHours: 18,
      autoClockOut: true,
      autoClockOutNote: '[Sistema] Salida automática: Hora de cierre programada (03:00)',
      notes: 'Llegó con uniforme',
    })
    const b = descanso(e.id, t('12:00'), t('03:00', 4))
    const ahora = t('08:00', 4)

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, ahora)

    expect(r).toEqual({ timeEntryId: e.id, repetida: false, hora: t('17:00').toISOString(), totalHours: 3 })
    expect(descansos.find(d => d.id === b.id)!.endTime).toEqual(t('17:00'))
    expect(entradas[0]).toMatchObject({
      clockOutTime: t('17:00'),
      autoClockOut: false,
      totalHours: 3,
      breakMinutes: 300,
      llaveSalida: LLAVE,
      clockOutRecibidaAt: ahora,
      // Se conserva el motivo del sistema y la nota que ya había.
      autoClockOutNote: '[Sistema] Salida automática: Hora de cierre programada (03:00)',
      notes: 'Llegó con uniforme\nSalida real del celular; reemplazó el cierre automático de 03:00 del 4-nov (America/Mexico_City)',
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: STAFF,
        venueId: V,
        action: 'TIME_ENTRY_AUTO_CLOCKOUT_REPLACED',
        entity: 'TimeEntry',
        entityId: e.id,
        data: expect.objectContaining({
          cierreAutomatico: t('03:00', 4).toISOString(),
          salidaReal: t('17:00').toISOString(),
          origenHora: 'RELOJ_DEL_CELULAR',
          validacionAnterior: 'PENDING',
        }),
      }),
    )
  })

  it('el cierre por duración máxima cerró a las 15:00 la entrada y su descanso de las 12:00; la salida real de las 17:00 → descanso 12:00–17:00, 3 h', async () => {
    const e = entrada({ clockOutTime: t('15:00'), status: 'CLOCKED_OUT', totalHours: 6, autoClockOut: true })
    const b = descanso(e.id, t('12:00'), t('15:00')) // lo terminó el sistema: misma hora que el cierre

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('17:05'))

    expect(r.totalHours).toBe(3)
    expect(descansos.find(d => d.id === b.id)).toMatchObject({ startTime: t('12:00'), endTime: t('17:00') })
    expect(entradas[0]).toMatchObject({ autoClockOut: false, clockOutTime: t('17:00') })
  })

  it('un descanso que la persona terminó a las 13:00 no cambia (y uno abierto sí se cierra)', async () => {
    const e = entrada({ clockOutTime: t('03:00', 4), status: 'CLOCKED_OUT', autoClockOut: true })
    const persona = descanso(e.id, t('12:00'), t('13:00'))
    const sistema = descanso(e.id, t('15:00'), t('03:00', 4))

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('08:00', 4))

    expect(descansos.find(d => d.id === persona.id)!.endTime).toEqual(t('13:00'))
    expect(descansos.find(d => d.id === sistema.id)!.endTime).toEqual(t('17:00'))
    expect(r.totalHours).toBe(5) // 8 h − 1 h − 2 h
    expect((prisma as any).timeEntryBreak.update).toHaveBeenCalledTimes(1)
  })

  it('un descanso que empezó después de la salida queda en cero, no en negativo', async () => {
    const e = entrada()
    const tarde = descanso(e.id, t('18:00'), null)

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('19:00'))

    expect(descansos.find(d => d.id === tarde.id)!.endTime).toEqual(t('18:00'))
    expect(r.totalHours).toBe(8)
  })

  it('las horas nunca salen negativas (descansos encimados)', async () => {
    const e = entrada()
    descanso(e.id, t('10:00'), t('16:00'))
    descanso(e.id, t('10:30'), t('16:30'))

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('17:00'))

    expect(r.totalHours).toBe(0)
    expect(entradas[0].totalHours).toBe(0)
  })

  it('una entrada vieja abierta topa las horas en 999.99 (Decimal(5,2))', async () => {
    const e = entrada({ clockInTime: new Date(t('17:00').getTime() - 60 * 24 * 60 * 60 * 1000) })

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id }, t('17:00'))

    expect(r.totalHours).toBe(999.99)
  })

  it('si el cierre automático la cerró entre la lectura y la escritura (0 filas), relee y la reemplaza', async () => {
    const e = entrada()
    const b = descanso(e.id, t('12:00'), null)
    antesDeActualizar = () => {
      Object.assign(entradas[0], { clockOutTime: t('03:00', 4), status: 'CLOCKED_OUT', autoClockOut: true, totalHours: 18 })
      b.endTime = t('03:00', 4)
    }

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('08:00', 4))

    expect((prisma as any).timeEntry.updateMany).toHaveBeenCalledTimes(2)
    expect(r.totalHours).toBe(3)
    expect(entradas[0]).toMatchObject({ clockOutTime: t('17:00'), autoClockOut: false })
    expect(descansos[0].endTime).toEqual(t('17:00'))
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TIME_ENTRY_AUTO_CLOCKOUT_REPLACED' }))
  })

  it('si la PAX abrió un descanso entre la lectura y la escritura (cambió el estado), relee y lo cierra con la salida', async () => {
    const e = entrada()
    antesDeActualizar = () => {
      descanso(e.id, t('15:00'), null)
      entradas[0].status = 'ON_BREAK'
    }

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('17:00'))

    expect((prisma as any).timeEntry.updateMany).toHaveBeenCalledTimes(2)
    expect(r.totalHours).toBe(6)
    expect(descansos[0].endTime).toEqual(t('17:00'))
    expect(entradas[0]).toMatchObject({ status: 'CLOCKED_OUT', breakMinutes: 120 })
  })

  it('el cierre automático cerró a las 12:00 por duración máxima y la persona hizo 13:00–16:00 en una PAX: la salida real de las 17:00 → 409 SALIDA_SE_ENCIMA', async () => {
    const e = entrada({ clockOutTime: t('12:00'), status: 'CLOCKED_OUT', autoClockOut: true, totalHours: 3 })
    const pax = entrada({ venueId: 'venue-B', clockInTime: t('13:00'), clockOutTime: t('16:00'), status: 'CLOCKED_OUT' })

    const error = await registrarSalidaDeCampo(
      q,
      { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() },
      t('17:00'),
    ).catch(e => e)

    expect(error).toMatchObject({
      statusCode: 409,
      code: 'SALIDA_SE_ENCIMA',
      details: { timeEntryId: pax.id, venueId: 'venue-B', clockInTime: t('13:00').toISOString() },
    })
    expect(entradas[0]).toMatchObject({ clockOutTime: t('12:00'), autoClockOut: true })
  })

  it('una salida justo a la hora de la entrada siguiente (17:00 = 17:00) sí se acepta; una entrada anterior no cuenta', async () => {
    entrada({ clockInTime: t('06:00'), clockOutTime: t('08:00'), status: 'CLOCKED_OUT' })
    const e = entrada()
    entrada({ venueId: 'venue-B', clockInTime: t('17:00') })

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('17:00'))

    expect(r).toMatchObject({ repetida: false, totalHours: 8 })
  })

  it('reemplazar el cierre automático de una checada APROBADA la deja APROBADA (sin tocar quién ni cuándo) y la bitácora dice que las horas cambiaron', async () => {
    const aprobadaEl = t('09:00', 4)
    const e = entrada({
      clockOutTime: t('03:00', 4),
      status: 'CLOCKED_OUT',
      autoClockOut: true,
      totalHours: 18,
      validationStatus: 'APPROVED',
      validatedBy: 'supervisor-1',
      validatedAt: aprobadaEl,
      validationNote: 'ok',
    })

    await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('10:00', 4))

    // Sin regresarla a PENDIENTE: el depósito que se creó al aprobar se contaría dos veces al aprobar otra vez.
    expect(entradas[0]).toMatchObject({
      validationStatus: 'APPROVED',
      validatedBy: 'supervisor-1',
      validatedAt: aprobadaEl,
      validationNote: 'ok',
      totalHours: 8,
    })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ validacionAnterior: 'APPROVED', horasAntes: 18, horasDespues: 8 }),
      }),
    )
  })

  it.each(['PENDING', 'REJECTED'])('reemplazar el cierre automático de una checada %s la deja como estaba', async validationStatus => {
    const e = entrada({ clockOutTime: t('03:00', 4), status: 'CLOCKED_OUT', autoClockOut: true, validationStatus, validatedBy: 'sup' })

    await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('10:00', 4))

    expect(entradas[0]).toMatchObject({ validationStatus, validatedBy: 'sup', autoClockOut: false })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ validacionAnterior: validationStatus }) }),
    )
  })

  it('si un supervisor la aprobó entre la lectura y la escritura, relee: queda APROBADA y la bitácora lo dice', async () => {
    const e = entrada({ clockOutTime: t('03:00', 4), status: 'CLOCKED_OUT', autoClockOut: true })
    antesDeActualizar = () =>
      Object.assign(entradas[0], { validationStatus: 'APPROVED', validatedBy: 'supervisor-1', validatedAt: t('09:00', 4) })

    await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('10:00', 4))

    expect((prisma as any).timeEntry.updateMany).toHaveBeenCalledTimes(2)
    expect(entradas[0]).toMatchObject({ validationStatus: 'APPROVED', validatedBy: 'supervisor-1' })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ validacionAnterior: 'APPROVED' }) }))
  })

  it('la nota usa la zona del negocio; con una zona inválida cae a ISO y la salida igual se guarda', async () => {
    zona = 'Zona/Inexistente'
    const e = entrada({ clockOutTime: t('03:00', 4), status: 'CLOCKED_OUT', autoClockOut: true })

    const r = await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() }, t('10:00', 4))

    expect(r.totalHours).toBe(8)
    expect(entradas[0].notes).toBe(`Salida real del celular; reemplazó el cierre automático de ${t('03:00', 4).toISOString()}`)
  })

  it('si una persona la cerró entre la lectura y la escritura (0 filas), relee y responde YA_TIENE_SALIDA', async () => {
    const e = entrada()
    antesDeActualizar = () => Object.assign(entradas[0], { clockOutTime: t('16:00'), status: 'CLOCKED_OUT', totalHours: 7 })

    const error = await registrarSalidaDeCampo(
      q,
      { llave: LLAVE, timeEntryId: e.id, ocurrioAt: t('17:00').toISOString() },
      t('17:00'),
    ).catch(e => e)

    expect(error).toMatchObject({ statusCode: 409, code: 'YA_TIENE_SALIDA' })
    expect(entradas[0]).toMatchObject({ clockOutTime: t('16:00'), totalHours: 7 })
  })

  it('la salida también toma el candado de la persona antes de leer', async () => {
    const e = entrada()

    await registrarSalidaDeCampo(q, { llave: LLAVE, timeEntryId: e.id }, t('17:00'))

    expect((prisma as any).$queryRaw.mock.calls[0][1]).toBe(`checada:${STAFF}`)
    expect((prisma as any).$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      (prisma as any).timeEntry.findUnique.mock.invocationCallOrder[0],
    )
  })
})
