import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  ampliarAlcance,
  asegurarPeriodo,
  bloquearPeriodo,
  assertFechaNoCerrada,
  cambiarPeriodicidad,
  listarPeriodos,
  transaccionConPresupuesto,
} from '@/services/dashboard/staffPay/periodosGuardados'
import { asignarNivel } from '@/services/dashboard/staffPay/niveles.service'
import { publicarVersion, archivarTabla } from '@/services/dashboard/staffPay/tablas.service'
import { efectoDelCambio } from '@/services/dashboard/staffPay/efecto'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, periodoCerrado, PN_HC, tablaMindform, TZ } from './_mundo'
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
// Fecha fija coherente con los periodos de 2026 de este mundo (rango de ±24 meses, full-testing A11).
const AHORA = new Date('2026-10-04T12:00:00Z')
beforeAll(async () => {
  m = await crearMundo('periodos')
  ;(global as any).__sedes = [m.venueId]
})
afterAll(() => borrarMundo(m))

describe('periodos guardados (spec §5.7)', () => {
  it('asegurarPeriodo crea el intervalo canónico con el alcance actual, y la segunda vez devuelve el mismo', async () => {
    const a = await transaccionConPresupuesto((tx, p) => asegurarPeriodo(tx, m.orgId, '2026-03-17', p))
    expect([dbDateComoFecha(a.periodStart), dbDateComoFecha(a.periodEnd)]).toEqual(['2026-03-01', '2026-03-31'])
    expect(a.venueIds).toEqual([m.venueId])
    const b = await transaccionConPresupuesto((tx, p) => asegurarPeriodo(tx, m.orgId, '2026-03-31', p))
    expect(b.id).toBe(a.id)
  })

  it('dos aseguramientos concurrentes del mismo mes dejan UNA fila', async () => {
    await Promise.all([1, 2, 3].map(() => transaccionConPresupuesto((tx, p) => asegurarPeriodo(tx, m.orgId, '2026-04-10', p))))
    expect(await prisma.servicePayPeriod.count({ where: { organizationId: m.orgId, periodStart: new Date('2026-04-01T00:00:00Z') } })).toBe(
      1,
    )
  })

  it('bloquear no amplía; ampliar exige permiso en TODA la unión; un periodo CLOSED no se amplía', async () => {
    const abierto = await transaccionConPresupuesto((tx, p) => asegurarPeriodo(tx, m.orgId, '2026-05-05', p))
    const nueva = await crearSede(m.orgId, m.key, 'bsf')
    ;(global as any).__sedes = [m.venueId, nueva.venueId]
    const igual = await transaccionConPresupuesto((tx, p) => bloquearPeriodo(tx, abierto.id, p))
    expect(igual.venueIds).toEqual([m.venueId])
    const ampliar = () =>
      transaccionConPresupuesto(async (tx, p) => ampliarAlcance(tx, await bloquearPeriodo(tx, abierto.id, p), [nueva.venueId], m.owner))
    ;(global as any).__cierre = [m.venueId] // sin permiso de cerrar en BSF
    await expect(ampliar()).rejects.toThrow(/cerrar periodos en todas sus sedes/)
    // Codex R2-R1-9: con permiso SÓLO en BSF tampoco se amplía un periodo de PN a PN+BSF (se exige la unión).
    ;(global as any).__cierre = [nueva.venueId]
    await expect(ampliar()).rejects.toThrow(/cerrar periodos en todas sus sedes/)
    expect((await prisma.servicePayPeriod.findUniqueOrThrow({ where: { id: abierto.id } })).venueIds).toEqual([m.venueId])
    ;(global as any).__cierre = [m.venueId, nueva.venueId]
    const crecido = await transaccionConPresupuesto(async (tx, p) =>
      ampliarAlcance(tx, await bloquearPeriodo(tx, abierto.id, p), [nueva.venueId], m.owner),
    )
    expect([...crecido.venueIds].sort()).toEqual([m.venueId, nueva.venueId].sort())
    const cerrado = await periodoCerrado(m, '2026-02-01', '2026-02-28')
    await expect(
      transaccionConPresupuesto(async (tx, p) => ampliarAlcance(tx, await bloquearPeriodo(tx, cerrado.id, p), [nueva.venueId], m.owner)),
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
        ahora: AHORA,
      }),
    ).rejects.toThrow(/^Febrero ya se cerró: el nivel no puede empezar antes del /)
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
        ahora: AHORA,
      }),
    ).rejects.toThrow(/^Febrero ya se cerró: la tabla no puede empezar antes del /)
    await expect(
      archivarTabla({ venueId: m.venueId, tableId: t.tableId, archivedFrom: '2026-02-20', actorId: m.owner, ahora: AHORA }),
    ).rejects.toThrow(/^Febrero ya se cerró: la tabla no puede archivarse antes del /)
  })

  it('mover el archivo de una tabla archivada DENTRO de un periodo cerrado tampoco se acepta (spec §5.3: lo congelado no se cambia)', async () => {
    // Sede aparte: así la tabla «archivada desde el 5-feb» no se empalma con la de PN y el único motivo de rechazo es el cierre.
    const sede = await crearSede(m.orgId, m.key, 'arch')
    const t = await tablaMindform(m, sede.venueId)
    const archivada = fechaComoDbDate('2026-02-05')
    await prisma.servicePayTable.update({ where: { id: t.tableId }, data: { archivedFrom: archivada } })
    await expect(
      archivarTabla({ venueId: sede.venueId, tableId: t.tableId, archivedFrom: '2026-04-01', actorId: m.owner, ahora: AHORA }),
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

// Revisión final, I-2: el aviso «Cambia el pago de N clases» valoraba sólo el periodo de HOY. Con una vigencia en septiembre
// (aún sin cerrar, lo normal a inicio de mes) decía 0 aunque cambiaran todas las clases de septiembre que se calculan en vivo.
describe('efecto de publicar una tabla o asignar un nivel (spec §7.1)', () => {
  const AHORA_OCT = new Date('2026-10-04T12:00:00Z')
  let w: Mundo
  let tableId: string
  beforeAll(async () => {
    w = await crearMundo('efecto')
    ;(global as any).__sedes = [w.venueId]
    tableId = (await tablaMindform(w)).tableId
    // Agosto cerrado; septiembre y octubre abiertos (septiembre aún sin cerrar, como a inicio de mes).
    await periodoCerrado(w, '2026-08-01', '2026-08-31')
    for (const inicioIso of ['2026-08-10T14:00:00Z', '2026-09-10T14:00:00Z', '2026-09-20T14:00:00Z', '2026-10-02T14:00:00Z'])
      await clase(w, { staffId: w.ana, inicioIso, reservas: confirmadas(8) })
  })
  afterAll(async () => {
    await borrarMundo(w)
    ;(global as any).__sedes = [m.venueId]
  })
  const simular = (effectiveFrom: string) =>
    publicarVersion({
      venueId: w.venueId,
      organizationId: w.orgId,
      tableId,
      effectiveFrom,
      countMode: 'BOOKED',
      maxCount: 10,
      // Head Coach +$10 en cada conteo: cambia toda clase de Ana que se calcule en vivo.
      cells: PN_HC.map((amount, count) => ({ payLevelId: w.hc, count, amount: amount + 10 })),
      actorId: w.owner,
      soloSimular: true,
      ahora: AHORA_OCT,
    })

  it('cuenta las clases de CADA periodo abierto desde la vigencia hasta hoy, no sólo las de hoy', async () => {
    expect(await simular('2026-09-01')).toEqual({
      clasesQueCambian: 3,
      porPeriodo: [
        { start: '2026-09-01', end: '2026-09-30', clases: 2 },
        { start: '2026-10-01', end: '2026-10-31', clases: 1 },
      ],
      periodosSinContar: 0,
    })
    expect(await prisma.servicePayTableVersion.count({ where: { tableId } })).toBe(1) // simular no guarda
  })

  it('asignar un nivel cuenta igual (Ana pasa a Coach desde septiembre)', async () => {
    const r = await asignarNivel({
      organizationId: w.orgId,
      staffId: w.ana,
      payLevelId: w.coach,
      effectiveFrom: '2026-09-15',
      actorId: w.owner,
      venueId: w.venueId,
      soloSimular: true,
      ahora: AHORA_OCT,
    })
    expect(r).toEqual({
      clasesQueCambian: 2,
      porPeriodo: [
        { start: '2026-09-01', end: '2026-09-30', clases: 1 },
        { start: '2026-10-01', end: '2026-10-31', clases: 1 },
      ],
      periodosSinContar: 0,
    })
  })

  it('con muchos periodos abiertos recorre los 3 más recientes y dice cuántos más quedaron sin contar; salta el cerrado', async () => {
    // Desde febrero: abiertos feb-jul, sep y oct (agosto cerrado) = 8. Se cuentan jul, sep y oct.
    expect(await simular('2026-02-01')).toEqual({
      clasesQueCambian: 3,
      porPeriodo: [
        { start: '2026-07-01', end: '2026-07-31', clases: 0 },
        { start: '2026-09-01', end: '2026-09-30', clases: 2 },
        { start: '2026-10-01', end: '2026-10-31', clases: 1 },
      ],
      periodosSinContar: 5,
    })
  })

  it('una vigencia de hace 25 años también llega a hoy: cuenta los periodos recientes y dice cuántos quedaron sin contar (m2)', async () => {
    // La API ya no acepta una vigencia así (full-testing A11: ±24 meses); el recorrido se prueba directo, con una versión
    // vigente más vieja que la nueva para que la nueva aplique hoy (se mueve al año 2000).
    await prisma.servicePayTableVersion.updateMany({ where: { tableId }, data: { effectiveFrom: fechaComoDbDate('2000-01-01') } })
    const aplicar = async (tx: Prisma.TransactionClient) => {
      const v = await tx.servicePayTableVersion.create({
        data: { tableId, effectiveFrom: fechaComoDbDate('2001-10-01'), revision: 1, maxCount: 10 },
      })
      await tx.servicePayTableCell.createMany({
        data: PN_HC.map((a, count) => ({ versionId: v.id, payLevelId: w.hc, count, amount: new Prisma.Decimal(a + 10) })),
      })
    }
    // 2001-10 a 2026-10 son 301 periodos mensuales; agosto de 2026 cerrado ⇒ 300 abiertos; se cuentan jul, sep y oct ⇒ 297.
    expect(await efectoDelCambio(w.orgId, [w.venueId], '2001-10-01', aplicar, AHORA_OCT)).toEqual({
      clasesQueCambian: 3,
      porPeriodo: [
        { start: '2026-07-01', end: '2026-07-31', clases: 0 },
        { start: '2026-09-01', end: '2026-09-30', clases: 2 },
        { start: '2026-10-01', end: '2026-10-31', clases: 1 },
      ],
      periodosSinContar: 297,
    })
  })

  // full-testing A11: la API aceptaba 1900 y 2999 (y el aviso decía «1515 meses abiertos»).
  it('la vigencia va de hoy − 24 meses a hoy + 24 meses: fuera, 400 con el rango, al simular y al guardar', async () => {
    const fuera = {
      statusCode: 400,
      code: 'FECHA_FUERA_DE_RANGO',
      message: 'La fecha de inicio debe estar entre 4 oct 2024 y 4 oct 2028',
      details: { desde: '2024-10-04', hasta: '2028-10-04' },
    }
    for (const fecha of ['1900-01-01', '2999-01-01', '2024-10-03', '2028-10-05']) {
      await expect(simular(fecha)).rejects.toMatchObject(fuera)
      await expect(
        asignarNivel({
          organizationId: w.orgId,
          staffId: w.ana,
          payLevelId: w.coach,
          effectiveFrom: fecha,
          actorId: w.owner,
          venueId: w.venueId,
          soloSimular: false,
          ahora: AHORA_OCT,
        }),
      ).rejects.toMatchObject(fuera)
    }
    // Guardar (no sólo simular) también, y archivar: la fecha de archivo con su propio texto.
    await expect(
      publicarVersion({
        venueId: w.venueId,
        organizationId: w.orgId,
        tableId,
        effectiveFrom: '2999-01-01',
        countMode: 'BOOKED',
        maxCount: 10,
        cells: [],
        actorId: w.owner,
        soloSimular: false,
        ahora: AHORA_OCT,
      }),
    ).rejects.toMatchObject(fuera)
    await expect(
      archivarTabla({ venueId: w.venueId, tableId, archivedFrom: '2999-01-01', actorId: w.owner, ahora: AHORA_OCT }),
    ).rejects.toMatchObject({ ...fuera, message: 'La fecha de archivo debe estar entre 4 oct 2024 y 4 oct 2028' })
    expect(await prisma.servicePayTableVersion.count({ where: { tableId } })).toBe(1)
    // Los bordes entran (simular).
    await expect(simular('2024-10-04')).resolves.toMatchObject({ clasesQueCambian: expect.any(Number) })
    await expect(simular('2028-10-04')).resolves.toMatchObject({ clasesQueCambian: 0, porPeriodo: [] })
  })

  it('una vigencia dentro de un periodo CERRADO se rechaza con una explicación y la primera fecha que sí se puede', async () => {
    await expect(simular('2026-08-15')).rejects.toMatchObject({
      statusCode: 400,
      code: 'FECHA_EN_PERIODO_CERRADO',
      message:
        'Agosto ya se cerró: la tabla no puede empezar antes del 1 sep 2026. Para una clase de un mes cerrado usa «Ajustar monto» en la clase',
      details: { primeraFechaPermitida: '2026-09-01' },
    })
  })
})
