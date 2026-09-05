/**
 * `abrirTurnoDeCaja` con LLAVE idempotente y HORA REAL del aparato — contra Postgres REAL.
 *
 * Las unitarias mockean Prisma y por tanto no ven el índice `CashDrawerEvent(venueId, localId)` ni
 * lo que Postgres hace con un `createdAt` explícito en un `create` anidado. Aquí se demuestra:
 *
 *  1. la caja, su evento OPEN y el turno nacen con la hora del aparato (9 min antes del replay), que
 *     es el defecto medido en la Samsung el 5-sep-2026 (abierta 10:22, registrada 10:31);
 *  2. el reintento con la MISMA llave devuelve la MISMA caja — una sola fila, un solo OPEN;
 *  3. la RAÍZ de la idempotencia es el índice único, que rechaza un segundo OPEN con esa llave;
 *  4. una llave que ya usó un PAY_IN ⇒ 400 legible, no un 500;
 *  5. una apertura de hace 30 h se ACOTA a 24 h y queda dicho en la bitácora.
 *
 * Correr:
 *   TEST_DATABASE_URL='postgresql://…/av-db-25-test' \
 *   npx jest --selectProjects integration --runTestsByPath tests/integration/shared/turnoDeCaja.aperturaIdempotenteYHoraReal.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS, abrirTurnoDeCaja } from '@/services/shared/turnoDeCaja'

// 🔴 `integration-setup.ts` MOCKEA `logAction` (la bitácora es best-effort y fire-and-forget; con el
// cliente real sus escrituras aterrizarían después del `afterAll`). Lo que se verifica aquí contra
// Postgres es la HORA escrita; que el asiento LLEVE el ajuste se comprueba en la llamada al mock — y
// su forma exacta la fija `tests/unit/services/shared/abrirTurnoDeCaja.horaReal.test.ts`.
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

const suffix = `${Date.now()}-${process.pid}`
let orgId: string
let venueId: string
let staffId: string

const LLAVE = `open-${suffix}`
/** La hora a la que la cajera abrió sin red: 9 minutos ANTES del replay. */
const ABRIO_A_LAS = new Date(Date.now() - 9 * 60_000)

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `AperturaIdempotente Org ${suffix}`, email: `aihr-${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  const venue = await prisma.venue.create({
    data: { organizationId: orgId, name: `aihr-${suffix}`, slug: `aihr-${suffix}`, timezone: 'America/Mexico_City' },
    select: { id: true },
  })
  venueId = venue.id
  const staff = await prisma.staff.create({
    data: { email: `aihr-${suffix}@example.test`, firstName: 'Vir', lastName: 'Gomez' },
    select: { id: true },
  })
  staffId = staff.id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'MANAGER' } })
})

afterAll(async () => {
  const sesiones = await prisma.cashDrawerSession.findMany({ where: { venueId }, select: { id: true } })
  await prisma.cashDrawerEvent.deleteMany({ where: { sessionId: { in: sesiones.map(s => s.id) } } })
  await prisma.cashDrawerSession.deleteMany({ where: { venueId } })
  await prisma.shift.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } }).catch(() => undefined)
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.delete({ where: { id: staffId } })
  await prisma.venue.delete({ where: { id: venueId } })
  await prisma.organization.delete({ where: { id: orgId } })
  await prisma.$disconnect()
})

const abrir = (over: Record<string, unknown> = {}) =>
  abrirTurnoDeCaja({
    venueId,
    staffId,
    staffName: 'Vir Gomez',
    startingCash: 500,
    deviceName: 'samsung SM-X133',
    source: 'CAJA_MOVIL',
    ...over,
  })

describe('abrirTurnoDeCaja — llave idempotente y hora real, contra Postgres real', () => {
  let cajaId: string
  let turnoId: string

  it('🔴 la caja, su evento OPEN y el turno nacen con la hora REAL del aparato, no con la del replay', async () => {
    const r = await abrir({ localId: LLAVE, openedAt: ABRIO_A_LAS })
    cajaId = r.cashDrawerSessionId
    turnoId = r.shiftId

    expect(r.cajaCreada).toBe(true)
    expect(r.shiftCreado).toBe(true)
    expect(r.reintento).toBe(false)
    expect(r.localId).toBe(LLAVE)

    const caja = await prisma.cashDrawerSession.findUnique({ where: { id: cajaId }, include: { events: true } })
    expect(caja?.openedAt.getTime()).toBe(ABRIO_A_LAS.getTime())
    expect(caja?.events).toHaveLength(1)
    expect(caja?.events[0]).toEqual(expect.objectContaining({ type: 'OPEN', localId: LLAVE }))
    expect(caja?.events[0].createdAt.getTime()).toBe(ABRIO_A_LAS.getTime())

    const turno = await prisma.shift.findUnique({ where: { id: turnoId }, select: { startTime: true, status: true } })
    expect(turno?.startTime.getTime()).toBe(ABRIO_A_LAS.getTime())
    expect(turno?.status).toBe('OPEN')
  })

  it('🔴 el reintento con la MISMA llave devuelve la MISMA caja y el MISMO turno: una sola fila, un solo OPEN', async () => {
    const r2 = await abrir({ localId: LLAVE, openedAt: new Date(), startingCash: 999 })

    expect(r2.reintento).toBe(true)
    expect(r2.cajaCreada).toBe(true)
    expect(r2.shiftCreado).toBe(false)
    expect(r2.cashDrawerSessionId).toBe(cajaId)
    expect(r2.shiftId).toBe(turnoId)
    expect(r2.fondoAplicado).toBe('500')

    expect(await prisma.cashDrawerSession.count({ where: { venueId } })).toBe(1)
    expect(await prisma.cashDrawerEvent.count({ where: { venueId, type: 'OPEN' } })).toBe(1)
    // Y la caja conserva su hora ORIGINAL: el reintento no la movió a la hora del segundo intento.
    const caja = await prisma.cashDrawerSession.findUnique({ where: { id: cajaId }, select: { openedAt: true } })
    expect(caja?.openedAt.getTime()).toBe(ABRIO_A_LAS.getTime())
  })

  it('la RAÍZ: el índice único rechaza un segundo OPEN con esa llave — es lo que hace confiable el reintento', async () => {
    await expect(
      prisma.cashDrawerEvent.create({
        data: { venueId, sessionId: cajaId, type: 'OPEN', amount: 1, staffId, staffName: 'x', localId: LLAVE },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('🔴 una llave que ya usó un PAY_IN ⇒ 400 CASH_DRAWER_OPEN_LOCAL_ID_REUSED, nunca un 500 del índice', async () => {
    // Se cierra la caja y el turno a mano para que la siguiente apertura tenga que CREAR (no ligar).
    await prisma.cashDrawerSession.update({ where: { id: cajaId }, data: { status: 'CLOSED', closedAt: new Date() } })
    await prisma.shift.update({ where: { id: turnoId }, data: { status: 'CLOSED', endTime: new Date() } })
    const llaveDelRetiro = `payin-${suffix}`
    await prisma.cashDrawerEvent.create({
      data: { venueId, sessionId: cajaId, type: 'PAY_IN', amount: 100, staffId, staffName: 'Vir Gomez', localId: llaveDelRetiro },
    })

    await expect(abrir({ localId: llaveDelRetiro })).rejects.toMatchObject({ statusCode: 400, code: 'CASH_DRAWER_OPEN_LOCAL_ID_REUSED' })
    // Y no quedó ninguna caja nueva a medias: la transacción se revirtió entera.
    expect(await prisma.cashDrawerSession.count({ where: { venueId } })).toBe(1)
    expect(await prisma.shift.count({ where: { venueId, status: 'OPEN' } })).toBe(0)
  })

  it('🔴 una apertura de hace 30 h se ACOTA a 24 h, y la bitácora lo dice (DEMASIADO_VIEJO)', async () => {
    const hace30h = new Date(Date.now() - 30 * 60 * 60_000)
    const antes = Date.now()

    const r = await abrir({ localId: `vieja-${suffix}`, openedAt: hace30h })

    expect(r.cajaCreada).toBe(true)
    const caja = await prisma.cashDrawerSession.findUnique({ where: { id: r.cashDrawerSessionId }, select: { openedAt: true } })
    const tope = antes - TOPE_DE_ANTIGUEDAD_DE_LA_APERTURA_MS
    // `ahora` se toma dentro del servicio, así que el tope tiene una holgura de segundos.
    expect(caja!.openedAt.getTime()).toBeGreaterThanOrEqual(tope)
    expect(caja!.openedAt.getTime()).toBeLessThan(tope + 30_000)
    expect(caja!.openedAt.getTime()).toBeGreaterThan(hace30h.getTime())

    // La bitácora lleva el ajuste: se lee de la llamada, porque en integración `logAction` está mockeado.
    const asiento = mockLogAction.mock.calls
      .map(c => c[0])
      .find(a => a.action === 'CASH_DRAWER_OPENED' && a.entityId === r.cashDrawerSessionId)
    expect(asiento).toBeDefined()
    expect(asiento?.data).toEqual(
      expect.objectContaining({
        ajusteDeReloj: 'DEMASIADO_VIEJO',
        openedAtDelAparato: hace30h.toISOString(),
        openedAt: caja!.openedAt.toISOString(),
        localId: `vieja-${suffix}`,
      }),
    )
  })
})
