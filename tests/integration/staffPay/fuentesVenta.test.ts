// tests/integration/staffPay/fuentesVenta.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  AlcanceBarrido,
  comisionesBarribles,
  consultasDeVentas,
  LineaBarrible,
  propinasBarribles,
  propinasSinDueno,
  reversosPorAnulacion,
  sqlVentasDelPeriodo,
} from '@/services/dashboard/staffPay/fuentesVenta'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, crearMundo, crearSede, Mundo, periodoCerrado, TZ } from './_mundo'
import { activar, cobro, comision, congelar, esquema, reembolso, ventana } from './_ventas'

let m: Mundo
let cfg: string
beforeEach(async () => {
  m = await crearMundo('fuentes')
  await activar(m, { propinasDesde: null }) // inicio 1-ago; cada prueba abre sus ventanas
  cfg = await esquema(m)
})
afterEach(() => borrarMundo(m))

const P = (start: string, end: string) => ({ start, end })
const JUL = P('2026-07-01', '2026-07-31')
const AGO = P('2026-08-01', '2026-08-31')
const SEP = P('2026-09-01', '2026-09-30')
const OCT = P('2026-10-01', '2026-10-31')
const alcance = (periodo: { start: string; end: string }, sedes = [{ venueId: m.venueId, tz: TZ }]): AlcanceBarrido => ({
  organizationId: m.orgId,
  periodo: { id: null, ...periodo },
  sedes,
  startDate: '2026-08-01',
})
const todas = (fn: typeof comisionesBarribles, a: AlcanceBarrido) => fn(prisma, a, { limite: 1000 })
const ids = (ls: LineaBarrible[]) => ls.map(l => l.sourceId).sort()
const por = (ls: LineaBarrible[]) =>
  Object.fromEntries(
    ls.map(l => [
      l.sourceId,
      { staffId: l.staffId, monto: l.monto.toFixed(2), fecha: l.fechaLocal, concepto: l.concepto, motivo: l.descriptor.motivo },
    ]),
  )

describe('comisiones barribles (spec §6.2)', () => {
  it('lo del periodo y lo tardío de un periodo CERRADO entran; lo de un septiembre SIN fila espera; lo anterior al inicio, nunca (Review Focus 3, spec §13-16)', async () => {
    const com = (iso: string, status?: 'AGGREGATED' | 'VOIDED') => comision(m, { configId: cfg, staffId: m.sofia, iso, neto: 90, status })
    await com('2026-07-20T18:00:00Z') // antes del inicio (1-ago): se pagó por fuera
    const ago = await com('2026-08-28T18:00:00Z') // tardía de un agosto ya cerrado
    const sep = await com('2026-09-10T18:00:00Z') // septiembre: canónico SIN fila = abierto
    const oct = await com('2026-10-05T18:00:00Z')
    await com('2026-11-02T18:00:00Z') // después del periodo
    await com('2026-10-06T18:00:00Z', 'VOIDED')
    const agregada = await com('2026-10-07T18:00:00Z', 'AGGREGATED') // el estado del agregador ya no importa
    await ventana(m, '2026-08-01T06:00:00Z', null)
    const propSep = await cobro(m, { iso: '2026-09-10T18:00:00Z', propina: 40, servedById: m.carla })
    const propOct = await cobro(m, { iso: '2026-10-05T18:00:00Z', propina: 40, servedById: m.carla })
    await periodoCerrado(m, '2026-08-01', '2026-08-31')

    expect(ids(await todas(comisionesBarribles, alcance(OCT)))).toEqual([ago.id, oct.id, agregada.id].sort())
    expect(ids(await todas(propinasBarribles, alcance(OCT)))).toEqual([propOct.id])
    // Septiembre guardado pero todavía ABIERTO: espera igual que sin fila (sólo un CLOSED adelanta lo suyo).
    const sepGuardado = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-09-01'),
        periodEnd: fechaComoDbDate('2026-09-30'),
        status: 'OPEN',
        venueIds: [m.venueId],
      },
    })
    expect(ids(await todas(comisionesBarribles, alcance(OCT)))).toEqual([ago.id, oct.id, agregada.id].sort())
    expect(ids(await todas(propinasBarribles, alcance(OCT)))).toEqual([propOct.id])
    // Septiembre guardado como CERRADO: lo suyo ya cae en el cierre de octubre.
    await prisma.servicePayPeriod.update({
      where: { id: sepGuardado.id },
      data: { status: 'CLOSED', closedAt: new Date(), closedById: m.owner, closeFingerprint: 'manual' },
    })
    expect(ids(await todas(comisionesBarribles, alcance(OCT)))).toEqual([ago.id, sep.id, oct.id, agregada.id].sort())
    expect(ids(await todas(propinasBarribles, alcance(OCT)))).toEqual([propSep.id, propOct.id].sort())
    // Un periodo que termina antes del inicio de pago al personal no barre nada.
    expect(await todas(comisionesBarribles, alcance(JUL))).toEqual([])
  })

  it('un inicio a media quincena recorta el periodo y el cerrado que lo contienen: lo anterior al inicio nunca entra (spec §6.2-4)', async () => {
    const conInicio = (periodo: { start: string; end: string }) => ({ ...alcance(periodo), startDate: '2026-08-16' })
    const com = (iso: string) => comision(m, { configId: cfg, staffId: m.sofia, iso, neto: 90 })
    await com('2026-08-16T05:30:00Z') // 23:30 del 15-ago en CDMX: todavía no
    const desde = await com('2026-08-16T06:30:00Z') // 00:30 del 16-ago: ya cuenta
    expect(ids(await todas(comisionesBarribles, conInicio(AGO)))).toEqual([desde.id])
    // Agosto cerrado sin haberlo barrido: en septiembre entra lo de agosto, pero sólo desde el 16.
    await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const sep = await com('2026-09-05T18:00:00Z')
    expect(ids(await todas(comisionesBarribles, conInicio(SEP)))).toEqual([desde.id, sep.id].sort())
  })

  it('el descriptor guarda fecha y hora locales, sede, persona, orden, esquema, base y motivo', async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000 })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    const orden = (await prisma.order.findUniqueOrThrow({ where: { id: venta.orderId } })).orderNumber
    const [l] = await todas(comisionesBarribles, alcance(AGO))
    expect(l).toMatchObject({ fuente: 'COMMISSION', concepto: 'SERVICE', staffId: m.sofia, venueId: m.venueId, fechaLocal: '2026-08-10' })
    expect(l.instante).toEqual(new Date('2026-08-10T18:00:05Z'))
    expect(l.descriptor).toEqual({
      fecha: '2026-08-10',
      hora: '12:00',
      sede: `${m.key}-pn`,
      persona: 'Sofia QA',
      orden,
      esquema: 'Lagree + Merch 3 %',
      base: '3000.00',
      motivo: 'VENTA',
    })
  })

  it('el inicio de pago al personal se lee en la zona de CADA sede (Codex r1-19, spec §13-6)', async () => {
    const tij = await crearSede(m.orgId, m.key, 'tij')
    await prisma.venue.update({ where: { id: tij.venueId }, data: { timezone: 'America/Tijuana' } })
    const cfgTij = await esquema(m, tij.venueId)
    // 1-ago 06:30 UTC: 00:30 del 1-ago en CDMX (ya cuenta); 23:30 del 31-jul en Tijuana (todavía no).
    const cdmx = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-01T06:30:00Z', neto: 90 })
    await comision(m, { configId: cfgTij, staffId: m.sofia, iso: '2026-08-01T06:30:00Z', neto: 90, venueId: tij.venueId })
    const ls = await todas(
      comisionesBarribles,
      alcance(AGO, [
        { venueId: m.venueId, tz: TZ },
        { venueId: tij.venueId, tz: 'America/Tijuana' },
      ]),
    )
    expect(ids(ls)).toEqual([cdmx.id])
    expect(ls[0]).toMatchObject({ fechaLocal: '2026-08-01', venueId: m.venueId })
  })

  it('una comisión ya congelada no se vuelve a barrer, aunque la línea congelada sea de otra persona (anti-join por fuente)', async () => {
    const julio = await periodoCerrado(m, '2026-07-01', '2026-07-31')
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-05T18:00:00Z', neto: 90 })
    await congelar(m, julio.id, { fuente: 'COMMISSION', sourceId: c.id, staffId: m.ana, monto: 90 })
    expect(await todas(comisionesBarribles, alcance(AGO))).toEqual([])
  })

  it('un reverso de devolución entra sólo si su original está congelada o entra en este mismo cierre (Codex r1-18, spec §6.2-6)', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const com = (iso: string, neto: number, pago: { id: string; orderId: string }) =>
      comision(m, { configId: cfg, staffId: m.sofia, iso, neto, pago })
    // (a) original congelada en agosto, devuelta en octubre: el reverso entra.
    const v1 = await cobro(m, { iso: '2026-08-05T18:00:00Z', monto: 3000 })
    const c1 = await com('2026-08-05T18:00:05Z', 90, v1)
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: c1.id, staffId: m.sofia, monto: 90 })
    const rv1 = await com('2026-10-03T18:00:00Z', -36, await reembolso(m, v1, { iso: '2026-10-03T18:00:00Z', monto: 1200 }))
    // (b) original de octubre (entra en este cierre) y su devolución de octubre: entran las dos.
    const v2 = await cobro(m, { iso: '2026-10-02T18:00:00Z', monto: 3000 })
    const c2 = await com('2026-10-02T18:00:05Z', 90, v2)
    const rv2 = await com('2026-10-04T18:00:00Z', -90, await reembolso(m, v2, { iso: '2026-10-04T18:00:00Z', monto: 3000 }))
    // (c) original anterior al inicio (se pagó por fuera): ni ella ni su devolución.
    const v3 = await cobro(m, { iso: '2026-07-20T18:00:00Z', monto: 3000 })
    await com('2026-07-20T18:00:05Z', 90, v3)
    await com('2026-10-05T18:00:00Z', -90, await reembolso(m, v3, { iso: '2026-10-05T18:00:00Z', monto: 3000 }))
    // (d) original en un septiembre ABIERTO (sin fila): espera a septiembre, y su devolución también.
    const v4 = await cobro(m, { iso: '2026-09-10T18:00:00Z', monto: 3000 })
    await com('2026-09-10T18:00:05Z', 90, v4)
    await com('2026-10-06T18:00:00Z', -45, await reembolso(m, v4, { iso: '2026-10-06T18:00:00Z', monto: 1500 }))
    // (e) original de octubre ANULADA sin congelar y un reverso que quedó vivo: no se descuenta lo que el sobre no pagará.
    const v5 = await cobro(m, { iso: '2026-10-07T18:00:00Z', monto: 3000 })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-10-07T18:00:05Z', neto: 90, pago: v5, status: 'VOIDED' })
    await com('2026-10-08T18:00:00Z', -90, await reembolso(m, v5, { iso: '2026-10-08T18:00:00Z', monto: 3000 }))
    // (f) misma venta, otra persona u otro esquema: cada reverso se ampara sólo en SU original (persona + esquema).
    const cfg2 = await esquema(m, m.venueId, 'Otro esquema')
    const v6 = await cobro(m, { iso: '2026-10-09T18:00:00Z', monto: 3000 })
    const r6 = await reembolso(m, v6, { iso: '2026-10-10T18:00:00Z', monto: 3000 })
    const c6 = await com('2026-10-09T18:00:05Z', 90, v6)
    await comision(m, { configId: cfg, staffId: m.ana, iso: '2026-10-09T18:00:05Z', neto: 90, pago: v6, status: 'VOIDED' })
    await comision(m, { configId: cfg2, staffId: m.sofia, iso: '2026-10-09T18:00:05Z', neto: 90, pago: v6, status: 'VOIDED' })
    const rv6 = await com('2026-10-10T18:00:00Z', -90, r6)
    await comision(m, { configId: cfg, staffId: m.ana, iso: '2026-10-10T18:00:00Z', neto: -90, pago: r6 })
    await comision(m, { configId: cfg2, staffId: m.sofia, iso: '2026-10-10T18:00:00Z', neto: -90, pago: r6 })
    // (g) original CONGELADA en agosto y después anulada, con un reverso que quedó vivo: la anulación ya devuelve −90;
    // el reverso no descuenta otra vez.
    const v7 = await cobro(m, { iso: '2026-08-06T18:00:00Z', monto: 3000 })
    const c7 = await com('2026-08-06T18:00:05Z', 90, v7)
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: c7.id, staffId: m.sofia, monto: 90 })
    await prisma.commissionCalculation.update({
      where: { id: c7.id },
      data: { status: 'VOIDED', voidedAt: new Date('2026-10-11T18:00:00Z') },
    })
    await com('2026-10-12T18:00:00Z', -36, await reembolso(m, v7, { iso: '2026-10-12T18:00:00Z', monto: 1200 }))

    const ls = await todas(comisionesBarribles, alcance(OCT))
    expect(ids(ls)).toEqual([c2.id, rv1.id, rv2.id, c6.id, rv6.id].sort())
    expect(por(ls)[rv1.id]).toEqual({ staffId: m.sofia, monto: '-36.00', fecha: '2026-10-03', concepto: 'SERVICE', motivo: 'DEVOLUCION' })
    expect(por(ls)[c2.id]).toMatchObject({ monto: '90.00', motivo: 'VENTA' })
    expect(por(await todas(reversosPorAnulacion, alcance(OCT)))).toEqual({
      [c7.id]: { staffId: m.sofia, monto: '-90.00', fecha: '2026-10-11', concepto: 'RECONCILE', motivo: 'ANULACION' },
    })
  })

  it('un reverso entra si su original está CONGELADA aunque hoy su fecha ya no caiga en ningún rango (la sede corrigió su zona)', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const v = await cobro(m, { iso: '2026-08-01T06:30:00Z', monto: 3000 })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-01T06:30:00Z', neto: 90, pago: v }) // 00:30 del 1-ago en CDMX
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: c.id, staffId: m.sofia, monto: 90 })
    // La sede pasa a Tijuana: esa venta queda el 31-jul, antes del inicio, pero el sobre ya la pagó.
    await prisma.venue.update({ where: { id: m.venueId }, data: { timezone: 'America/Tijuana' } })
    const r = await reembolso(m, v, { iso: '2026-10-03T18:00:00Z', monto: 1200 })
    const rv = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-10-03T18:00:00Z', neto: -36, pago: r })
    expect(ids(await todas(comisionesBarribles, alcance(OCT, [{ venueId: m.venueId, tz: 'America/Tijuana' }])))).toEqual([rv.id])
  })
})

describe('propinas (spec §6.3)', () => {
  it('le tocan a quien atendió; si no hay, a quien cobró; sin ninguno no entran y se cuentan aparte', async () => {
    await ventana(m, '2026-08-01T06:00:00Z', null)
    const p1 = await cobro(m, { iso: '2026-08-10T18:00:00Z', propina: 50, servedById: m.carla, processedById: m.ana })
    const p2 = await cobro(m, { iso: '2026-08-11T18:00:00Z', propina: 30, processedById: m.ana })
    await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 20 }) // sin dueño
    await cobro(m, { iso: '2026-08-13T18:00:00Z', propina: 0, servedById: m.carla })
    await cobro(m, { iso: '2026-08-14T18:00:00Z', propina: 40, servedById: m.carla, type: 'TEST' })
    await cobro(m, { iso: '2026-08-15T18:00:00Z', propina: 40, servedById: m.carla, status: 'FAILED' })
    const p7 = await cobro(m, { iso: '2026-08-16T18:00:00Z', propina: 10, servedById: m.sofia, type: 'FAST' })
    expect(por(await todas(propinasBarribles, alcance(AGO)))).toEqual({
      [p1.id]: { staffId: m.carla, monto: '50.00', fecha: '2026-08-10', concepto: 'SERVICE', motivo: 'VENTA' },
      [p2.id]: { staffId: m.ana, monto: '30.00', fecha: '2026-08-11', concepto: 'SERVICE', motivo: 'VENTA' },
      [p7.id]: { staffId: m.sofia, monto: '10.00', fecha: '2026-08-16', concepto: 'SERVICE', motivo: 'VENTA' },
    })
    const sin = await propinasSinDueno(prisma, alcance(AGO))
    expect({ n: sin.n, total: sin.total.toFixed(2) }).toEqual({ n: 1, total: '20.00' })
  })

  it('prender, apagar y volver a prender a media quincena: entra lo de cada ventana [inicio, fin), nada de en medio (Review Focus 4, spec §13-6, §13-15)', async () => {
    await ventana(m, '2026-08-01T06:00:00Z', '2026-08-10T06:00:00Z')
    await ventana(m, '2026-08-20T06:00:00Z', null)
    const p = (iso: string) => cobro(m, { iso, propina: 10, servedById: m.carla })
    const dentro1 = await p('2026-08-05T18:00:00Z')
    await p('2026-08-10T06:00:00Z') // justo al apagar: ya no entra
    await p('2026-08-15T18:00:00Z') // apagado
    const alPrender = await p('2026-08-20T06:00:00Z') // justo al volver a prender: sí entra
    const dentro2 = await p('2026-08-25T18:00:00Z')
    // La ventana abierta de OTRA organización no cubre el hueco de ésta.
    const otra = await prisma.organization.create({
      data: { name: `${m.key}-otra`, slug: `${m.key}-otra`, email: `${m.key}-otra@example.test`, phone: '5500000000' },
    })
    try {
      await prisma.staffPayTipWindow.create({
        data: { organizationId: otra.id, startsAt: new Date('2026-08-01T06:00:00Z'), startedById: m.owner },
      })
      expect(ids(await todas(propinasBarribles, alcance(AGO)))).toEqual([dentro1.id, alPrender.id, dentro2.id].sort())
    } finally {
      await prisma.organization.delete({ where: { id: otra.id } })
    }
  })

  it('el reembolso de una propina congelada se descuenta aunque el interruptor esté apagado y a la MISMA persona; el de una entregada aparte, no (Codex r1-5, r1-18, spec §13-15)', async () => {
    await ventana(m, '2026-08-01T06:00:00Z', '2026-08-31T06:00:00Z') // hoy está apagado
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    // (a) congelada a Carla en agosto; hoy la orden la «atiende» Sofía.
    const p1 = await cobro(m, { iso: '2026-08-10T18:00:00Z', propina: 50, servedById: m.carla })
    await congelar(m, agosto.id, { fuente: 'TIP', sourceId: p1.id, staffId: m.carla, monto: 50 })
    await prisma.order.update({ where: { id: p1.orderId }, data: { servedById: m.sofia } })
    const r1 = await reembolso(m, p1, { iso: '2026-09-03T18:00:00Z', propina: 50 })
    // (b) entregada aparte (sin ventana) y devuelta: no entra ninguna.
    const p2 = await cobro(m, { iso: '2026-09-02T18:00:00Z', propina: 30, servedById: m.ana })
    await reembolso(m, p2, { iso: '2026-09-04T18:00:00Z', propina: 30 })
    // (c) tardía de agosto (cerrado, dentro de su ventana) que entra en este cierre, y su devolución: las dos, a Ana.
    const p3 = await cobro(m, { iso: '2026-08-20T18:00:00Z', propina: 40, servedById: m.ana })
    const r3 = await reembolso(m, p3, { iso: '2026-09-05T18:00:00Z', propina: 40 })
    // (d) congelada y su reembolso YA congelado en agosto: ninguno se vuelve a barrer.
    const p4 = await cobro(m, { iso: '2026-08-21T18:00:00Z', propina: 20, servedById: m.ana })
    await congelar(m, agosto.id, { fuente: 'TIP', sourceId: p4.id, staffId: m.ana, monto: 20 })
    const r4 = await reembolso(m, p4, { iso: '2026-09-06T18:00:00Z', propina: 20 })
    await congelar(m, agosto.id, { fuente: 'TIP', sourceId: r4.id, staffId: m.ana, monto: -20 })
    // (e) congelada y devuelta en octubre, después de este periodo: espera al cierre de octubre.
    const p5 = await cobro(m, { iso: '2026-08-22T18:00:00Z', propina: 15, servedById: m.ana })
    await congelar(m, agosto.id, { fuente: 'TIP', sourceId: p5.id, staffId: m.ana, monto: 15 })
    await reembolso(m, p5, { iso: '2026-10-02T18:00:00Z', propina: 15 })
    // (f) propina de julio, con su ventana pero ANTES del inicio (se pagó por fuera), devuelta en septiembre: no se descuenta.
    await ventana(m, '2026-07-01T06:00:00Z', '2026-07-31T06:00:00Z')
    const p6 = await cobro(m, { iso: '2026-07-20T18:00:00Z', propina: 25, servedById: m.ana })
    await reembolso(m, p6, { iso: '2026-09-07T18:00:00Z', propina: 25 })
    expect(por(await todas(propinasBarribles, alcance(SEP)))).toEqual({
      [r1.id]: { staffId: m.carla, monto: '-50.00', fecha: '2026-09-03', concepto: 'SERVICE', motivo: 'DEVOLUCION' },
      [p3.id]: { staffId: m.ana, monto: '40.00', fecha: '2026-08-20', concepto: 'SERVICE', motivo: 'VENTA' },
      [r3.id]: { staffId: m.ana, monto: '-40.00', fecha: '2026-09-05', concepto: 'SERVICE', motivo: 'DEVOLUCION' },
    })
  })
})

describe('reversos por anulación (spec §6.4)', () => {
  it('una comisión congelada que hoy está anulada da UNA vez −(su monto congelado), con la fecha de la anulación', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const anular = (id: string) =>
      prisma.commissionCalculation.update({
        where: { id },
        data: { status: 'VOIDED', voidedAt: new Date('2026-09-03T18:00:00Z'), voidedBy: m.owner, voidReason: 'QA' },
      })
    const com = () => comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-05T18:00:00Z', neto: 90 })
    const fija = (id: string, concepto: 'SERVICE' | 'RECONCILE' = 'SERVICE', monto = 90) =>
      congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: id, staffId: m.sofia, monto, concepto })
    const c1 = await com() // congelada y anulada: entra
    await fija(c1.id)
    await anular(c1.id)
    const c2 = await com() // congelada, no anulada: no
    await fija(c2.id)
    const c3 = await com() // anulada sin congelar: simplemente ya no se barre
    await anular(c3.id)
    const c4 = await com() // congelada, anulada y YA reconciliada: no
    await fija(c4.id)
    await anular(c4.id)
    await fija(c4.id, 'RECONCILE', -90)
    expect(por(await todas(reversosPorAnulacion, alcance(SEP)))).toEqual({
      [c1.id]: { staffId: m.sofia, monto: '-90.00', fecha: '2026-09-03', concepto: 'RECONCILE', motivo: 'ANULACION' },
    })
    // Un periodo que termina antes del inicio de pago al personal tampoco barre anulaciones (B-D5).
    expect(await todas(reversosPorAnulacion, alcance(JUL))).toEqual([])
  })

  it('el ejemplo del spec §6.4: $100 congelada, devolución −$40 congelada y después anulación ⇒ −$100 y +$40, neto $0', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const v = await cobro(m, { iso: '2026-08-05T18:00:00Z', monto: 3000 })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-05T18:00:05Z', neto: 100, pago: v })
    const rv = await comision(m, {
      configId: cfg,
      staffId: m.sofia,
      iso: '2026-08-20T18:00:00Z',
      neto: -40,
      pago: await reembolso(m, v, { iso: '2026-08-20T18:00:00Z', monto: 1200 }),
    })
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: c.id, staffId: m.sofia, monto: 100 })
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: rv.id, staffId: m.sofia, monto: -40 })
    // La anulación (anularComision, Bloque A) anula la comisión Y su reverso materializado.
    await prisma.commissionCalculation.updateMany({
      where: { id: { in: [c.id, rv.id] } },
      data: { status: 'VOIDED', voidedAt: new Date('2026-09-03T18:00:00Z'), voidedBy: m.owner, voidReason: 'QA' },
    })
    expect(await todas(comisionesBarribles, alcance(SEP))).toEqual([])
    const ls = await todas(reversosPorAnulacion, alcance(SEP))
    expect(por(ls)).toEqual({
      [c.id]: { staffId: m.sofia, monto: '-100.00', fecha: '2026-09-03', concepto: 'RECONCILE', motivo: 'ANULACION' },
      [rv.id]: { staffId: m.sofia, monto: '40.00', fecha: '2026-09-03', concepto: 'RECONCILE', motivo: 'ANULACION' },
    })
    // Neto de Sofía: lo congelado en agosto (+100 − 40) más lo que barre este cierre (−100 + 40) = $0.
    const congelado = await prisma.serviceEarning.aggregate({ where: { periodId: agosto.id, staffId: m.sofia }, _sum: { amount: true } })
    expect(ls.reduce((s, l) => s.plus(l.monto), new Prisma.Decimal(congelado._sum.amount ?? 0)).toFixed(2)).toBe('0.00')
  })
})

describe('la vista en vivo (B5) y las consultas del EXPLAIN (B7)', () => {
  it('sqlVentasDelPeriodo trae lo mismo que los tres recorridos, con las columnas del contrato; por persona, sólo lo suyo', async () => {
    const agosto = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await ventana(m, '2026-08-01T06:00:00Z', null)
    const c1 = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-05T18:00:00Z', neto: 90 })
    await congelar(m, agosto.id, { fuente: 'COMMISSION', sourceId: c1.id, staffId: m.sofia, monto: 90 })
    await prisma.commissionCalculation.update({
      where: { id: c1.id },
      data: { status: 'VOIDED', voidedAt: new Date('2026-09-03T18:00:00Z') },
    })
    const c2 = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-09-05T18:00:00Z', neto: 45 })
    const p1 = await cobro(m, { iso: '2026-09-06T18:00:00Z', propina: 30, servedById: m.carla })
    const p2 = await cobro(m, { iso: '2026-09-07T18:00:00Z', propina: 20, processedById: m.ana })
    await cobro(m, { iso: '2026-09-08T18:00:00Z', propina: 10 }) // sin dueño: no es renglón de nadie

    const clave = (l: { concepto: string; sourceId: string; staffId: string; monto: Prisma.Decimal }) =>
      `${l.concepto}|${l.sourceId}|${l.staffId}|${l.monto.toFixed(2)}`
    const recorridos = [
      ...(await todas(comisionesBarribles, alcance(SEP))),
      ...(await todas(propinasBarribles, alcance(SEP))),
      ...(await todas(reversosPorAnulacion, alcance(SEP))),
    ]
    const sql = await sqlVentasDelPeriodo(prisma, alcance(SEP))
    const filas = await prisma.$queryRaw<Array<Record<string, any>>>(sql!)
    expect(filas.map(f => clave(f as Parameters<typeof clave>[0])).sort()).toEqual(recorridos.map(clave).sort())
    expect(recorridos.map(clave).sort()).toEqual(
      [
        `RECONCILE|${c1.id}|${m.sofia}|-90.00`,
        `SERVICE|${c2.id}|${m.sofia}|45.00`,
        `SERVICE|${p1.id}|${m.carla}|30.00`,
        `SERVICE|${p2.id}|${m.ana}|20.00`,
      ].sort(),
    )
    expect(Object.keys(filas[0])).toEqual([
      'fuente',
      'concepto',
      'sourceId',
      'staffId',
      'venueId',
      'instante',
      'fechaLocal',
      'hora',
      'monto',
      'sede',
      'persona',
      'orden',
      'esquema',
      'base',
      'motivo',
    ])
    const deCarla = await prisma.$queryRaw<Array<{ sourceId: string }>>(
      (await sqlVentasDelPeriodo(prisma, alcance(SEP), { staffId: m.carla }))!,
    )
    expect(deCarla.map(f => f.sourceId)).toEqual([p1.id])
    expect(await sqlVentasDelPeriodo(prisma, alcance(JUL))).toBeNull()

    const q = await consultasDeVentas(prisma, alcance(SEP))
    expect((await prisma.$queryRaw<Array<{ id: string }>>(q.comisiones)).map(x => x.id)).toEqual([c2.id])
    expect((await prisma.$queryRaw<Array<{ id: string }>>(q.propinas)).map(x => x.id).sort()).toEqual([p1.id, p2.id].sort())
    expect((await prisma.$queryRaw<Array<{ sourceId: string }>>(q.reversos)).map(x => x.sourceId)).toEqual([c1.id])
  })
})

describe('recorrido por lotes (spec §6.5)', () => {
  it('lotes de 2 ordenados por id juntan exactamente lo mismo que un lote de 1,000', async () => {
    for (let i = 1; i <= 5; i++) await comision(m, { configId: cfg, staffId: m.sofia, iso: `2026-08-0${i}T18:00:00Z`, neto: i })
    const una = await todas(comisionesBarribles, alcance(AGO))
    const lotes: LineaBarrible[] = []
    let despuesDe: string | undefined
    for (;;) {
      const l = await comisionesBarribles(prisma, alcance(AGO), { despuesDe, limite: 2 })
      if (!l.length) break
      lotes.push(...l)
      despuesDe = l[l.length - 1].sourceId
    }
    expect(una).toHaveLength(5)
    expect(lotes.map(l => l.sourceId)).toEqual(una.map(l => l.sourceId))
  })
})
