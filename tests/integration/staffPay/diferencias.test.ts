// tests/integration/staffPay/diferencias.test.ts
import prisma from '@/utils/prismaClient'
import {
  diferenciasDeClase,
  diferenciasDelPeriodo,
  diferenciasSql,
  FilaDiferencia,
} from '@/services/dashboard/staffPay/diferencias.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { NotFoundError } from '@/errors/AppError'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, tablaMindform } from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegibles: jest.fn(async () => ({ venueIds: (global as any).__sedes, parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  tienePermisoEn: jest.fn(async () => true),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))
const acceso = jest.requireMock('@/services/dashboard/staffPay/acceso')

const AHORA = new Date('2026-09-02T12:00:00Z')
let m: Mundo
let periodId: string
const cerrarAgosto = async () => {
  const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
  periodId = (
    await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-08-15',
      ahora: AHORA,
      huellaEsperada: p.huella,
      confirmarHuerfanas: true,
    })
  ).periodId
}
const pendientes = async (classSessionId: string) =>
  Object.fromEntries((await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId })).filas.map(f => [f.persona, f.pendiente]))
/** Todas las páginas de la lista del periodo, siguiendo el cursor hasta el final. */
const todasLasPaginas = async (limit: number, tamLote?: number, topeSinAncla?: number) => {
  const items: FilaDiferencia[] = []
  let cursor: string | undefined
  for (let i = 0; i < 50; i++) {
    const p = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit, cursor }, { tamLote, topeSinAncla })
    expect(p.items.length).toBeLessThanOrEqual(limit)
    items.push(...p.items)
    if (!p.nextCursor) return items
    cursor = p.nextCursor
  }
  throw new Error('el cursor nunca terminó')
}

beforeEach(async () => {
  m = await crearMundo('diferencias')
  ;(global as any).__sedes = [m.venueId]
  await tablaMindform(m)
})
afterEach(() => borrarMundo(m))

describe('diferencias pendientes (spec §6.4)', () => {
  it('corregir el conteo de una clase cerrada de 8 a 9 da +$40; de 10 a 9, −$40 (con la regla del ancla)', async () => {
    const c8 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const c10 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(10) })
    await cerrarAgosto()
    await prisma.classSessionPayState.update({ where: { classSessionId: c8 }, data: { payCountOverride: 9 } })
    await prisma.classSessionPayState.update({ where: { classSessionId: c10 }, data: { payCountOverride: 9 } })
    expect(await pendientes(c8)).toEqual({ [m.ana]: '40.00' })
    expect(await pendientes(c10)).toEqual({ [m.ana]: '-40.00' })
  })

  it('un check-in o una reserva que llega después del cierre sale como diferencia, no se pierde', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.reservation.create({
      data: {
        venueId: m.venueId,
        classSessionId: id,
        productId: m.productId,
        confirmationCode: `${m.key}-tarde`,
        status: 'CHECKED_IN',
        startsAt: new Date('2026-08-04T14:00:00Z'),
        endsAt: new Date('2026-08-04T14:50:00Z'),
        duration: 50,
        blockedEndsAt: new Date('2026-08-04T14:50:00Z'),
        partySize: 1,
        confirmedAt: new Date('2026-08-03T14:00:00Z'),
      },
    })
    expect(await pendientes(id)).toEqual({ [m.ana]: '40.00' })
  })

  it('cambio de coach: −la original y +la suplente con su propio nivel', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia } })
    expect(await pendientes(id)).toEqual({ [m.ana]: '-570.00', [m.sofia]: '480.00' })
  })

  it('una clase cancelada después del cierre da su negativo', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { status: 'CANCELLED' } })
    expect(await pendientes(id)).toEqual({ [m.ana]: '-570.00' })
  })

  it('una clase que llegó tarde (sin ancla en las fechas del periodo cerrado) es toda pendiente y la tarjeta lo dice', async () => {
    await cerrarAgosto()
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
    expect(await pendientes(id)).toEqual({ [m.ana]: '430.00' })
    expect(await pagoDeClase(m.venueId, id)).toMatchObject({ llegoTarde: true, anclada: false })
  })

  it('una clase anclada no «llegó tarde», ni una de un periodo sin cerrar', async () => {
    const anclada = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    const abierta = await clase(m, { staffId: m.ana, inicioIso: '2026-09-01T14:00:00Z', reservas: confirmadas(3) })
    expect(await pagoDeClase(m.venueId, anclada)).toMatchObject({ llegoTarde: false, anclada: true })
    expect(await pagoDeClase(m.venueId, abierta)).toMatchObject({ llegoTarde: false, anclada: false })
    expect(await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: abierta })).toEqual({ origen: null, filas: [] })
  })

  it('una clase en excepción no da número: todas sus filas quedan en null', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: null } })
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id })
    expect(filas.map(f => [f.persona, f.pendiente, f.motivo])).toEqual([[m.ana, null, 'SIN_COACH']])
  })

  it('una clase que llegó tarde SIN coach y sin líneas aparece como excepción (no desaparece) — Codex R1-17', async () => {
    await cerrarAgosto()
    const id = await clase(m, { staffId: null, inicioIso: '2026-08-21T14:00:00Z', reservas: confirmadas(3) })
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id })
    expect(filas.map(f => [f.persona, f.pendiente, f.motivo])).toEqual([[null, null, 'SIN_COACH']])
    const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 })
    expect(lista.items.map(i => i.classSessionId)).toContain(id)
  })

  it('el periodo lista sólo lo que tiene pendiente o excepción, paginado con cursor estable', async () => {
    const ids = [] as string[]
    for (let d = 4; d <= 8; d++)
      ids.push(await clase(m, { staffId: m.ana, inicioIso: `2026-08-0${d}T14:00:00Z`, reservas: confirmadas(8) }))
    await cerrarAgosto()
    for (const id of ids.slice(0, 3))
      await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const p1 = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 2 })
    expect(p1.items).toHaveLength(2)
    const p2 = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 2, cursor: p1.nextCursor! })
    expect(p2.items).toHaveLength(1)
    expect(p2.nextCursor).toBeNull()
    expect(new Set([...p1.items, ...p2.items].map(i => i.classSessionId))).toEqual(new Set(ids.slice(0, 3)))
    // Una página que se llena justo con lo último no ofrece «Cargar más» (mira una fila de más).
    const justa = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 3 })
    expect(justa.items).toHaveLength(3)
    expect(justa.nextCursor).toBeNull()
  })

  it('limit y lote no finitos o con decimales caen a un valor válido (nunca el periodo entero ni un SQL roto)', async () => {
    // 51 diferencias (una más que la página por default): sin reservas se congelan en $0 y corregidas a 9 dan +$610.
    const ids = [] as string[]
    for (let i = 0; i < 51; i++)
      ids.push(await clase(m, { staffId: m.ana, inicioIso: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T14:00:00Z` }))
    await cerrarAgosto()
    await prisma.classSessionPayState.updateMany({ where: { classSessionId: { in: ids } }, data: { payCountOverride: 9 } })
    const raro = await diferenciasDelPeriodo(
      { userId: m.owner, venueId: m.venueId, periodId, limit: NaN },
      { tamLote: NaN, topeSinAncla: Infinity },
    )
    expect(raro.items).toHaveLength(50)
    expect(raro.items.every(i => i.pendiente === '610.00')).toBe(true)
    expect(raro.nextCursor).not.toBeNull()
    const decimal = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 1.7 }, { tamLote: 1.5 })
    expect(decimal.items).toHaveLength(1)
    expect(decimal.nextCursor).not.toBeNull()
  })

  it('el SQL de las diferencias exige ids: sin ellos valoraría el periodo entero sin LIMIT', () => {
    const f = { venueId: m.venueId, organizationId: m.orgId, tz: 'UTC', desde: AHORA, hasta: AHORA, ahora: AHORA }
    expect(() => diferenciasSql({ ...f, modo: 'periodo', periodId: 'x', claseIds: [] }, null, true)).toThrow(/claseIds/)
    expect(() => diferenciasSql({ ...f, modo: 'periodo', periodId: 'x' }, null, true)).toThrow(/claseIds/)
  })

  it('una sede que no existe es «no encontrada», no un error de Prisma', async () => {
    await cerrarAgosto()
    await expect(diferenciasDelPeriodo({ userId: m.owner, venueId: 'no-existe', periodId, limit: 10 })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('una clase sin ancla de una sede FUERA del alcance del periodo cerrado no es candidata de él (spec §5.6)', async () => {
    await cerrarAgosto() // alcance: sólo la sede del mundo
    const b = await crearSede(m.orgId, m.key, 'bsf')
    await tablaMindform(m, b.venueId)
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3), ...b })
    expect(await diferenciasDeClase(prisma, { venueId: b.venueId, classSessionId: id })).toEqual({ origen: null, filas: [] })
    expect(await pagoDeClase(b.venueId, id)).toMatchObject({ llegoTarde: false, anclada: false })
    expect((await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 })).items).toEqual([])
  })

  it('un lote sin ninguna diferencia no corta el recorrido: con lotes de 1 encuentra la clase que va después', async () => {
    const ids = [] as string[]
    for (let d = 4; d <= 7; d++)
      ids.push(await clase(m, { staffId: m.ana, inicioIso: `2026-08-0${d}T14:00:00Z`, reservas: confirmadas(8) }))
    await cerrarAgosto()
    // La de id MAYOR (en el orden de la base): todas las demás (sin diferencia) se recorren antes que ella.
    const ultima = (
      await prisma.classSession.findFirstOrThrow({ where: { id: { in: ids } }, orderBy: { id: 'desc' }, select: { id: true } })
    ).id
    await prisma.classSessionPayState.update({ where: { classSessionId: ultima }, data: { payCountOverride: 9 } })
    const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 }, { tamLote: 1 })
    expect(lista.items.map(i => [i.classSessionId, i.persona, i.pendiente])).toEqual([[ultima, m.ana, '40.00']])
    expect(lista.nextCursor).toBeNull()
  })

  it('una clase anclada en agosto y reprogramada a septiembre sigue en las diferencias de agosto con su número', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({
      where: { id },
      data: { startsAt: new Date('2026-09-10T14:00:00Z'), endsAt: new Date('2026-09-10T14:50:00Z') },
    })
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    expect(await pendientes(id)).toEqual({ [m.ana]: '40.00' })
    const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 })
    expect(lista.items.map(i => [i.classSessionId, i.persona, i.pendiente, i.periodoOrigenId])).toEqual([[id, m.ana, '40.00', periodId]])
  })

  it('una página que se llena a media clase sigue con las personas restantes de esa clase', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia } })
    const p1 = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 1 })
    expect(p1.items).toHaveLength(1)
    expect(p1.nextCursor).toBe(`${m.venueId}:${id}:${p1.items[0].persona}`)
    const items = await todasLasPaginas(1)
    expect(items.map(i => [i.persona, i.pendiente]).sort()).toEqual(
      [
        [m.ana, '-570.00'],
        [m.sofia, '480.00'],
      ].sort(),
    )
  })

  it('mezcla en el orden de la base las ancladas y las que llegaron tarde, con la lista «sin ancla» cargada o no', async () => {
    // Creadas intercaladas: t1 y t2 nacen en octubre (fuera del cierre) y después se mueven a agosto: llegaron tarde.
    const a1 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const t1 = await clase(m, { staffId: m.ana, inicioIso: '2026-10-20T14:00:00Z', reservas: confirmadas(3) })
    const a2 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-05T14:00:00Z', reservas: confirmadas(8) })
    const t2 = await clase(m, { staffId: m.ana, inicioIso: '2026-10-21T14:00:00Z', reservas: confirmadas(3) })
    await cerrarAgosto()
    for (const [id, dia] of [
      [t1, '20'],
      [t2, '21'],
    ]) {
      await prisma.classSession.update({
        where: { id },
        data: { startsAt: new Date(`2026-08-${dia}T14:00:00Z`), endsAt: new Date(`2026-08-${dia}T14:50:00Z`) },
      })
      await prisma.reservation.updateMany({ where: { classSessionId: id }, data: { startsAt: new Date(`2026-08-${dia}T14:00:00Z`) } })
    }
    for (const id of [a1, a2]) await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
    const monto: Record<string, string> = { [a1]: '40.00', [a2]: '40.00', [t1]: '430.00', [t2]: '430.00' }
    const orden = await prisma.classSession.findMany({
      where: { id: { in: [a1, a2, t1, t2] } },
      orderBy: { id: 'asc' },
      select: { id: true },
    })
    const esperado = orden.map(c => [c.id, monto[c.id]])
    for (const tamLote of [1, 500]) {
      for (const topeSinAncla of [undefined, 1]) {
        const items = await todasLasPaginas(1, tamLote, topeSinAncla)
        expect(items.map(i => [i.classSessionId, i.pendiente])).toEqual(esperado)
      }
    }
  })
  describe('dos sedes', () => {
    let sedes: string[]
    let porSede: Record<string, string[]>
    beforeEach(async () => {
      const b = await crearSede(m.orgId, m.key, 'bsf')
      await tablaMindform(m, b.venueId)
      ;(global as any).__sedes = [m.venueId, b.venueId]
      const ids: Record<string, string[]> = { [m.venueId]: [], [b.venueId]: [] }
      for (const d of [4, 5]) {
        ids[m.venueId].push(await clase(m, { staffId: m.ana, inicioIso: `2026-08-0${d}T14:00:00Z`, reservas: confirmadas(8) }))
        ids[b.venueId].push(await clase(m, { staffId: m.ana, inicioIso: `2026-08-0${d}T15:00:00Z`, reservas: confirmadas(8), ...b }))
      }
      await cerrarAgosto()
      for (const id of [...ids[m.venueId], ...ids[b.venueId]])
        await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
      // El orden del servicio: sedes por id; dentro, clases en el orden de la base.
      sedes = [m.venueId, b.venueId].sort()
      porSede = {}
      for (const v of sedes)
        porSede[v] = (await prisma.classSession.findMany({ where: { venueId: v }, orderBy: { id: 'asc' }, select: { id: true } })).map(
          c => c.id,
        )
    })

    it('el cursor cruza de la primera sede a la segunda sin repetir ni saltar filas', async () => {
      const items = await todasLasPaginas(1)
      expect(items.map(i => [i.venueId, i.classSessionId, i.pendiente])).toEqual(sedes.flatMap(v => porSede[v].map(id => [v, id, '40.00'])))
    })

    it('si la sede del cursor deja de ser legible entre páginas, sigue en la siguiente sin repetir ni saltar filas', async () => {
      const p1 = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 1 })
      expect(p1.items.map(i => i.classSessionId)).toEqual([porSede[sedes[0]][0]])
      acceso.sedesLegiblesDe.mockImplementationOnce(async (_u: string, venueIds: string[]) => ({
        venueIds: venueIds.filter(v => v !== sedes[0]),
        parcial: true,
      }))
      const p2 = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 10, cursor: p1.nextCursor! })
      expect(p2.items.map(i => i.classSessionId)).toEqual(porSede[sedes[1]])
      expect(p2).toMatchObject({ nextCursor: null, parcial: true })
    })
  })
  describe('la causa de cada diferencia (QA bloque B, defecto 4)', () => {
    /** persona → [causa, conteoCongelado, conteo, coachActualNombre], sólo las filas con algo pendiente o en excepción. */
    const causas = async (classSessionId: string) =>
      Object.fromEntries(
        (await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId })).filas.map(f => [
          f.persona,
          [f.causa, f.conteoCongelado, f.conteo, f.coachActualNombre],
        ]),
      )
    const anclada = async (dia: string, n = 8) => {
      const id = await clase(m, { staffId: m.ana, inicioIso: `2026-08-${dia}T14:00:00Z`, reservas: confirmadas(n) })
      return id
    }

    it('conteo corregido: CONTEO con el conteo congelado y el de hoy', async () => {
      const id = await anclada('04')
      await cerrarAgosto()
      await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 9 } })
      expect(await causas(id)).toEqual({ [m.ana]: ['CONTEO', 8, 9, 'Ana QA'] })
    })

    it('otra coach: COACH_SALE para la original (con el nombre de quien la da hoy) y COACH_ENTRA para la suplente', async () => {
      const id = await anclada('04')
      await cerrarAgosto()
      await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia } })
      expect(await causas(id)).toEqual({
        [m.ana]: ['COACH_SALE', 8, 8, 'Sofia QA'],
        [m.sofia]: ['COACH_ENTRA', null, 8, 'Sofia QA'],
      })
    })

    it('cancelada, excluida del pago y tardía', async () => {
      const cancelada = await anclada('04')
      const excluida = await anclada('05')
      await cerrarAgosto()
      const tardia = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
      await prisma.classSession.update({ where: { id: cancelada }, data: { status: 'CANCELLED' } })
      await prisma.classSessionPayState.update({ where: { classSessionId: excluida }, data: { payExcluded: true } })
      expect(await causas(cancelada)).toEqual({ [m.ana]: ['CANCELADA', 8, 8, 'Ana QA'] })
      expect(await causas(excluida)).toEqual({ [m.ana]: ['EXCLUIDA', 8, 8, 'Ana QA'] })
      expect(await causas(tardia)).toEqual({ [m.ana]: ['TARDIA', null, 3, 'Ana QA'] })
      // La lista del periodo trae los mismos campos.
      const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 })
      expect(Object.fromEntries(lista.items.map(i => [i.classSessionId, i.causa]))).toEqual({
        [cancelada]: 'CANCELADA',
        [excluida]: 'EXCLUIDA',
        [tardia]: 'TARDIA',
      })
    })

    it('una clase que no se pagaba al cerrar y ahora sí es REINCLUIDA, no TARDIA: excluida → incluida y cancelada → reactivada', async () => {
      const excluida = await anclada('04')
      const cancelada = await anclada('05')
      // Al cerrar: la excluida se ancla SIN SERVICE; la cancelada ni se paga ni se ancla.
      await prisma.classSessionPayState.create({ data: { classSessionId: excluida, payExcluded: true, overrideReason: 'prueba' } })
      await prisma.classSession.update({ where: { id: cancelada }, data: { status: 'CANCELLED' } })
      await cerrarAgosto()
      expect(await prisma.serviceEarning.count({ where: { sourceId: { in: [excluida, cancelada] } } })).toBe(0)
      await prisma.classSessionPayState.update({ where: { classSessionId: excluida }, data: { payExcluded: false } })
      await prisma.classSession.update({ where: { id: cancelada }, data: { status: 'SCHEDULED' } })
      expect(await causas(excluida)).toEqual({ [m.ana]: ['REINCLUIDA', null, 8, 'Ana QA'] })
      expect(await causas(cancelada)).toEqual({ [m.ana]: ['REINCLUIDA', null, 8, 'Ana QA'] })
      // Anclada sin líneas aunque se creó después (p. ej. una liquidación de $0 la ancló): también REINCLUIDA.
      const anclada0 = await clase(m, { staffId: m.ana, inicioIso: '2026-08-21T14:00:00Z', reservas: confirmadas(3) })
      await prisma.classSessionPayState.create({
        data: { classSessionId: anclada0, originPeriodId: periodId, valuationDate: new Date('2026-08-21T00:00:00Z') },
      })
      expect(await causas(anclada0)).toEqual({ [m.ana]: ['REINCLUIDA', null, 3, 'Ana QA'] })
      // La que se CREÓ después del cierre sigue siendo TARDIA.
      const tardia = await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T14:00:00Z', reservas: confirmadas(3) })
      const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50 })
      expect(Object.fromEntries(lista.items.map(i => [i.classSessionId, i.causa]))).toEqual({
        [excluida]: 'REINCLUIDA',
        [cancelada]: 'REINCLUIDA',
        [anclada0]: 'REINCLUIDA',
        [tardia]: 'TARDIA',
      })
    })

    it('monto ajustado con el mismo conteo: MONTO', async () => {
      const id = await anclada('04')
      await cerrarAgosto()
      await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payAmountOverride: 600 } })
      expect(await causas(id)).toEqual({ [m.ana]: ['MONTO', 8, 8, 'Ana QA'] })
    })

    it('tras liquidar en 9, otra corrección a 10 compara contra 9 (la última línea), no contra el cierre', async () => {
      const id = await anclada('04')
      await cerrarAgosto()
      await prisma.serviceEarning.create({
        data: {
          organizationId: m.orgId,
          venueId: m.venueId,
          periodId,
          staffId: m.ana,
          concept: 'RECONCILE',
          sourceType: 'CLASS_SESSION',
          sourceId: id,
          count: 9,
          amount: 40,
          descriptor: {},
        },
      })
      await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 10 } })
      expect(await causas(id)).toEqual({ [m.ana]: ['CONTEO', 9, 10, 'Ana QA'] })
    })

    it('sin pendiente o en excepción no hay causa', async () => {
      const igual = await anclada('04')
      const sinCoach = await anclada('05')
      await cerrarAgosto()
      await prisma.classSession.update({ where: { id: sinCoach }, data: { assignedStaffId: null } })
      expect(await causas(igual)).toEqual({ [m.ana]: [null, 8, 8, 'Ana QA'] })
      expect(await causas(sinCoach)).toEqual({ [m.ana]: [null, 8, 8, null] })
    })
  })
})
