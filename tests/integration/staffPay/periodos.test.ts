import prisma from '@/utils/prismaClient'
import { withSerializableRetry } from '@/utils/serializableRetry'
import {
  ampliarAlcance,
  asegurarPeriodo,
  bloquearPeriodo,
  assertFechaNoCerrada,
  cambiarPeriodicidad,
  listarPeriodos,
} from '@/services/dashboard/staffPay/periodosGuardados'
import { asignarNivel } from '@/services/dashboard/staffPay/niveles.service'
import { publicarVersion, archivarTabla } from '@/services/dashboard/staffPay/tablas.service'
import { borrarMundo, crearMundo, crearSede, Mundo, periodoCerrado, tablaMindform, TZ } from './_mundo'
import { dbDateComoFecha, fechaComoDbDate, hoyLocal } from '@/services/dashboard/staffPay/periodos'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  assertPermisoEnTodasLasSedes: jest.fn().mockResolvedValue(undefined),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  assertPermisoEnSedes: jest.fn(async (_u: string, venueIds: string[], _p: string, msg: string) => {
    if (venueIds.some(v => !((global as any).__cierre ?? venueIds).includes(v))) throw Object.assign(new Error(msg), { statusCode: 403 })
  }),
}))

let m: Mundo
beforeAll(async () => {
  m = await crearMundo('periodos')
  ;(global as any).__sedes = [m.venueId]
})
afterAll(() => borrarMundo(m))

describe('periodos guardados (spec §5.7)', () => {
  it('asegurarPeriodo crea el intervalo canónico con el alcance actual, y la segunda vez devuelve el mismo', async () => {
    const a = await withSerializableRetry(tx => asegurarPeriodo(tx, m.orgId, '2026-03-17'))
    expect([dbDateComoFecha(a.periodStart), dbDateComoFecha(a.periodEnd)]).toEqual(['2026-03-01', '2026-03-31'])
    expect(a.venueIds).toEqual([m.venueId])
    const b = await withSerializableRetry(tx => asegurarPeriodo(tx, m.orgId, '2026-03-31'))
    expect(b.id).toBe(a.id)
  })

  it('dos aseguramientos concurrentes del mismo mes dejan UNA fila', async () => {
    await Promise.all([1, 2, 3].map(() => withSerializableRetry(tx => asegurarPeriodo(tx, m.orgId, '2026-04-10'))))
    expect(await prisma.servicePayPeriod.count({ where: { organizationId: m.orgId, periodStart: new Date('2026-04-01T00:00:00Z') } })).toBe(
      1,
    )
  })

  it('bloquear no amplía; ampliar exige permiso en TODA la unión; un periodo CLOSED no se amplía', async () => {
    const abierto = await withSerializableRetry(tx => asegurarPeriodo(tx, m.orgId, '2026-05-05'))
    const nueva = await crearSede(m.orgId, m.key, 'bsf')
    ;(global as any).__sedes = [m.venueId, nueva.venueId]
    const igual = await withSerializableRetry(tx => bloquearPeriodo(tx, abierto.id))
    expect(igual.venueIds).toEqual([m.venueId])
    const ampliar = () =>
      withSerializableRetry(async tx => ampliarAlcance(tx, await bloquearPeriodo(tx, abierto.id), [nueva.venueId], m.owner))
    ;(global as any).__cierre = [m.venueId] // sin permiso de cerrar en BSF
    await expect(ampliar()).rejects.toThrow(/cerrar periodos en todas sus sedes/)
    // Codex R2-R1-9: con permiso SÓLO en BSF tampoco se amplía un periodo de PN a PN+BSF (se exige la unión).
    ;(global as any).__cierre = [nueva.venueId]
    await expect(ampliar()).rejects.toThrow(/cerrar periodos en todas sus sedes/)
    expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: abierto.id } })).venueIds).toEqual([m.venueId])
    ;(global as any).__cierre = [m.venueId, nueva.venueId]
    const crecido = await withSerializableRetry(async tx =>
      ampliarAlcance(tx, await bloquearPeriodo(tx, abierto.id), [nueva.venueId], m.owner),
    )
    expect([...crecido.venueIds].sort()).toEqual([m.venueId, nueva.venueId].sort())
    const cerrado = await periodoCerrado(m, '2026-02-01', '2026-02-28')
    await expect(
      withSerializableRetry(async tx => ampliarAlcance(tx, await bloquearPeriodo(tx, cerrado.id), [nueva.venueId], m.owner)),
    ).rejects.toMatchObject({ code: 'PERIODO_CERRADO' })
    ;(global as any).__sedes = [m.venueId]
  })

  it('el selector lista el mes que acaba de terminar aunque nadie lo haya guardado', async () => {
    const l = await listarPeriodos({ userId: m.owner, venueId: m.venueId, limit: 24 })
    const hoy = hoyLocal(TZ).slice(0, 7)
    expect(l.items.length).toBeGreaterThanOrEqual(12)
    expect(l.items[0].start.slice(0, 7)).toBe(hoy)
    expect(l.items.some(i => i.id === null && i.estado === 'OPEN' && i.start < `${hoy}-01`)).toBe(true)
  })

  it('una fecha dentro de un periodo cerrado se rechaza en español', async () => {
    await expect(assertFechaNoCerrada(prisma, m.orgId, '2026-02-14')).rejects.toThrow(/ya está cerrado/)
    await expect(assertFechaNoCerrada(prisma, m.orgId, '2026-06-14')).resolves.toBeUndefined()
  })

  it('asignar un nivel o publicar/archivar una tabla con fecha dentro del periodo cerrado no guarda nada', async () => {
    const antes = await prisma.staffPayLevelAssignment.count({ where: { organizationId: m.orgId } })
    await expect(
      asignarNivel({
        organizationId: m.orgId,
        staffId: m.sofia,
        payLevelId: m.hc,
        effectiveFrom: '2026-02-10',
        actorId: m.owner,
        venueId: m.venueId,
        soloSimular: false,
      }),
    ).rejects.toThrow(/ya está cerrado/)
    expect(await prisma.staffPayLevelAssignment.count({ where: { organizationId: m.orgId } })).toBe(antes)
    const t = await tablaMindform(m)
    await expect(
      publicarVersion({
        venueId: m.venueId,
        organizationId: m.orgId,
        tableId: t.tableId,
        effectiveFrom: '2026-02-20',
        countMode: 'BOOKED',
        maxCount: 3,
        cells: [],
        actorId: m.owner,
        soloSimular: false,
      }),
    ).rejects.toThrow(/ya está cerrado/)
    await expect(archivarTabla({ venueId: m.venueId, tableId: t.tableId, archivedFrom: '2026-02-20', actorId: m.owner })).rejects.toThrow(
      /ya está cerrado/,
    )
  })

  it('mover el archivo de una tabla archivada DENTRO de un periodo cerrado tampoco se acepta (spec §5.3: lo congelado no se cambia)', async () => {
    // Sede aparte: así la tabla «archivada desde el 5-feb» no se empalma con la de PN y el único motivo de rechazo es el cierre.
    const sede = await crearSede(m.orgId, m.key, 'arch')
    const t = await tablaMindform(m, sede.venueId)
    const archivada = fechaComoDbDate('2026-02-05')
    await prisma.servicePayTable.update({ where: { id: t.tableId }, data: { archivedFrom: archivada } })
    await expect(
      archivarTabla({ venueId: sede.venueId, tableId: t.tableId, archivedFrom: '2026-04-01', actorId: m.owner }),
    ).rejects.toThrow(/ya está cerrado/)
    const despues = await prisma.servicePayTable.findUniqueOrThrow({ where: { id: t.tableId }, select: { archivedFrom: true } })
    expect(despues.archivedFrom).toEqual(archivada)
  })

  it('la periodicidad no se puede cambiar cuando ya hay periodos guardados (nunca traslapes)', async () => {
    await expect(cambiarPeriodicidad({ userId: m.owner, venueId: m.venueId, periodicidad: 'SEMIMONTHLY' })).rejects.toThrow(
      /ya no se puede cambiar/,
    )
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { servicePayPeriodicity: true } })
    expect(org.servicePayPeriodicity).toBe('MONTHLY')
  })
})
