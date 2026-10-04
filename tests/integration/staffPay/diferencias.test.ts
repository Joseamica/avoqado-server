// tests/integration/staffPay/diferencias.test.ts
import prisma from '@/utils/prismaClient'
import { diferenciasDeClase, diferenciasDelPeriodo, FilaDiferencia } from '@/services/dashboard/staffPay/diferencias.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, tablaMindform } from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegibles: jest.fn(async () => ({ venueIds: (global as any).__sedes, parcial: false })),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  tienePermisoEn: jest.fn(async () => true),
  assertPermisoEnSedes: jest.fn(async () => undefined),
}))

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
    const p = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit, cursor, tamLote, topeSinAncla })
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
    const lista = await diferenciasDelPeriodo({ userId: m.owner, venueId: m.venueId, periodId, limit: 50, tamLote: 1 })
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
})
