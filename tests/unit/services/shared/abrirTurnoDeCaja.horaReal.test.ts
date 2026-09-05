/**
 * 🔴 DINERO. La caja abierta SIN RED nace en el servidor con la hora REAL del aparato, no con la
 * hora del replay.
 *
 * Medido en una Samsung SM-X133 el 5-sep-2026: la caja se abrió a las 10:22 con el WiFi apagado y
 * el servidor la registró a las 10:31, cuando la cola la reprodujo. Consecuencias, las dos de
 * dinero en pantalla: la venta en efectivo de las 10:25 quedaba FUERA de la ventana
 * `[openedAt, closedAt]` de la caja del servidor —así que la tablet la dejaba en la sesión
 * provisional y el ticket del corte decía «Ventas totales $80» arriba y «Efectivo esperado $500»
 * abajo—, y el barrido `cash-drawer-reconciler` tampoco la habría repuesto en esa caja.
 *
 * El contrato es ADITIVO (`openedAt` opcional en `POST /cash-drawer/open`): una app vieja que no
 * lo manda se comporta EXACTAMENTE como hoy (todo nace en `ahora`).
 *
 * 🔴 Y la hora del aparato se ACOTA, porque un reloj de tablet miente: nunca futuro (se estampa
 * `ahora`), nunca más de 24 h atrás (se estampa `ahora − 24 h`). Las 24 h son la sesión offline de
 * Square («after 24 hours, your offline payments session will end», Square Support, buscado en
 * vivo el 5-sep-2026) y coinciden con nuestro propio ciclo del día de negocio. Un ajuste NUNCA es
 * silencioso: queda en la bitácora `CASH_DRAWER_OPENED` con el desfase.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/rabbitmq/commandListener', () => ({ deliverPosCommand: jest.fn() }))

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { deliverPosCommand } from '@/communication/rabbitmq/commandListener'
import { logAction } from '@/services/dashboard/activity-log.service'
import { TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS, abrirTurnoDeCaja, acotarOpenedAt } from '@/services/shared/turnoDeCaja'
import { Prisma } from '@prisma/client'

const mockLogAction = logAction as jest.MockedFunction<typeof logAction>
const mockLogger = logger as unknown as { warn: jest.Mock }

const m = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
  shift: { findFirst: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerSession: { findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; updateMany: jest.Mock }
  cashDrawerEvent: { findFirst: jest.Mock }
  posCommand: { create: jest.Mock }
}

const VENUE = 'venue-1'
const STAFF = 'staff-1'
/** Sábado 5-sep-2026, 10:31 en CDMX (UTC−6) = 16:31 UTC: la hora del REPLAY en la Samsung. */
const AHORA = new Date('2026-09-05T16:31:00.000Z')
const ahora = () => AHORA
/** 10:22 CDMX: la hora a la que la cajera de verdad abrió la caja, sin red. */
const ABRIO_A_LAS = new Date('2026-09-05T16:22:00.000Z')

function sembrar() {
  m.venue.findUnique.mockResolvedValue({
    id: VENUE,
    name: 'Testarudo Cafe',
    timezone: 'America/Mexico_City',
    posType: null,
    posStatus: 'NOT_INTEGRATED',
  })
  m.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF,
    venueId: VENUE,
    posStaffId: null,
    staff: { id: STAFF, firstName: 'Vir', lastName: 'Gomez' },
  })
  m.shift.findFirst.mockResolvedValue(null)
  m.shift.findMany.mockResolvedValue([])
  m.shift.findUnique.mockResolvedValue(null)
  m.cashDrawerSession.findFirst.mockResolvedValue(null)
  m.cashDrawerSession.findUnique.mockResolvedValue(null)
  m.cashDrawerEvent.findFirst.mockResolvedValue(null)
  m.shift.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'turno-nuevo', ...data }))
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'caja-nueva', ...data }))
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.posCommand.create.mockResolvedValue({ id: 'cmd-open' })
  ;(deliverPosCommand as jest.Mock).mockResolvedValue('COMPLETED')
}

const params = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Vir Gomez',
  startingCash: 500,
  deviceName: 'samsung SM-X133',
  source: 'CAJA_MOVIL' as const,
  now: ahora,
  ...over,
})

const asientos = (action: string) => mockLogAction.mock.calls.filter(c => (c[0] as { action?: string })?.action === action)

beforeEach(() => {
  jest.clearAllMocks()
  sembrar()
})

// ============================================================================
// LA FUNCIÓN PURA: qué hora se acepta y cuál se acota
// ============================================================================

describe('acotarOpenedAt — la hora del aparato, acotada', () => {
  it('sin hora del aparato ⇒ ahora, sin ajuste (contrato viejo)', () => {
    expect(acotarOpenedAt(null, AHORA)).toEqual({ aplicado: AHORA, ajuste: null, desfaseMs: 0 })
    expect(acotarOpenedAt(undefined, AHORA)).toEqual({ aplicado: AHORA, ajuste: null, desfaseMs: 0 })
  })

  it('una hora dentro de las últimas 24 h se respeta TAL CUAL', () => {
    expect(acotarOpenedAt(ABRIO_A_LAS, AHORA)).toEqual({ aplicado: ABRIO_A_LAS, ajuste: null, desfaseMs: 0 })
  })

  it('exactamente 24 h atrás todavía se respeta: el tope es inclusivo', () => {
    const hace24h = new Date(AHORA.getTime() - TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS)
    expect(acotarOpenedAt(hace24h, AHORA).aplicado).toEqual(hace24h)
    expect(acotarOpenedAt(hace24h, AHORA).ajuste).toBeNull()
  })

  it('🔴 futuro ⇒ ahora, y se DICE (FUTURO con el desfase): una caja no puede abrirse antes de que exista', () => {
    const adelantado = new Date(AHORA.getTime() + 10 * 60_000)
    expect(acotarOpenedAt(adelantado, AHORA)).toEqual({ aplicado: AHORA, ajuste: 'FUTURO', desfaseMs: 10 * 60_000 })
  })

  it('🔴 más de 24 h atrás ⇒ ahora − 24 h (DEMASIADO_VIEJO): un reloj en 2020 no puede tragarse meses de cobros', () => {
    const en2020 = new Date('2020-01-01T00:00:00.000Z')
    const r = acotarOpenedAt(en2020, AHORA)
    expect(r.aplicado).toEqual(new Date(AHORA.getTime() - TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS))
    expect(r.ajuste).toBe('DEMASIADO_VIEJO')
    expect(r.desfaseMs).toBe(en2020.getTime() - r.aplicado.getTime())
    expect(r.desfaseMs).toBeLessThan(0)
  })

  it('el tope es de 24 horas exactas', () => {
    expect(TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS).toBe(24 * 60 * 60 * 1000)
  })
})

// ============================================================================
// EL SERVICIO: dónde se estampa
// ============================================================================

describe('abrirTurnoDeCaja — estampa la hora REAL del aparato al crear', () => {
  it('🔴 la caja, su evento OPEN y el turno nacen con el openedAt del aparato, no con la hora del replay', async () => {
    await abrirTurnoDeCaja(params({ openedAt: ABRIO_A_LAS }))

    expect(m.cashDrawerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          openedAt: ABRIO_A_LAS,
          events: { create: expect.objectContaining({ type: 'OPEN', createdAt: ABRIO_A_LAS }) },
        }),
      }),
    )
    expect(m.shift.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ startTime: ABRIO_A_LAS, status: 'OPEN', endTime: null }) }),
    )
  })

  it('la bitácora dice la hora escrita Y la que mandó el aparato, sin ajuste cuando coinciden', async () => {
    await abrirTurnoDeCaja(params({ openedAt: ABRIO_A_LAS }))

    const [caja] = asientos('CASH_DRAWER_OPENED')
    expect(caja[0].data).toEqual(
      expect.objectContaining({ openedAt: ABRIO_A_LAS.toISOString(), openedAtDelAparato: ABRIO_A_LAS.toISOString() }),
    )
    expect(caja[0].data).not.toHaveProperty('ajusteDeReloj')

    const [turno] = asientos('SHIFT_OPENED')
    expect(turno[0].data).toEqual(expect.objectContaining({ startTime: ABRIO_A_LAS.toISOString() }))
  })

  it('🔴 un aparato con el reloj en el FUTURO: se estampa ahora, la bitácora lleva el ajuste y hay warn', async () => {
    const adelantado = new Date(AHORA.getTime() + 10 * 60_000)

    await abrirTurnoDeCaja(params({ openedAt: adelantado }))

    expect(m.cashDrawerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ openedAt: AHORA, events: { create: expect.objectContaining({ createdAt: AHORA }) } }),
      }),
    )
    expect(m.shift.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ startTime: AHORA }) }))
    const [caja] = asientos('CASH_DRAWER_OPENED')
    expect(caja[0].data).toEqual(
      expect.objectContaining({
        openedAt: AHORA.toISOString(),
        openedAtDelAparato: adelantado.toISOString(),
        ajusteDeReloj: 'FUTURO',
        desfaseMs: 10 * 60_000,
      }),
    )
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[TURNO DE CAJA]'),
      expect.objectContaining({ venueId: VENUE, ajusteDeReloj: 'FUTURO' }),
    )
  })

  it('🔴 una apertura de hace más de 24 h: se estampa ahora − 24 h y la bitácora dice DEMASIADO_VIEJO', async () => {
    const hace30h = new Date(AHORA.getTime() - 30 * 60 * 60_000)
    const tope = new Date(AHORA.getTime() - TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS)

    await abrirTurnoDeCaja(params({ openedAt: hace30h }))

    expect(m.cashDrawerSession.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ openedAt: tope }) }))
    expect(m.shift.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ startTime: tope }) }))
    const [caja] = asientos('CASH_DRAWER_OPENED')
    expect(caja[0].data).toEqual(
      expect.objectContaining({
        openedAt: tope.toISOString(),
        openedAtDelAparato: hace30h.toISOString(),
        ajusteDeReloj: 'DEMASIADO_VIEJO',
      }),
    )
  })

  it('REGRESIÓN — sin openedAt todo nace en `ahora`, y la bitácora no menciona al aparato', async () => {
    await abrirTurnoDeCaja(params())

    expect(m.cashDrawerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          openedAt: AHORA,
          events: { create: expect.not.objectContaining({ createdAt: expect.anything() }) },
        }),
      }),
    )
    expect(m.shift.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ startTime: AHORA }) }))
    const [caja] = asientos('CASH_DRAWER_OPENED')
    expect(caja[0].data).toEqual(expect.objectContaining({ openedAt: AHORA.toISOString() }))
    expect(caja[0].data).not.toHaveProperty('openedAtDelAparato')
    expect(caja[0].data).not.toHaveProperty('ajusteDeReloj')
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  it('LIGAR una caja que ya estaba abierta NO le reescribe la hora: el openedAt del aparato sólo cuenta al CREAR', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: 'caja-de-otro',
      venueId: VENUE,
      status: 'OPEN',
      startingAmount: new Prisma.Decimal(2000),
      shiftId: null,
      openedAt: new Date('2026-09-05T13:38:00.000Z'),
    })

    const r = await abrirTurnoDeCaja(params({ openedAt: ABRIO_A_LAS }))

    expect(r.cajaCreada).toBe(false)
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    for (const llamada of m.cashDrawerSession.updateMany.mock.calls) {
      expect(llamada[0].data).not.toHaveProperty('openedAt')
    }
  })

  it('el relevo del día anterior se decide con el reloj del SERVIDOR, no con la hora que mande el aparato', async () => {
    // Un turno abierto AYER a las 16:00 CDMX: es de otro día de negocio (corte 04:00) y se releva.
    m.shift.findFirst.mockResolvedValue({
      id: 'turno-de-ayer',
      venueId: VENUE,
      status: 'OPEN',
      endTime: null,
      startTime: new Date('2026-09-04T22:00:00.000Z'),
      startingCash: new Prisma.Decimal(0),
      notes: null,
    })

    const r = await abrirTurnoDeCaja(params({ openedAt: ABRIO_A_LAS }))

    expect(r.relevo?.shiftCerradoId).toBe('turno-de-ayer')
    // El cierre del relevo se firma en `ahora`, nunca con la hora del aparato: es cuándo lo cerró el servidor.
    expect(m.shift.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'turno-de-ayer' }),
        data: expect.objectContaining({ endTime: AHORA }),
      }),
    )
    // Y el turno nuevo sí nace con la hora real del aparato.
    expect(m.shift.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ startTime: ABRIO_A_LAS }) }))
  })
})
