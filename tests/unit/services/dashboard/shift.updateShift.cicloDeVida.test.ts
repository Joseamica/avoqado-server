/**
 * 🔴 DINERO Y DISPONIBILIDAD DEL COBRO — P1.1 y P2.3 de la auditoría del 4-sep-2026.
 *
 * `PUT /dashboard/venues/:venueId/shifts/:shiftId` no llevaba `validateRequest`, y el servicio
 * copiaba `status`, `endTime`, `startTime` y `staffId` VERBATIM del cuerpo. Dos variantes, las dos
 * al alcance de un MANAGER —que es justo el rol al que este plan le abrió la ruta—:
 *
 *   (A) `{"status":"OPEN"}` sobre un turno CERRADO deja `status='OPEN'` **con `endTime` puesto**.
 *       A partir de ahí `turnoAbiertoDelNegocio`, `getCurrentShift` y `abrirTurnoDeCaja` exigen
 *       `endTime: null` y no lo ven, así que abrir devuelve **409 `CASH_SHIFT_ALREADY_OPEN` para
 *       siempre** (choca contra el único parcial `Shift(venueId) WHERE status='OPEN'`) y
 *       `claimShiftForClose` tampoco lo cierra. El negocio se queda sin poder abrir caja, y sólo
 *       lo destraba un UPDATE a mano en Postgres.
 *   (B) `{"endTime": null}` sobre un turno cerrado de HOY lo devuelve como «abierto» a la PAX
 *       mientras `turnoAbiertoDelNegocio` sigue devolviendo `null` ⇒ **todos los cobros del día
 *       nacen sin turno**. Es el defecto medido en Testarudo el 1-sep ($10,337 de $12,002),
 *       reproducible a mano.
 *
 * El endpoint de corrección del gerente NO cambia el ciclo de vida del turno. Zod acota la FORMA;
 * el servicio guarda la REGLA, porque a un servicio se le puede llamar sin pasar por la ruta.
 *
 * 🔴 P2.3: `staffId` se copiaba sin comprobar `StaffVenue`. La FK sólo exige que el `Staff` exista,
 * así que un MANAGER del venue A podía reasignarle la autoría de un corte a un empleado del venue
 * B. Es la regla dura de aislamiento por tenant de `critical-warnings.md`.
 */

import { prismaMock } from '../../../__helpers__/setup'
import { updateShift } from '@/services/dashboard/shift.dashboard.service'
import { UpdateShiftSchema } from '@/schemas/dashboard/shift.schema'
import { logAction } from '@/services/dashboard/activity-log.service'

const VENUE = 'venue-1'
const TURNO = 'turno-1'

const INICIO = new Date('2026-09-03T14:00:00.000Z')
const FIN = new Date('2026-09-04T02:00:00.000Z')

function turnoCerrado(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-1',
    startTime: INICIO,
    endTime: FIN,
    updatedAt: FIN,
    status: 'CLOSED',
    startingCash: '2000.00',
    endingCash: '1300.00',
    cashDeclared: '1300.00',
    cashDifference: '0',
    totalCashPayments: '1800.00',
    totalCashTips: '0',
    totalSales: '1800.00',
    totalTips: '0',
    totalOrders: 10,
    ...over,
  }
}

function mundo(over: Record<string, unknown> = {}) {
  const turno = turnoCerrado(over)
  prismaMock.shift.findFirst.mockResolvedValue({ ...turno, staff: null, venue: { id: VENUE, name: 'Testarudo Cafe' } })
  prismaMock.shift.updateMany.mockImplementation(async () => ({ count: 1 }))
  prismaMock.$queryRaw.mockResolvedValue([])
  // Sin gaveta: estas pruebas miden el ciclo de vida, no el descuadre (ese vive en
  // `shift.updateShift.cashDifference.test.ts`).
  prismaMock.cashDrawerSession.findFirst.mockResolvedValue(null)
  prismaMock.cashDrawerSession.findMany.mockResolvedValue([])
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  return turno
}

describe('UpdateShiftSchema — Zod acota la FORMA del cuerpo', () => {
  const parse = (body: Record<string, unknown>) => UpdateShiftSchema.safeParse({ body })

  it('acepta lo ÚNICO que el dashboard manda hoy', () => {
    // `avoqado-web-dashboard/src/pages/Shift/ShiftId.tsx:686` y `Shifts.tsx:151`: los dos
    // únicos clientes de esta ruta mandan exactamente estas dos llaves.
    const r = parse({ totalSales: 1900, totalTips: 120 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body).toEqual({ totalSales: 1900, totalTips: 120 })
  })

  it('acepta las correcciones de dinero del gerente', () => {
    expect(parse({ startingCash: 500 }).success).toBe(true)
    expect(parse({ endingCash: 1350 }).success).toBe(true)
    expect(parse({ endingCash: null }).success).toBe(true)
    expect(parse({ totalOrders: 12 }).success).toBe(true)
    expect(parse({ staffId: 'staff-9' }).success).toBe(true)
  })

  it('🔴 RECHAZA `status`: es la variante A, la que deja al negocio sin poder abrir caja', () => {
    const r = parse({ status: 'OPEN' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.errors[0].message).toContain('estado del turno')
  })

  it('🔴 RECHAZA `endTime`: es la variante B, la que deja el día entero sin turno', () => {
    expect(parse({ endTime: null }).success).toBe(false)
    expect(parse({ endTime: '2026-09-10T02:00:00.000Z' }).success).toBe(false)
  })

  it('🔴 RECHAZA `startTime`: mover la apertura cambia qué gaveta y qué cobros son del turno', () => {
    expect(parse({ startTime: '2026-09-01T00:00:00.000Z' }).success).toBe(false)
  })

  it('el mensaje del rechazo va en ESPAÑOL y nombra el campo exacto', () => {
    const r = parse({ status: 'OPEN', endTime: null })
    expect(r.success).toBe(false)
    if (!r.success) {
      const texto = r.error.errors.map(e => e.message).join(' | ')
      expect(texto).toMatch(/estado del turno/)
      expect(texto).toMatch(/hora de cierre/)
      expect(texto).not.toMatch(/[Ii]nvalid|[Ee]xpected/)
    }
  })

  it('una llave desconocida se DESCARTA (no llega al servicio) en vez de rebotar la corrección', () => {
    const r = parse({ totalSales: 1900, loQueSea: 'x' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.body).not.toHaveProperty('loQueSea')
  })

  it('un cuerpo vacío es válido: no es esta capa la que decide si hay algo que corregir', () => {
    expect(parse({}).success).toBe(true)
  })
})

describe('updateShift — el servicio NO cambia el ciclo de vida del turno (aunque nadie pase por Zod)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 reabrir un turno CERRADO se rechaza y NO se escribe nada', async () => {
    mundo()

    await expect(updateShift(VENUE, TURNO, { status: 'OPEN' } as any, { performedBy: 'staff-dueno' })).rejects.toMatchObject({
      statusCode: 400,
    })

    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 `endTime` en el cuerpo se rechaza: es lo que deja los cobros del día con `shiftId` nulo', async () => {
    mundo()

    await expect(updateShift(VENUE, TURNO, { endTime: null } as any, { performedBy: 'staff-dueno' })).rejects.toMatchObject({
      statusCode: 400,
    })

    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 `startTime` en el cuerpo se rechaza', async () => {
    mundo()

    await expect(
      updateShift(VENUE, TURNO, { startTime: new Date('2026-09-01T00:00:00.000Z') } as any, { performedBy: 'staff-dueno' }),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('el mensaje dice QUÉ campo y por qué, en español', async () => {
    mundo()

    await expect(updateShift(VENUE, TURNO, { status: 'CLOSED' } as any, {})).rejects.toThrow(/estado del turno/)
  })

  it('la corrección normal del dashboard sigue funcionando igual', async () => {
    mundo()

    const r = await updateShift(VENUE, TURNO, { totalSales: 1900, totalTips: 120 }, { performedBy: 'staff-dueno' })

    expect(r).not.toBeNull()
    expect(prismaMock.shift.updateMany).toHaveBeenCalledTimes(1)
    const escrito = (prismaMock.shift.updateMany as jest.Mock).mock.calls[0][0].data
    expect(escrito).toMatchObject({ totalSales: 1900, totalTips: 120 })
    expect(escrito).not.toHaveProperty('status')
    expect(escrito).not.toHaveProperty('endTime')
    expect(escrito).not.toHaveProperty('startTime')
  })
})

describe('updateShift — `staffId` de OTRO tenant (P2.3)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 rechaza reasignar la autoría del corte a alguien que no es de este negocio', async () => {
    mundo()
    prismaMock.staffVenue.findFirst.mockResolvedValue(null as any)

    await expect(updateShift(VENUE, TURNO, { staffId: 'staff-de-otro-venue' }, { performedBy: 'staff-dueno' })).rejects.toMatchObject({
      statusCode: 400,
    })

    expect(prismaMock.shift.updateMany).not.toHaveBeenCalled()
  })

  it('la comprobación se hace CONTRA EL VENUE de la ruta, no contra el del turno', async () => {
    mundo()

    await updateShift(VENUE, TURNO, { staffId: 'staff-2' }, { performedBy: 'staff-dueno' })

    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: 'staff-2', venueId: VENUE }) }),
    )
  })

  it('acepta a alguien que SÍ pertenece al negocio', async () => {
    mundo()

    await updateShift(VENUE, TURNO, { staffId: 'staff-2' }, { performedBy: 'staff-dueno' })

    expect((prismaMock.shift.updateMany as jest.Mock).mock.calls[0][0].data).toMatchObject({ staffId: 'staff-2' })
  })

  it('sin `staffId` en el cuerpo NO se consulta `StaffVenue`', async () => {
    mundo()

    await updateShift(VENUE, TURNO, { totalSales: 1900 }, { performedBy: 'staff-dueno' })

    expect(prismaMock.staffVenue.findFirst).not.toHaveBeenCalled()
  })
})
