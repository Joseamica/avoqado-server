// tests/integration/staffPay/cierre.ventas.test.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { anularComision } from '@/services/dashboard/commission/commission-calculation.service'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import {
  barreraDeLaOrganizacion,
  barreraDelPeriodo,
  borrarMundo,
  clase,
  confirmadas,
  crearMundo,
  crearSede,
  Mundo,
  periodoCerrado,
  tablaMindform,
} from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

// Cada mes ya terminó en CDMX en estos «ahora».
const SEP2 = new Date('2026-09-02T12:00:00Z')
const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
let m: Mundo
let cfg: string

beforeEach(async () => {
  m = await crearMundo('ventas')
  ;(global as any).__sedes = [m.venueId]
  await tablaMindform(m)
  await activar(m) // inicio 1-ago; propinas en el recibo desde el 1-ago 00:00 de CDMX
  cfg = await esquema(m)
})
afterEach(() => borrarMundo(m))

const preview = (fecha: string, ahora: Date) => previewCierre({ userId: m.owner, venueId: m.venueId, fecha, ahora })
const cerrar = async (fecha: string, ahora: Date, huella?: string) =>
  cerrarPeriodo({
    userId: m.owner,
    venueId: m.venueId,
    fecha,
    ahora,
    confirmarHuerfanas: true,
    huellaEsperada: huella ?? (await preview(fecha, ahora)).huella,
  })
const totalDe = async (periodId: string, staffId: string) =>
  (await prisma.staffPayStatement.findUniqueOrThrow({ where: { periodId_staffId: { periodId, staffId } } })).total.toFixed(2)
const lineas = (where: Prisma.ServiceEarningWhereInput) => prisma.serviceEarning.count({ where: { organizationId: m.orgId, ...where } })

describe('el cierre con ventas (spec fase 3 §6)', () => {
  it('congela clases, comisiones y propinas en una transacción; los totales cuadran y quien sólo vende tiene recibo (spec §13-1, §13-8)', async () => {
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000, propina: 50, servedById: m.carla })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    const p = await preview('2026-08-15', SEP2)
    expect(p).toMatchObject({
      puedeCerrar: true,
      clases: 1,
      comisiones: 1,
      propinas: 1,
      reversos: 0,
      personas: 3,
      totalServicios: '570.00',
      totalVentas: '140.00',
      totalAjustes: '0.00',
      total: '710.00',
      propinasSinDueno: { n: 0, total: '0.00' },
    })
    const r = await cerrar('2026-08-15', SEP2, p.huella)
    expect(r).toMatchObject({ total: '710.00', personas: 3, yaCerrado: false, huella: p.huella })
    expect(await totalDe(r.periodId, m.ana)).toBe('570.00')
    expect(await totalDe(r.periodId, m.sofia)).toBe('90.00')
    expect(await totalDe(r.periodId, m.carla)).toBe('50.00')
    const com = await prisma.serviceEarning.findFirstOrThrow({
      where: { organizationId: m.orgId, sourceType: 'COMMISSION', sourceId: c.id },
    })
    expect(com).toMatchObject({ concept: 'SERVICE', staffId: m.sofia, periodId: r.periodId, occurredAt: new Date('2026-08-10T18:00:05Z') })
    expect(com.amount.toFixed(2)).toBe('90.00')
    expect(com.descriptor).toMatchObject({
      fecha: '2026-08-10',
      hora: '12:00',
      esquema: 'Lagree + Merch 3 %',
      base: '3000.00',
      motivo: 'VENTA',
      persona: 'Sofia QA',
    })
    const tip = await prisma.serviceEarning.findFirstOrThrow({ where: { organizationId: m.orgId, sourceType: 'TIP', sourceId: venta.id } })
    expect(tip).toMatchObject({ concept: 'SERVICE', staffId: m.carla, periodId: r.periodId, occurredAt: new Date('2026-08-10T18:00:00Z') })
    expect(tip.amount.toFixed(2)).toBe('50.00')
    const log = await prisma.activityLog.findFirstOrThrow({ where: { action: 'SERVICE_PAY_PERIOD_CLOSED', entityId: r.periodId } })
    expect(log.data).toMatchObject({
      comisiones: 1,
      propinas: 1,
      reversos: 0,
      totalVentas: '140.00',
      propinasSinDueno: { n: 0, total: '0.00' },
    })
    // El preview de un periodo CERRADO separa por tipo lo guardado.
    expect(await preview('2026-08-15', SEP2)).toMatchObject({
      bloqueos: [{ codigo: 'YA_CERRADO' }],
      clases: 1,
      comisiones: 1,
      propinas: 1,
      reversos: 0,
      totalServicios: '570.00',
      totalVentas: '140.00',
      totalAjustes: '0.00',
      total: '710.00',
    })
  })

  it('servicios, ventas y ajustes se suman sin cruzarse, abierto y cerrado (total = servicios + ventas + ajustes)', async () => {
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90 })
    await agregarAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: m.carla,
      amount: 100,
      reason: 'Bono',
      fecha: '2026-08-20',
      clientKey: `${m.key}-bono`,
      ahora: SEP2,
    })
    const reparto = { totalServicios: '570.00', totalVentas: '90.00', totalAjustes: '100.00', total: '760.00', personas: 3 }
    const p = await preview('2026-08-15', SEP2)
    expect(p).toMatchObject(reparto)
    await cerrar('2026-08-15', SEP2, p.huella)
    expect(await preview('2026-08-15', SEP2)).toMatchObject({ ...reparto, bloqueos: [{ codigo: 'YA_CERRADO' }] })
  })

  it('dos cierres del MISMO periodo esperando juntos: cada comisión y cada propina se congelan una sola vez (Review Focus 1, spec §13-2)', async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', propina: 50, servedById: m.carla })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    const agosto = await prisma.servicePayPeriod.create({
      data: {
        organizationId: m.orgId,
        periodStart: fechaComoDbDate('2026-08-01'),
        periodEnd: fechaComoDbDate('2026-08-31'),
        venueIds: [m.venueId],
      },
    })
    const p = await preview('2026-08-15', SEP2)
    const barrera = await barreraDelPeriodo(agosto.id)
    const dos = Promise.allSettled([cerrar('2026-08-15', SEP2, p.huella), cerrar('2026-08-15', SEP2, p.huella)])
    try {
      await barrera.esperarA(2)
    } finally {
      await barrera.soltar()
    }
    const [a, b] = (await dos).map(x => {
      if (x.status !== 'fulfilled') throw x.reason
      return x.value
    })
    expect([a.yaCerrado, b.yaCerrado].sort()).toEqual([false, true])
    expect(a.total).toBe('140.00')
    expect(await lineas({ sourceType: 'COMMISSION' })).toBe(1)
    expect(await lineas({ sourceType: 'TIP' })).toBe(1)
  })

  // «ya guardados»: los dos periodos existen ANTES, así que `asegurarPeriodo` no toma el candado de la organización y la
  // barrera sólo detiene a los dos cierres si el propio cierre lo toma primero (B-D3).
  it.each([
    ['sin guardar', false],
    ['ya guardados', true],
  ])(
    'dos cierres de periodos DISTINTOS (%s) que ven la misma venta tardía: la congela uno; el otro pide revisar (Review Focus 1, B-D3)',
    async (_, guardados) => {
      await periodoCerrado(m, '2026-08-01', '2026-08-31')
      if (guardados) {
        for (const [start, end] of [
          ['2026-09-01', '2026-09-30'],
          ['2026-10-01', '2026-10-31'],
        ])
          await prisma.servicePayPeriod.create({
            data: { organizationId: m.orgId, periodStart: fechaComoDbDate(start), periodEnd: fechaComoDbDate(end), venueIds: [m.venueId] },
          })
      }
      const tardia = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-28T18:00:00Z', neto: 90 })
      const ps = await preview('2026-09-15', NOV2)
      const po = await preview('2026-10-15', NOV2)
      expect([ps.comisiones, po.comisiones]).toEqual([1, 1])
      expect(ps.sedesConDinero).toEqual([m.venueId]) // sólo por la venta: no hay clases ni ajustes
      const barrera = await barreraDeLaOrganizacion(m.orgId)
      const dos = Promise.allSettled([cerrar('2026-09-15', NOV2, ps.huella), cerrar('2026-10-15', NOV2, po.huella)])
      try {
        await barrera.esperarA(2)
      } finally {
        await barrera.soltar()
      }
      const res = await dos
      expect(res.filter(x => x.status === 'fulfilled')).toHaveLength(1)
      expect(res.find(x => x.status === 'rejected')).toMatchObject({ reason: { code: 'HUELLA_CAMBIO' } })
      expect(await lineas({ sourceType: 'COMMISSION', sourceId: tardia.id })).toBe(1)
    },
  )

  it('una comisión que se materializa DESPUÉS del cierre con fecha del periodo cerrado entra en el siguiente, con su fecha (spec §13-3)', async () => {
    const ago = await cerrar('2026-08-15', SEP2)
    const tardia = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-28T18:00:00Z', neto: 90 })
    const sep = await cerrar('2026-09-15', OCT2)
    expect(await lineas({ periodId: ago.periodId, sourceType: 'COMMISSION' })).toBe(0)
    const l = await prisma.serviceEarning.findFirstOrThrow({ where: { sourceType: 'COMMISSION', sourceId: tardia.id } })
    expect(l).toMatchObject({ periodId: sep.periodId, concept: 'SERVICE', staffId: m.sofia, occurredAt: new Date('2026-08-28T18:00:00Z') })
    expect(l.amount.toFixed(2)).toBe('90.00')
    // La foto lleva la fecha REAL de la venta (cómo se muestra en el recibo lo prueba B5).
    expect(l.descriptor).toMatchObject({ fecha: '2026-08-28', hora: '12:00', motivo: 'VENTA' })
    expect(await totalDe(sep.periodId, m.sofia)).toBe('90.00')
  })

  it('una devolución después del cierre: su reverso negativo entra en el siguiente; el recibo cerrado no cambia (spec §13-4)', async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000 })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    const ago = await cerrar('2026-08-15', SEP2)
    const dev = await reembolso(m, venta, { iso: '2026-09-03T18:00:00Z', monto: 1200 })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-09-03T18:00:00Z', neto: -36, pago: dev })
    const sep = await cerrar('2026-09-15', OCT2)
    expect(await totalDe(ago.periodId, m.sofia)).toBe('90.00')
    expect(await totalDe(sep.periodId, m.sofia)).toBe('-36.00')
  })

  it('anular una comisión congelada: UN solo RECONCILE negativo en el siguiente cierre, aunque se cierre dos veces (spec §13-5)', async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000 })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    await cerrar('2026-08-15', SEP2)
    await anularComision({ calculationId: c.id, venueId: m.venueId, actorId: m.owner, motivo: 'Venta capturada por error' })
    const sep = await cerrar('2026-09-15', OCT2)
    expect(await cerrar('2026-09-15', OCT2)).toMatchObject({ yaCerrado: true, periodId: sep.periodId })
    await cerrar('2026-10-15', NOV2)
    const x = await prisma.serviceEarning.findMany({
      where: { organizationId: m.orgId, concept: 'RECONCILE', sourceType: 'COMMISSION' },
      take: 10,
    })
    expect(x).toHaveLength(1)
    expect(x[0]).toMatchObject({ periodId: sep.periodId, staffId: m.sofia, sourceId: c.id })
    expect(x[0].amount.toFixed(2)).toBe('-90.00')
    expect(x[0].descriptor).toMatchObject({ motivo: 'ANULACION' })
    expect(await totalDe(sep.periodId, m.sofia)).toBe('-90.00')
    // Cerrado, el reverso cuenta como venta (no como ajuste), y como reverso.
    expect(await preview('2026-09-15', OCT2)).toMatchObject({
      comisiones: 0,
      reversos: 1,
      totalVentas: '-90.00',
      totalAjustes: '0.00',
      total: '-90.00',
    })
  })

  it('un recibo sólo con devoluciones queda en negativo; la propina devuelta se descuenta a quien la cobró aunque el interruptor esté apagado (spec §13-7, Review Focus 4)', async () => {
    const venta = await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 50, servedById: m.carla })
    const ago = await cerrar('2026-08-15', SEP2)
    expect(await totalDe(ago.periodId, m.carla)).toBe('50.00')
    await prisma.staffPayTipWindow.updateMany({
      where: { organizationId: m.orgId, endsAt: null },
      data: { endsAt: new Date('2026-09-01T12:00:00Z'), endedById: m.owner },
    })
    await prisma.order.update({ where: { id: venta.orderId }, data: { servedById: m.sofia } }) // hoy la «atiende» otra
    await reembolso(m, venta, { iso: '2026-09-03T18:00:00Z', propina: 50 })
    const sep = await cerrar('2026-09-15', OCT2)
    expect(await totalDe(sep.periodId, m.carla)).toBe('-50.00')
    expect(await prisma.staffPayStatement.count({ where: { periodId: sep.periodId, staffId: m.sofia } })).toBe(0)
  })

  it('las propinas sin persona no entran: el preview las cuenta y el cierre NO se bloquea (spec §6.3)', async () => {
    await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 30 })
    const p = await preview('2026-08-15', SEP2)
    expect(p).toMatchObject({ puedeCerrar: true, propinas: 0, propinasSinDueno: { n: 1, total: '30.00' } })
    expect((await cerrar('2026-08-15', SEP2, p.huella)).total).toBe('0.00')
    expect(await lineas({ sourceType: 'TIP' })).toBe(0)
  })

  it('una comisión que aparece entre la vista previa y la confirmación cambia la huella: «revisa de nuevo» sin escribir nada (spec §6.5)', async () => {
    const p = await preview('2026-08-15', SEP2)
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-20T18:00:00Z', neto: 90 })
    await expect(cerrar('2026-08-15', SEP2, p.huella)).rejects.toMatchObject({ code: 'HUELLA_CAMBIO' })
    expect(await lineas({})).toBe(0)
  })

  it('una propina o una anulación que aparece entre la vista previa y la confirmación también cambia la huella (spec §6.5)', async () => {
    const p = await preview('2026-08-15', SEP2)
    await cobro(m, { iso: '2026-08-20T18:00:00Z', propina: 20, servedById: m.carla })
    await expect(cerrar('2026-08-15', SEP2, p.huella)).rejects.toMatchObject({ code: 'HUELLA_CAMBIO' })
    expect(await lineas({})).toBe(0)
    // La anulación de una comisión ya congelada, entre la vista previa de septiembre y su cierre.
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-21T18:00:00Z', neto: 90 })
    await cerrar('2026-08-15', SEP2)
    const ps = await preview('2026-09-15', OCT2)
    await anularComision({ calculationId: c.id, venueId: m.venueId, actorId: m.owner, motivo: 'Error' })
    await expect(cerrar('2026-09-15', OCT2, ps.huella)).rejects.toMatchObject({ code: 'HUELLA_CAMBIO' })
    expect(await lineas({ concept: 'RECONCILE' })).toBe(0)
  })

  it('las devoluciones con comisión por revisar se cuentan en el preview y no bloquean el cierre (resolución 16)', async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000 })
    const dev = await reembolso(m, venta, { iso: '2026-08-12T18:00:00Z', monto: 1200 })
    const efecto = (paymentId: string, venueId: string, dedupeKey: string, status: string, payload: Prisma.InputJsonObject) =>
      prisma.paymentEffect.create({ data: { venueId, paymentId, orderId: venta.orderId, kind: 'COMMISSION', dedupeKey, payload, status } })
    const revisar = { policyError: 'COMMISSION_SNAPSHOT_REQUIRES_REVIEW', originalPaymentId: venta.id }
    await efecto(dev.id, m.venueId, `commission:${dev.id}:policy-error:v1`, 'DEAD_LETTER', revisar) // cuenta
    await efecto(venta.id, m.venueId, `commission:${venta.id}:policy-error:v1`, 'DONE', revisar) // ya resuelto: no
    await efecto(dev.id, m.venueId, `commission:${dev.id}:${cfg}:${m.sofia}:v1`, 'PENDING', { configId: cfg }) // reverso normal: no
    // Otra sede de la organización, fuera del alcance del periodo: no.
    const otra = await crearSede(m.orgId, m.key, 'bsf')
    const ajena = await cobro(m, { iso: '2026-08-10T18:00:00Z', venueId: otra.venueId })
    await prisma.paymentEffect.create({
      data: {
        venueId: otra.venueId,
        paymentId: ajena.id,
        orderId: ajena.orderId,
        kind: 'COMMISSION',
        dedupeKey: `commission:${ajena.id}:policy-error:v1`,
        payload: revisar,
        status: 'PENDING',
      },
    })
    const p = await preview('2026-08-15', SEP2)
    expect(p).toMatchObject({ puedeCerrar: true, comisionesPorRevisar: 1 })
    await cerrar('2026-08-15', SEP2, p.huella)
  })

  it('sin activar pago al personal el cierre no barre ventas (B-D5)', async () => {
    await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: null } })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-20T18:00:00Z', neto: 90 })
    expect(await preview('2026-08-15', SEP2)).toMatchObject({ comisiones: 0, propinas: 0, reversos: 0, totalVentas: '0.00' })
    await cerrar('2026-08-15', SEP2)
    expect(await lineas({ sourceType: 'COMMISSION' })).toBe(0)
  })
})
