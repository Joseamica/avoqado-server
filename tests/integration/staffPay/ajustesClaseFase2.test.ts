// tests/integration/staffPay/ajustesClaseFase2.test.ts — ajustes de una clase ya contabilizada (spec §5, §5.4, §6.6).
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { guardarAjusteDeClase, pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { bloquearPeriodo } from '@/services/dashboard/staffPay/periodosGuardados'
import { barreraDelPeriodo, borrarMundo, clase, confirmadas, crearMundo, Mundo, tablaMindform } from './_mundo'

// `__admin` (Sofía, ADMIN) no tiene staffpay:close; el OWNER sí. Los permisos de escribir se resuelven ANTES de la
// transacción con `sedesConPermiso` (A8), así que es ése el que decide aquí.
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (userId: string, venueIds: string[], permiso: string) =>
    permiso === 'staffpay:close' && userId === (global as any).__admin ? [] : venueIds,
  ),
}))

const AHORA = new Date('2026-09-02T12:00:00Z')
let m: Mundo
const ajustar = (actorId: string, classSessionId: string, payCountOverride: number) =>
  guardarAjusteDeClase({
    venueId: m.venueId,
    classSessionId,
    payCountOverride,
    payAmountOverride: null,
    payExcluded: false,
    reason: 'Eran más',
    actorId,
  })
const cerrar = async (huella?: string) => {
  const h = huella ?? (await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })).huella
  return cerrarPeriodo({
    userId: m.owner,
    venueId: m.venueId,
    fecha: '2026-08-15',
    ahora: AHORA,
    huellaEsperada: h,
    confirmarHuerfanas: true,
  })
}

beforeEach(async () => {
  m = await crearMundo('ajuste-f2')
  ;(global as any).__sedes = [m.venueId]
  ;(global as any).__admin = m.sofia
  await tablaMindform(m)
})
afterEach(() => borrarMundo(m))

describe('ajustes de una clase ya contabilizada (spec §5.4)', () => {
  it('sin staffpay:close no se corrige; con él sí, y lo congelado no se mueve', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrar()
    await expect(ajustar(m.sofia, id, 9)).rejects.toThrow('Esta clase ya se contabilizó')
    const card = await ajustar(m.owner, id, 9)
    expect(card).toMatchObject({ estado: 'OK', conteo: 9, monto: '610.00' })
    const congelado = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, concept: 'SERVICE' } })
    expect(congelado.amount.toFixed(2)).toBe('570.00')
    // El ajuste no toca el ancla.
    const ps = await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })
    expect(ps.originPeriodId).not.toBeNull()
    expect(ps.valuationVersionId).not.toBeNull()
  })

  it('la tarjeta de una clase contabilizada dice su periodo de origen y cada línea con el estado de su recibo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const r = await cerrar()
    const card = await pagoDeClase(m.venueId, id)
    expect(card).toMatchObject({
      anclada: true,
      periodoOrigen: { id: r.periodId, start: '2026-08-01', end: '2026-08-31', estado: 'CLOSED' },
    })
    expect(card.lineas).toEqual([
      {
        concepto: 'SERVICE',
        staffId: m.ana,
        staffName: 'Ana QA',
        monto: '570.00',
        periodo: { start: '2026-08-01', end: '2026-08-31' },
        pagadoEn: null,
      },
    ])
  })

  it('una clase sin contabilizar no trae periodo de origen ni líneas (regresión de la fase 1)', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const card = await pagoDeClase(m.venueId, id)
    expect(card).toMatchObject({ estado: 'OK', conteo: 8, monto: '570.00', anclada: false, periodoOrigen: null, lineas: [] })
    // Sin ancla un ADMIN sí corrige (no hace falta staffpay:close).
    await expect(ajustar(m.sofia, id, 9)).resolves.toMatchObject({ estado: 'OK', conteo: 9, monto: '610.00' })
  })

  it('un ADMIN que corrige mientras el OWNER cierra: o el ajuste entró antes (y el cierre pide revisar), o se le exige staffpay:close', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    // El periodo existe ANTES: el cierre y el ajuste lo encuentran y se detienen en su candado (la barrera lo tiene).
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    // El preview va ANTES de la carrera (Codex R1-15): si no, el ajuste podía terminar antes del preview y los dos
    // éxitos serían correctos, y la prueba fallaría sin defecto.
    const { huella } = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    // Barrera real (Codex R3-R1-15): se suelta sólo cuando los DOS esperan el candado del periodo.
    const barrera = await barreraDelPeriodo(agosto.id)
    const carrera = Promise.allSettled([cerrar(huella), ajustar(m.sofia, id, 9)])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [cierre, ajuste] = await carrera
    const ps = await prisma.classSessionPayState.findUnique({ where: { classSessionId: id } })
    if (ajuste.status === 'fulfilled') {
      // El ajuste ganó: el cierre vio otra huella y no congeló nada.
      expect(cierre).toMatchObject({ status: 'rejected', reason: { code: 'HUELLA_CAMBIO' } })
      expect(ps?.originPeriodId ?? null).toBeNull()
    } else {
      // El cierre ganó: el reintento del ajuste vio el ancla y le exigió staffpay:close (nada de bloqueo mutuo: 40P01).
      expect(ajuste.reason).toMatchObject({ message: expect.stringContaining('Esta clase ya se contabilizó') })
      expect(cierre.status).toBe('fulfilled')
      expect(ps?.payCountOverride ?? null).toBeNull()
    }
  })

  // La carrera de arriba casi siempre la gana el ajuste (llega antes al candado). Ésta fuerza el otro orden: el cierre
  // espera PRIMERO, así que toma el periodo, ancla y confirma; el ajuste, que esperaba detrás, reintenta (40001, nunca
  // 40P01) y ya ve el ancla.
  it('si el cierre llega primero al candado del periodo, el ajuste de un ADMIN reintenta, ve el ancla y se le exige staffpay:close', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const { huella } = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
    const barrera = await barreraDelPeriodo(agosto.id)
    let carrera: Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> | undefined
    try {
      const cierre = cerrar(huella)
      cierre.catch(() => undefined) // si la barrera falla antes del allSettled, que no quede un rechazo sin atender
      await barrera.esperarA(1)
      carrera = Promise.allSettled([cierre, ajustar(m.sofia, id, 9)]) as typeof carrera
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [cierre, ajuste] = await carrera!
    expect(cierre.status).toBe('fulfilled')
    expect(ajuste).toMatchObject({ status: 'rejected', reason: { message: expect.stringContaining('Esta clase ya se contabilizó') } })
    const ps = await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })
    expect(ps).toMatchObject({ originPeriodId: agosto.id, payCountOverride: null })
    // Con el permiso, el mismo ajuste sí entra después y lo congelado sigue en $570.
    await expect(ajustar(m.owner, id, 9)).resolves.toMatchObject({ conteo: 9, monto: '610.00' })
    const congelado = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceId: id, concept: 'SERVICE' } })
    expect(congelado.amount.toFixed(2)).toBe('570.00')
  })

  // Ronda 1 de A10 (40P01 latente con la liquidación de B2): quien tiene el candado del periodo NO debe detener a quien sólo
  // apunta a él con una llave foránea (la comprobación de la FK toma FOR KEY SHARE, que choca con FOR UPDATE y no con
  // FOR NO KEY UPDATE). Y el candado sigue serializando a otro escritor del mismo periodo.
  it('el candado del periodo no detiene a quien ancla una clase en él, pero sí a otro escritor del periodo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const otra = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    let soltar!: () => void
    let tomado!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    const listo = new Promise<void>(r => (tomado = r))
    const tieneElCandado = prisma.$transaction(
      async t => {
        await bloquearPeriodo(t, agosto.id)
        tomado()
        await suelto
      },
      { maxWait: 10_000, timeout: 30_000 },
    )
    // Con un tiempo límite corto: si espera el candado de la primera, revienta con «lock timeout» en vez de colgarse.
    const conLimite = <T>(f: (t: Prisma.TransactionClient) => Promise<T>) =>
      otra.$transaction(async t => {
        await t.$executeRaw`SET LOCAL lock_timeout = '1500ms'`
        return f(t)
      })
    try {
      await Promise.race([listo, tieneElCandado]) // si no pudo tomar el candado, falla aquí en vez de colgarse
      await conLimite(t =>
        t.classSessionPayState.upsert({
          where: { classSessionId: id },
          create: { classSessionId: id, originPeriodId: agosto.id },
          update: { originPeriodId: agosto.id },
        }),
      )
      await expect(conLimite(t => bloquearPeriodo(t, agosto.id))).rejects.toThrow(/lock timeout/)
    } finally {
      soltar()
      await tieneElCandado
      await otra.$disconnect()
    }
    const ps = await prisma.classSessionPayState.findUniqueOrThrow({ where: { classSessionId: id } })
    expect(ps.originPeriodId).toBe(agosto.id)
  })

  it('una clase cancelada después del cierre conserva sus líneas en la tarjeta', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrar()
    await prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } })
    const card = await pagoDeClase(m.venueId, id)
    expect(card).toMatchObject({ estado: 'CANCELADA', anclada: true })
    expect(card.lineas).toHaveLength(1)
  })
})
