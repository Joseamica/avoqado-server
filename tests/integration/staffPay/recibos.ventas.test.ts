// tests/integration/staffPay/recibos.ventas.test.ts
import * as XLSX from 'xlsx'
import PDFDocument from 'pdfkit'
import prisma from '@/utils/prismaClient'
import {
  COLUMNAS_FUENTE_RECIBO,
  consultaDePaginaDelRecibo,
  exportarRecibo,
  reciboDePersona,
} from '@/services/dashboard/staffPay/recibos.service'
import { reportePeriodo } from '@/services/dashboard/staffPay/reporte.service'
import { cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import { anularComision } from '@/services/dashboard/commission/commission-calculation.service'
import { hardDeleteTeamMember } from '@/services/dashboard/team.dashboard.service'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, tablaMindform } from './_mundo'
import { activar, cobro, comision, esquema, reembolso } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
}))

const SEP2 = new Date('2026-09-02T12:00:00Z')
const OCT2 = new Date('2026-10-02T12:00:00Z')
const NOV2 = new Date('2026-11-02T12:00:00Z')
let m: Mundo
let cfg: string
beforeEach(async () => {
  m = await crearMundo('recibo-ventas')
  ;(global as any).__sedes = [m.venueId]
  await tablaMindform(m)
  await activar(m)
  cfg = await esquema(m)
})
afterEach(() => borrarMundo(m))

const cerrar = async (fecha = '2026-08-15', ahora = SEP2) => {
  const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha, ahora })
  return cerrarPeriodo({ userId: m.owner, venueId: m.venueId, fecha, ahora, confirmarHuerfanas: true, huellaEsperada: p.huella })
}
const recibo = (staffId: string, fecha = '2026-08-15') =>
  reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId, fecha, limit: 100 })
const filas = (r: Awaited<ReturnType<typeof recibo>>) => r.renglones.map(x => [x.tipo, x.fecha, x.hora, x.concepto, x.monto])
const numero = async (p: { orderId: string }) => (await prisma.order.findUniqueOrThrow({ where: { id: p.orderId } })).orderNumber
/** Lo que la persona ha recibido en TODOS sus recibos de esta organización. */
const acumulado = async (staffId: string) =>
  (
    (await prisma.staffPayStatement.aggregate({ where: { staffId, period: { organizationId: m.orgId } }, _sum: { total: true } }))._sum
      .total ?? 0
  ).toFixed(2)

/** El texto que dibuja el PDF (mismo espía que `recibos.filas.test.ts`): para comparar lo que dice contra la pantalla. */
async function textoDelPdf(staffId: string): Promise<string[]> {
  const proto = PDFDocument.prototype as unknown as { _fragment: (texto: string, ...resto: unknown[]) => unknown }
  const fragment = jest.spyOn(proto, '_fragment')
  try {
    const pdf = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId, fecha: '2026-08-15', format: 'pdf' })
    expect(pdf.encoded.buffer.subarray(0, 4).toString()).toBe('%PDF')
    return fragment.mock.calls.map(args => String(args[0]))
  } finally {
    fragment.mockRestore()
  }
}

/** Carla: dos propinas el 12, una el 14 que se devuelve el 20, y la comisión de la venta del 12. */
async function ventasDeCarla() {
  const v1 = await cobro(m, { iso: '2026-08-12T18:00:00Z', monto: 3000, propina: 50, servedById: m.carla })
  const v2 = await cobro(m, { iso: '2026-08-12T20:00:00Z', propina: 30, servedById: m.carla })
  const v3 = await cobro(m, { iso: '2026-08-14T18:00:00Z', propina: 20, servedById: m.carla })
  await reembolso(m, v3, { iso: '2026-08-20T18:00:00Z', propina: 20 })
  await comision(m, { configId: cfg, staffId: m.carla, iso: '2026-08-12T18:00:05Z', neto: 90, base: 3000, pago: v1 })
  return { n1: await numero(v1), n2: await numero(v2), n3: await numero(v3) }
}

describe('el recibo con comisiones y propinas (spec fase 3 §11)', () => {
  const pantalla = (n1: string) => [
    ['PROPINA', '2026-08-12', null, 'Propinas del 12 ago 2026 · 2 cobros', '80.00'],
    ['COMISION', '2026-08-12', '12:00', `Comisión Lagree + Merch 3 % · venta #${n1} · base $3,000.00`, '90.00'],
    ['PROPINA', '2026-08-14', null, 'Propinas del 14 ago 2026 · 1 cobro', '20.00'],
    ['PROPINA', '2026-08-20', null, 'Propinas devueltas del 20 ago 2026 · 1 devolución', '-20.00'],
  ]

  it('abierto (en vivo) y cerrado se leen igual: una comisión por venta y las propinas agrupadas por día; totales por tipo', async () => {
    const { n1 } = await ventasDeCarla()
    const abierto = await recibo(m.carla)
    expect(abierto.periodo.estado).toBe('OPEN')
    expect(filas(abierto)).toEqual(pantalla(n1))
    expect(abierto).toMatchObject({ total: '170.00', cantidad: 4, totalesPorTipo: { PROPINA: '80.00', COMISION: '90.00' } })
    await cerrar()
    const cerrado = await recibo(m.carla)
    expect(cerrado.periodo.estado).toBe('CLOSED')
    expect(filas(cerrado)).toEqual(pantalla(n1))
    expect(cerrado).toMatchObject({ total: '170.00', cantidad: 4, totalesPorTipo: { PROPINA: '80.00', COMISION: '90.00' } })
    // Lo que se ve es lo que se congeló y lo que dice el recibo guardado, al centavo.
    const congelado = await prisma.serviceEarning.aggregate({
      where: { organizationId: m.orgId, staffId: m.carla },
      _sum: { amount: true },
    })
    expect(congelado._sum.amount?.toFixed(2)).toBe('170.00')
    expect(await acumulado(m.carla)).toBe('170.00')
  })

  it('el Excel trae cada cobro por separado (con su venta) y cuadra con el mismo total; el PDF dice lo de la pantalla', async () => {
    const { n1, n2, n3 } = await ventasDeCarla()
    await cerrar()
    const xlsx = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.carla, fecha: '2026-08-15', format: 'xlsx' })
    const libro = XLSX.read(xlsx.encoded.buffer)
    const hoja = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets[libro.SheetNames[0]], { raw: true })
    expect(hoja.map(f => [f.Concepto, f.Monto])).toEqual([
      [`Propina · venta #${n1}`, 50],
      [`Comisión Lagree + Merch 3 % · venta #${n1} · base $3,000.00`, 90],
      [`Propina · venta #${n2}`, 30],
      [`Propina · venta #${n3}`, 20],
      [`Devolución de propina · venta #${n3}`, -20],
      ['Total', 170],
    ])
    const texto = await textoDelPdf(m.carla)
    for (const t of ['Propinas del 12 ago 2026 · 2 cobros', 'Propinas devueltas del 20 ago 2026 · 1 devolución', '$80.00', '-$20.00']) {
      expect(texto).toContain(t)
    }
    // El total del PDF es el de la pantalla y el del Excel.
    expect(texto).toContain('Total')
    expect(texto.slice(texto.indexOf('Total'))).toContain('$170.00')
  })

  it('una comisión que llegó tarde a un periodo cerrado se lee en el recibo siguiente con la fecha de la venta (spec §13-3)', async () => {
    await cerrar()
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-28T18:00:00Z', neto: 90 })
    await cerrar('2026-09-15', OCT2)
    expect(filas(await recibo(m.sofia, '2026-09-15'))).toEqual([
      ['COMISION', '2026-08-28', '12:00', 'Comisión Lagree + Merch 3 % · base $3,000.00', '90.00'],
    ])
  })

  const devolverYAnular = async () => {
    const venta = await cobro(m, { iso: '2026-08-10T18:00:00Z', monto: 3000 })
    const c = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-10T18:00:05Z', neto: 90, pago: venta })
    await cerrar()
    const dev = await reembolso(m, venta, { iso: '2026-09-03T18:00:00Z', monto: 1200 })
    const rv = await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-09-03T18:00:00Z', neto: -36, pago: dev })
    const anular = () => anularComision({ calculationId: c.id, venueId: m.venueId, actorId: m.owner, motivo: 'Venta capturada por error' })
    return { n: await numero(venta), rv, anular }
  }
  const sinFecha = (r: Awaited<ReturnType<typeof recibo>>) =>
    filas(r)
      .map(f => [f[0], f[3], f[4]])
      .sort((a, b) => Number(a[2]) - Number(b[2]))

  it('devolver y DESPUÉS anular, con el reverso aún sin congelar: la cascada de A4 lo anula, no se barre, y el acumulado queda en $0 (spec §6.4, §13-11)', async () => {
    const { n, rv, anular } = await devolverYAnular()
    await anular()
    // La operación real de A4 anula también el reverso materializado: ya no entra al sobre.
    expect((await prisma.commissionCalculation.findUniqueOrThrow({ where: { id: rv.id } })).status).toBe('VOIDED')
    // En el reporte, abierto (en vivo) y cerrado, la anulación cuenta en `comisiones`, nunca en `ajustes`.
    const sofia = async () =>
      (await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })).personas.items.find(
        i => i.staffId === m.sofia,
      )
    const anulada = { comisiones: '-90.00', propinas: '0.00', ajustes: '0.00', total: '-90.00' }
    expect(await sofia()).toMatchObject(anulada)
    await cerrar('2026-09-15', OCT2)
    expect(await sofia()).toMatchObject(anulada)
    expect(sinFecha(await recibo(m.sofia, '2026-09-15'))).toEqual([
      ['COMISION', `Anulación · comisión Lagree + Merch 3 % · venta #${n}`, '-90.00'],
    ])
    expect(await acumulado(m.sofia)).toBe('0.00') // +90 (agosto) −90 (septiembre)
  })

  it('devolver, congelar el reverso y DESPUÉS anular: −$90 y +$36 en el recibo siguiente, acumulado en $0 (spec §6.4, Codex r1-1)', async () => {
    const { n, anular } = await devolverYAnular()
    await cerrar('2026-09-15', OCT2) // congela el reverso de −$36
    expect(sinFecha(await recibo(m.sofia, '2026-09-15'))).toEqual([
      ['COMISION', `Devolución · comisión Lagree + Merch 3 % · venta #${n}`, '-36.00'],
    ])
    expect(await acumulado(m.sofia)).toBe('54.00')
    await anular()
    await cerrar('2026-10-15', NOV2)
    expect(sinFecha(await recibo(m.sofia, '2026-10-15'))).toEqual([
      ['COMISION', `Anulación · comisión Lagree + Merch 3 % · venta #${n}`, '-90.00'],
      ['COMISION', `Anulación · comisión Lagree + Merch 3 % · venta #${n}`, '36.00'],
    ])
    expect(await acumulado(m.sofia)).toBe('0.00') // +90 −36 −90 +36
  })

  it('la fuente del recibo trae `regla` (jsonb) en la columna 13, después de `monto`, en TODOS sus brazos; pantalla, PDF y Excel salen (contrato con D3c)', async () => {
    await clase(m, { staffId: m.carla, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await ventasDeCarla()
    await agregarAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: m.carla,
      amount: 100,
      reason: 'Bono de agosto',
      fecha: '2026-08-20',
      clientKey: `${m.key}-carla-bono`,
      ahora: SEP2,
    })
    expect(COLUMNAS_FUENTE_RECIBO.indexOf('regla')).toBe(12) // la 13.ª
    expect(COLUMNAS_FUENTE_RECIBO[11]).toBe('monto')
    const revisar = async (estado: 'OPEN' | 'CLOSED') => {
      const sql = await consultaDePaginaDelRecibo({
        userId: m.owner,
        venueId: m.venueId,
        staffId: m.carla,
        fecha: '2026-08-15',
        limit: 100,
      })
      const filasCrudas = await prisma.$queryRaw<Array<Record<string, unknown>>>(sql!)
      // Clase (en vivo o congelada), comisión, propinas agrupadas y ajuste: todos los brazos del UNION ALL.
      expect(new Set(filasCrudas.map(f => f.tipo))).toEqual(new Set(['CLASE', 'COMISION', 'PROPINA', 'AJUSTE']))
      for (const f of filasCrudas) {
        expect(Object.keys(f)).toEqual([...COLUMNAS_FUENTE_RECIBO])
        expect(f.regla).toBeNull() // sin reglas de clase prendidas; D3c sólo la llena en las clases a las que se les aplicó una
      }
      const r = await recibo(m.carla)
      expect(r.periodo.estado).toBe(estado)
      // Clase $480 (coach, 8 lugares) + ventas $170 + bono $100.
      expect(r).toMatchObject({
        total: '750.00',
        totalesPorTipo: { CLASE: '480.00', COMISION: '90.00', PROPINA: '80.00', AJUSTE: '100.00' },
      })
      const pdf = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.carla, fecha: '2026-08-15', format: 'pdf' })
      expect(pdf.encoded.buffer.subarray(0, 4).toString()).toBe('%PDF')
      const xlsx = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.carla, fecha: '2026-08-15', format: 'xlsx' })
      const libro = XLSX.read(xlsx.encoded.buffer)
      const hoja = XLSX.utils.sheet_to_json<Record<string, unknown>>(libro.Sheets[libro.SheetNames[0]], { raw: true })
      expect(hoja.at(-1)).toMatchObject({ Concepto: 'Total', Monto: 750 })
    }
    await revisar('OPEN')
    await cerrar()
    await revisar('CLOSED')
  })
})

describe('recibo de una persona dada de baja (spec fase 3 §6.1, Codex r1-17, r2-17)', () => {
  async function dianaConBono() {
    const diana = await prisma.staff.create({
      data: { email: `${m.key}-diana@example.test`, firstName: 'Diana', lastName: 'QA', active: true },
    })
    await prisma.staffVenue.create({ data: { staffId: diana.id, venueId: m.venueId, role: 'MANAGER', active: true } })
    await agregarAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: diana.id,
      amount: 300,
      reason: 'Bono de agosto',
      fecha: '2026-08-20',
      clientKey: `${m.key}-diana-bono`,
      ahora: SEP2,
    })
    await cerrar()
    await prisma.staffVenue.deleteMany({ where: { staffId: diana.id } })
    await prisma.staff.delete({ where: { id: diana.id } })
    return diana.id
  }

  it('borrada físicamente: el recibo cerrado abre con el nombre que guardó (spec §13-18)', async () => {
    const id = await dianaConBono()
    expect(await recibo(id)).toMatchObject({ persona: 'Diana QA', total: '300.00', cantidad: 1 })
    // El reporte cerrado también la nombra con lo que guardó (no «—»).
    const reporte = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(reporte.personas.items.find(i => i.staffId === id)).toMatchObject({ staffName: 'Diana QA', ajustes: '300.00', total: '300.00' })
  })

  it('sin ningún nombre guardado abre igual como «Persona dada de baja», con sus montos (spec §13-21)', async () => {
    const id = await dianaConBono()
    await prisma.serviceEarning.updateMany({
      where: { organizationId: m.orgId, staffId: id },
      data: { descriptor: { motivo: 'Bono de agosto', sede: 'PN', fecha: '2026-08-20', hora: '10:00' } },
    })
    expect(await recibo(id)).toMatchObject({ persona: 'Persona dada de baja', total: '300.00' })
    // El reporte cerrado dice lo mismo que su recibo (B5 r1).
    const reporte = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(reporte.personas.items.find(i => i.staffId === id)).toMatchObject({ staffName: 'Persona dada de baja', total: '300.00' })
  })

  it('alguien que nunca trabajó aquí sigue sin recibo', async () => {
    const ajena = await prisma.staff.create({
      data: { email: `${m.key}-ajena@example.test`, firstName: 'Ajena', lastName: 'QA', active: true },
    })
    await expect(recibo(ajena.id)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('expulsada del equipo: su recibo abierto abre con lo que hoy le toca (B5 ronda 1)', () => {
  /** Alguien del equipo con su sede (y, como la invitación real, su membresía de la organización si `membresia`). */
  async function persona(nombre: string, o: { membresia: boolean; mundo?: Mundo }) {
    const w = o.mundo ?? m
    const s = await prisma.staff.create({
      data: { email: `${w.key}-${nombre}@example.test`, firstName: nombre, lastName: 'QA', active: true },
    })
    const sv = await prisma.staffVenue.create({ data: { staffId: s.id, venueId: w.venueId, role: 'MANAGER', active: true } })
    if (o.membresia) await prisma.staffOrganization.create({ data: { staffId: s.id, organizationId: w.orgId } })
    return { staffId: s.id, staffVenueId: sv.id }
  }
  const expulsar = (x: { staffVenueId: string }) => hardDeleteTeamMember(m.venueId, x.staffVenueId, true, m.owner)

  it('expulsada (borrado permanente de su sede) con una propina en vivo: su recibo abierto abre con esa propina', async () => {
    const elena = await persona('Elena', { membresia: true })
    await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 40, servedById: elena.staffId })
    await expulsar(elena)
    expect(await prisma.staffVenue.count({ where: { staffId: elena.staffId } })).toBe(0)
    const r = await recibo(elena.staffId)
    expect(r).toMatchObject({ persona: 'Elena QA', total: '40.00', periodo: { estado: 'OPEN' } })
    expect(filas(r)).toEqual([['PROPINA', '2026-08-12', null, 'Propinas del 12 ago 2026 · 1 cobro', '40.00']])
    // El reporte abierto ya la mostraba con ese total: ahora su recibo lo explica.
    const rep = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(rep.personas.items.find(i => i.staffId === elena.staffId)).toMatchObject({
      staffName: 'Elena QA',
      propinas: '40.00',
      total: '40.00',
    })
  })

  it('expulsada sin membresía guardada pero con su clase en vivo: su recibo abre con la clase', async () => {
    const fer = await persona('Fer', { membresia: false })
    await prisma.staffPayLevelAssignment.create({
      data: {
        organizationId: m.orgId,
        staffId: fer.staffId,
        payLevelId: m.coach,
        effectiveFrom: fechaComoDbDate('2026-01-01'),
        revision: 1,
      },
    })
    await clase(m, { staffId: fer.staffId, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    await expulsar(fer)
    expect(await recibo(fer.staffId)).toMatchObject({ persona: 'Fer QA', total: '480.00', cantidad: 1 })
  })

  it('quien sólo es del equipo y tiene clases en OTRA organización sigue sin recibo aquí (404)', async () => {
    const otro = await crearMundo('recibo-ventas-otro')
    try {
      const ajena = await persona('Gaby', { membresia: true, mundo: otro })
      await clase(otro, { staffId: ajena.staffId, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
      await expect(recibo(ajena.staffId)).rejects.toMatchObject({ statusCode: 404 })
    } finally {
      await borrarMundo(otro)
    }
  })
})

describe('el nombre de respaldo de una persona borrada es el mismo en el recibo y en el reporte (B5 ronda 1)', () => {
  it('borrada con un ajuste en el periodo ABIERTO: el reporte abierto la nombra con lo que guardó', async () => {
    const diana = await prisma.staff.create({
      data: { email: `${m.key}-diana@example.test`, firstName: 'Diana', lastName: 'QA', active: true },
    })
    await prisma.staffVenue.create({ data: { staffId: diana.id, venueId: m.venueId, role: 'MANAGER', active: true } })
    await agregarAjusteManual({
      userId: m.owner,
      venueId: m.venueId,
      sede: m.venueId,
      staffId: diana.id,
      amount: 300,
      reason: 'Bono de agosto',
      fecha: '2026-08-20',
      clientKey: `${m.key}-diana-bono`,
      ahora: SEP2,
    })
    await prisma.staffVenue.deleteMany({ where: { staffId: diana.id } })
    await prisma.staff.delete({ where: { id: diana.id } })
    const rep = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(rep.periodo.estado).toBe('OPEN')
    expect(rep.personas.items.find(i => i.staffId === diana.id)).toMatchObject({ staffName: 'Diana QA', ajustes: '300.00' })
    expect(await recibo(diana.id)).toMatchObject({ persona: 'Diana QA', total: '300.00' })
  })

  it('con dos filas guardadas, «Diana QA» (agosto) y «Persona dada de baja» (la devolución congelada después): gana el nombre, en los dos', async () => {
    const diana = await prisma.staff.create({
      data: { email: `${m.key}-diana@example.test`, firstName: 'Diana', lastName: 'QA', active: true },
    })
    await prisma.staffVenue.create({ data: { staffId: diana.id, venueId: m.venueId, role: 'MANAGER', active: true } })
    const v = await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 40, servedById: diana.id })
    await cerrar() // agosto congela su propina con «Diana QA»
    await prisma.staffVenue.deleteMany({ where: { staffId: diana.id } })
    await prisma.staff.delete({ where: { id: diana.id } })
    await reembolso(m, v, { iso: '2026-09-03T18:00:00Z', propina: 40 })
    const septiembre = () => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', offset: 0, limit: 50 })
    const deDiana = (r: Awaited<ReturnType<typeof septiembre>>) => r.personas.items.find(i => i.staffId === diana.id)
    // En vivo, la devolución dice «Persona dada de baja» (ya no hay fila de Staff); el reporte abierto usa el nombre guardado.
    expect(deDiana(await septiembre())).toMatchObject({ staffName: 'Diana QA', propinas: '-40.00' })
    await cerrar('2026-09-15', OCT2) // septiembre congela la devolución con «Persona dada de baja», la fila MÁS RECIENTE
    const guardados = await prisma.serviceEarning.findMany({
      where: { organizationId: m.orgId, staffId: diana.id },
      orderBy: { createdAt: 'asc' },
      select: { descriptor: true },
      take: 10,
    })
    expect(guardados.map(g => (g.descriptor as { persona?: string }).persona)).toEqual(['Diana QA', 'Persona dada de baja'])
    expect(await recibo(diana.id, '2026-09-15')).toMatchObject({ persona: 'Diana QA', total: '-40.00' })
    expect(deDiana(await septiembre())).toMatchObject({ staffName: 'Diana QA', propinas: '-40.00' })
  })

  it('entre dos nombres reales guardados gana el MÁS RECIENTE, en el recibo y en el reporte cerrado', async () => {
    const diana = await prisma.staff.create({
      data: { email: `${m.key}-diana@example.test`, firstName: 'Diana', lastName: 'QA', active: true },
    })
    await prisma.staffVenue.create({ data: { staffId: diana.id, venueId: m.venueId, role: 'MANAGER', active: true } })
    const bono = (fecha: string, ahora: Date) =>
      agregarAjusteManual({
        userId: m.owner,
        venueId: m.venueId,
        sede: m.venueId,
        staffId: diana.id,
        amount: 100,
        reason: 'Bono',
        fecha,
        clientKey: `${m.key}-diana-${fecha}`,
        ahora,
      })
    await bono('2026-08-20', SEP2) // guarda «Diana QA»
    await cerrar()
    await prisma.staff.update({ where: { id: diana.id }, data: { lastName: 'Ruiz' } })
    await bono('2026-09-05', OCT2) // guarda «Diana Ruiz», más reciente
    await prisma.staffVenue.deleteMany({ where: { staffId: diana.id } })
    await prisma.staff.delete({ where: { id: diana.id } })
    expect(await recibo(diana.id)).toMatchObject({ persona: 'Diana Ruiz', total: '100.00' })
    const agosto = await reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    expect(agosto.personas.items.find(i => i.staffId === diana.id)).toMatchObject({ staffName: 'Diana Ruiz', total: '100.00' })
  })
})

describe('el reporte con ventas (spec fase 3 §11)', () => {
  it('abierto y cerrado: quien sólo vende aparece con sus comisiones y propinas; las tarjetas las suman aparte', async () => {
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-04T14:00:00Z', reservas: confirmadas(8) })
    const v = await cobro(m, { iso: '2026-08-12T18:00:00Z', monto: 3000, propina: 50, servedById: m.carla })
    await comision(m, { configId: cfg, staffId: m.sofia, iso: '2026-08-12T18:00:05Z', neto: 90, pago: v })
    const reporte = () => reportePeriodo({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', offset: 0, limit: 50 })
    const de = (r: Awaited<ReturnType<typeof reporte>>, staffId: string) => r.personas.items.find(i => i.staffId === staffId)
    const abierto = await reporte()
    expect(abierto.tarjetas).toMatchObject({ total: '710.00', clases: 1, comisiones: '90.00', propinas: '50.00' })
    expect(de(abierto, m.sofia)).toMatchObject({ clases: 0, comisiones: '90.00', propinas: '0.00', ajustes: '0.00', total: '90.00' })
    expect(de(abierto, m.carla)).toMatchObject({ comisiones: '0.00', propinas: '50.00', total: '50.00' })
    expect(de(abierto, m.ana)).toMatchObject({ clases: 1, comisiones: '0.00', propinas: '0.00', total: '570.00' })
    await cerrar()
    const cerrado = await reporte()
    expect(cerrado.tarjetas).toMatchObject({ total: '710.00', clases: 1, personas: 3, comisiones: '90.00', propinas: '50.00' })
    expect(de(cerrado, m.sofia)).toMatchObject({ clases: 0, comisiones: '90.00', propinas: '0.00', ajustes: '0.00', total: '90.00' })
    expect(de(cerrado, m.carla)).toMatchObject({ clases: 0, comisiones: '0.00', propinas: '50.00', ajustes: '0.00', total: '50.00' })
    expect(de(cerrado, m.ana)).toMatchObject({
      clases: 1,
      payLevelName: 'Head Coach',
      comisiones: '0.00',
      propinas: '0.00',
      total: '570.00',
    })
  })
})
