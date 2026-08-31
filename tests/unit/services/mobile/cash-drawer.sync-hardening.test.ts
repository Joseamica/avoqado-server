/**
 * `/mobile/venues/:venueId/cash-drawer/sync` es la puerta por la que el POS descarga lo que
 * hizo SIN INTERNET. El servidor se creía el lote entero: sólo descartaba `CASH_SALE` y
 * copiaba verbatim el tipo, el monto, la fecha y el AUTOR que mandara el cliente.
 *
 * Eso es dinero, y la ruta sólo pide `payments:create` — que WAITER y CASHIER tienen. Lo que
 * estas pruebas cierran:
 *
 *   1. 🔴 sólo entran PAY_IN y PAY_OUT. Un `OPEN` inyectado se convertía en el fondo de caja
 *      del cierre (ver `closeSession`), así que con un `OPEN` de $0 antedatado el arqueo
 *      firmado salía con el fondo real desaparecido.
 *   2. 🔴 la fecha no puede ser anterior a la apertura de la caja ni venir del futuro: es lo
 *      que hacía que un evento inyectado GANARA el `orderBy createdAt asc`.
 *   3. 🔴 el autor se valida contra el venue; un `staffId` ajeno o inventado cae al del token.
 *   4. 🔴 se toma el candado de la sesión: `syncEvents` era el ÚNICO escritor de
 *      `CashDrawerEvent` que insertaba sin tocar la fila, así que un lote podía aterrizar en
 *      una caja que otro aparato acababa de cerrar y firmar.
 *   5. 🔴 y el cierre lee el fondo de su COLUMNA, no del primer evento que llegue.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))

import { closeSession, openSession, syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const SESSION = 'session-1'
const CAJERO = 'staff-cajero'
const ABIERTA_A_LAS = new Date('2026-08-28T14:00:00.000Z')

function armarSesionAbierta(over: Record<string, unknown> = {}) {
  const session = {
    id: SESSION,
    venueId: VENUE,
    status: 'OPEN',
    startingAmount: 1000,
    openedAt: ABIERTA_A_LAS,
    openedByStaffId: CAJERO,
    openedByName: 'Cajero',
    closedAt: null,
    closedByStaffId: null,
    closedByName: null,
    actualAmount: null,
    overShort: null,
    closingNote: null,
    events: [],
    ...over,
  }
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue(session),
    findUnique: jest.fn().mockResolvedValue(session),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn().mockResolvedValue({ ...session, status: 'CLOSED' }),
  }
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'evt-1', ...a.data })),
    findMany: jest.fn().mockResolvedValue([]),
  }
  ;(prismaMock as any).staffVenue = { findFirst: jest.fn().mockResolvedValue({ id: 'sv-1' }) }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
  return session
}

const movimiento = (over: Record<string, unknown> = {}) => ({
  type: 'PAY_IN',
  amount: 50,
  staffId: CAJERO,
  staffName: 'Cajero',
  localId: 'local-1',
  ...over,
})

beforeEach(() => jest.clearAllMocks())

describe('/sync sólo acepta lo que un POS puede haber hecho sin internet', () => {
  it('🔴 un OPEN inyectado por el cliente NO se guarda', async () => {
    armarSesionAbierta()
    await syncEvents(VENUE, [movimiento({ type: 'OPEN', amount: 0, localId: 'x' }) as never], null, CAJERO)

    const filas = ((prismaMock as any).cashDrawerEvent.createMany as jest.Mock).mock.calls.flatMap((c: any) => c[0]?.data ?? [])
    const sueltas = ((prismaMock as any).cashDrawerEvent.create as jest.Mock).mock.calls.map((c: any) => c[0]?.data)
    expect([...filas, ...sueltas].some((f: any) => f?.type === 'OPEN')).toBe(false)
  })

  it('🔴 un CLOSE inyectado tampoco', async () => {
    armarSesionAbierta()
    await syncEvents(VENUE, [movimiento({ type: 'CLOSE', amount: 0, localId: 'y' }) as never], null, CAJERO)
    const filas = ((prismaMock as any).cashDrawerEvent.createMany as jest.Mock).mock.calls.flatMap((c: any) => c[0]?.data ?? [])
    expect(filas.some((f: any) => f?.type === 'CLOSE')).toBe(false)
  })

  it('un PAY_IN y un PAY_OUT normales sí entran', async () => {
    armarSesionAbierta()
    const r = await syncEvents(
      VENUE,
      [movimiento({ localId: 'a' }), movimiento({ type: 'PAY_OUT', amount: 20, localId: 'b' })] as never,
      null,
      CAJERO,
    )
    expect(r.syncedCount).toBeGreaterThan(0)
  })

  it('🔴 una fecha ANTERIOR a la apertura de la caja no puede ganarle al fondo', async () => {
    armarSesionAbierta()
    await syncEvents(VENUE, [movimiento({ createdAt: '2020-01-01T00:00:00.000Z', localId: 'viejo' })] as never, null, CAJERO)
    const filas = ((prismaMock as any).cashDrawerEvent.createMany as jest.Mock).mock.calls.flatMap((c: any) => c[0]?.data ?? [])
    for (const f of filas) expect(new Date(f.createdAt).getTime()).toBeGreaterThanOrEqual(ABIERTA_A_LAS.getTime())
  })

  it('🔴 el autor que no pertenece al venue cae al del token', async () => {
    armarSesionAbierta()
    ;(prismaMock as any).staffVenue.findFirst = jest.fn().mockResolvedValue(null) // el staffId del cuerpo no es de aquí
    await syncEvents(VENUE, [movimiento({ staffId: 'ajeno', staffName: 'Otro', localId: 'c' })] as never, null, CAJERO)
    const filas = ((prismaMock as any).cashDrawerEvent.createMany as jest.Mock).mock.calls.flatMap((c: any) => c[0]?.data ?? [])
    for (const f of filas) expect(f.staffId).toBe(CAJERO)
  })

  it('🔴 toma el candado de la sesión: si otro aparato la cerró, el lote NO entra', async () => {
    armarSesionAbierta()
    ;(prismaMock as any).cashDrawerSession.updateMany = jest.fn().mockResolvedValue({ count: 0 }) // ya no está OPEN
    await expect(syncEvents(VENUE, [movimiento({ localId: 'd' })] as never, null, CAJERO)).rejects.toThrow()
  })
})

describe('el cierre lee el fondo de su columna', () => {
  it('🔴 usa CashDrawerSession.startingAmount, no el primer evento OPEN', async () => {
    armarSesionAbierta()
    // Un OPEN de $0 más antiguo que la apertura: si el cierre lo usara, el fondo real ($1,000)
    // desaparecería del esperado y el cajero cargaría con un sobrante inventado de $1,000.
    ;(prismaMock as any).cashDrawerEvent.findMany = jest.fn().mockResolvedValue([
      { id: 'e0', type: 'OPEN', amount: 0, createdAt: new Date('2020-01-01T00:00:00.000Z') },
      { id: 'e1', type: 'CASH_SALE', amount: 500, createdAt: ABIERTA_A_LAS },
    ])

    await closeSession({ venueId: VENUE, actualAmount: 1500, staffId: CAJERO, staffName: 'Cajero' })

    // Se comprueba el número que se FIRMA en la base, que es lo que le queda al cajero:
    // 1000 de fondo + 500 de venta = 1500 esperado, contó 1500 ⇒ diferencia 0.
    // Con el fondo tomado del evento OPEN de $0 saldría un sobrante de 1000.
    const firmado = ((prismaMock as any).cashDrawerSession.update as jest.Mock).mock.calls
      .map((c: any) => c[0]?.data?.overShort)
      .filter((v: any) => v !== undefined)
    expect(firmado.length).toBeGreaterThan(0)
    expect(Number(firmado[0])).toBeCloseTo(0, 2)
  })
})
describe('abrir la caja respeta el permiso, no lo ignora', () => {
  // 🔴 Encontrado por /full-testing contra el servidor real: la respuesta de ABRIR omitía el
  // esperado incluso para quien SÍ tiene `cash-drawer:view-expected`, porque `openSession`
  // no pasaba el flag y caía en el default seguro. No perdía información —al abrir, el
  // esperado ES el fondo que la persona acaba de teclear, y ningún cliente lee ese campo del
  // servidor— pero dejaba el contrato incoherente: el mismo usuario lo veía en `current` y
  // no en `open`.
  it('🔴 con permiso, la respuesta de abrir SÍ trae el esperado', async () => {
    armarSesionAbierta()
    ;(prismaMock as any).cashDrawerSession.findFirst = jest.fn().mockResolvedValue(null) // no hay caja abierta
    ;(prismaMock as any).cashDrawerSession.create = jest.fn().mockResolvedValue({
      id: SESSION,
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: 1000,
      openedAt: ABIERTA_A_LAS,
      openedByStaffId: CAJERO,
      openedByName: 'Cajero',
      closedAt: null,
      closedByStaffId: null,
      closedByName: null,
      actualAmount: null,
      overShort: null,
      closingNote: null,
      events: [],
    })

    const r: any = await openSession({ venueId: VENUE, staffId: CAJERO, staffName: 'Cajero', startingAmount: 1000 } as never, true)
    expect(r.expectedAmount).toBeDefined()
  })

  it('sin permiso, la respuesta de abrir NO lo trae', async () => {
    armarSesionAbierta()
    ;(prismaMock as any).cashDrawerSession.findFirst = jest.fn().mockResolvedValue(null) // no hay caja abierta
    ;(prismaMock as any).cashDrawerSession.create = jest.fn().mockResolvedValue({
      id: SESSION,
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: 1000,
      openedAt: ABIERTA_A_LAS,
      openedByStaffId: CAJERO,
      openedByName: 'Cajero',
      closedAt: null,
      closedByStaffId: null,
      closedByName: null,
      actualAmount: null,
      overShort: null,
      closingNote: null,
      events: [],
    })

    const r: any = await openSession({ venueId: VENUE, staffId: CAJERO, staffName: 'Cajero', startingAmount: 1000 } as never)
    expect(r.expectedAmount).toBeUndefined()
  })
})
