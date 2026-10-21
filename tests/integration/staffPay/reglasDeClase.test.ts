// tests/integration/staffPay/reglasDeClase.test.ts — las dos reglas de clase de Mindform (spec fase 3 §6.6, decisión D4)
jest.mock('@/communication/rabbitmq/gcal-push-consumer', () => ({
  __esModule: true,
  publishPushNotification: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  sedesLegiblesDe: jest.fn(async (_u: string, venueIds: string[]) => ({ venueIds, parcial: false })),
  tienePermisoEn: jest.fn(async () => true),
  sedesConPermiso: jest.fn(async (_u: string, venueIds: string[]) => venueIds),
  assertPermisoEnSedes: jest.fn(async () => undefined),
  // La herramienta REAL del MCP (D5-fix F2) pregunta si la sede tiene el módulo.
  venueHasServicePayAccess: jest.fn(async () => true),
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { ClaseValorada, valorarClases } from '@/services/dashboard/staffPay/valoracion'
import { anclarClases, cerrarPeriodo, previewCierre } from '@/services/dashboard/staffPay/cierre.service'
import { exportarRecibo, reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import * as XLSX from 'xlsx'
import { fechaComoDbDate, venuePeriodRange } from '@/services/dashboard/staffPay/periodos'
import { cancelClassSession, createClassSession, updateClassSession } from '@/services/dashboard/classSession.dashboard.service'
import { pagoDeClase } from '@/services/dashboard/staffPay/ajustesClase.service'
import { diferenciasDeClase, diferenciasDelPeriodo } from '@/services/dashboard/staffPay/diferencias.service'
import { liquidarDiferencia, previewLiquidacion } from '@/services/dashboard/staffPay/liquidacion.service'
import * as staffPayController from '@/controllers/dashboard/staffPay.dashboard.controller'
import { registerStaffPayTools } from '@/mcp/tools/staffPay'
import type { McpScope } from '@/mcp/scope'
import { borrarMundo, clase, confirmadas, crearMundo, Mundo, periodoCerrado, tablaMindform, TZ } from './_mundo'

const AHORA = new Date('2026-09-02T12:00:00Z')
const AGOSTO = venuePeriodRange({ start: '2026-08-01', end: '2026-08-31' }, TZ)
const H = 3_600_000
const SEG = 1000
const DIA = (d: number) => `2026-08-${String(d).padStart(2, '0')}T14:00:00.000Z` // 08:00 en CDMX
const menos = (iso: string, ms: number) => new Date(new Date(iso).getTime() - ms).toISOString()
const pesos = (d: Prisma.Decimal | string | null | undefined) => (d == null ? null : new Prisma.Decimal(d).toFixed(2))

let m: Mundo
let versionId: string
beforeEach(async () => {
  m = await crearMundo('reglas')
  versionId = (await tablaMindform(m)).versionId
  // El sueldo base es la celda de 0 lugares. En la tabla real de Prado Norte vale 0; aquí 250 para verlo en los montos.
  await prisma.servicePayTableCell.updateMany({ where: { versionId, count: 0 }, data: { amount: new Prisma.Decimal(250) } })
})
afterEach(() => borrarMundo(m))

/** Prende las dos reglas en la versión: suplencia con menos de 3 h = +$100; cancelación con menos de 2 h = sueldo base. */
const prender = () =>
  prisma.servicePayTableVersion.update({
    where: { id: versionId },
    data: { coverBonusHours: 3, coverBonusAmount: new Prisma.Decimal(100), lateCancelHours: 2 },
  })

const vivo = async (id: string): Promise<ClaseValorada | undefined> =>
  (
    await valorarClases(
      prisma,
      { venueId: m.venueId, organizationId: m.orgId, tz: TZ, desde: AGOSTO.from, hasta: AGOSTO.to, ahora: AHORA, claseIds: [id] },
      { limite: 10 },
    )
  )[0]

describe('suplencia con poco aviso (D4-a)', () => {
  it('se le asignó con menos de N horas: su celda + el bono; exactamente N horas antes no cuenta', async () => {
    await prender()
    const tarde = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), 3 * H - SEG),
    })
    const justo = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(5), 3 * H),
    })
    const t = await vivo(tarde)
    expect(t).toMatchObject({
      estado: 'OK',
      bonoSuplencia: '100.00',
      canceladaTarde: false,
      regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' },
    })
    expect(pesos(t!.monto)).toBe('670.00') // 570 (Head Coach, 8 lugares) + 100
    const j = await vivo(justo)
    expect(j).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
    expect(pesos(j!.monto)).toBe('570.00')
  })

  it('no es suplencia: Ana → Bea → Ana, ni una clase vieja sin coach original', async () => {
    await prender()
    const vuelve = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.ana,
      staffAssignedAt: menos(DIA(4), H),
    })
    const vieja = await clase(m, { staffId: m.ana, inicioIso: DIA(5), reservas: confirmadas(8), staffAssignedAt: menos(DIA(5), H) })
    for (const id of [vuelve, vieja]) {
      const v = await vivo(id)
      expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
      expect(pesos(v!.monto)).toBe('570.00')
    }
  })

  it('un monto acordado a mano manda: no se le suma el bono', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado' },
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
    expect(pesos(v!.monto)).toBe('500.00')
  })
})

describe('cancelación tardía (D4-b)', () => {
  it('cancelada con menos de N horas: la celda de 0 lugares de su nivel; exactamente N horas antes, no se paga', async () => {
    await prender()
    const tarde = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(4), 2 * H - SEG),
    })
    const aTiempo = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(5), 2 * H),
    })
    const t = await vivo(tarde)
    expect(t).toMatchObject({
      estado: 'OK',
      conteo: 0,
      conteoCalculado: 0,
      canceladaTarde: true,
      bonoSuplencia: null,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
    expect(pesos(t!.monto)).toBe('250.00')
    // En vivo, una cancelada que su versión no paga sigue sin aparecer, como en las fases 1 y 2.
    expect(await vivo(aTiempo)).toBeUndefined()
  })

  it('sin coach no hay a quién pagarle: queda EXCLUIDA en $0, nunca como excepción (D3a r1)', async () => {
    await prender()
    const id = await clase(m, { staffId: null, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    expect(await vivo(id)).toBeUndefined()
    const p = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    const [v] = await valorarClases(
      prisma,
      {
        venueId: m.venueId,
        organizationId: m.orgId,
        tz: TZ,
        desde: AGOSTO.from,
        hasta: AGOSTO.to,
        ahora: AHORA,
        modo: 'periodo',
        periodId: p.id,
        claseIds: [id],
      },
      { limite: 10 },
    )
    expect(v).toMatchObject({ estado: 'EXCLUIDA', motivo: null, canceladaTarde: false, monto: null, regla: null })
  })

  it('sin la celda de 0 lugares de su nivel es la excepción de siempre', async () => {
    await prender()
    await prisma.servicePayTableCell.deleteMany({ where: { versionId, count: 0, payLevelId: m.hc } })
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    // `regla` sólo dice lo que la regla decidió (D3a r2): sin celda no hubo sueldo base que pagar.
    expect(await vivo(id)).toMatchObject({
      estado: 'EXCEPCION',
      motivo: 'SIN_MONTO_PARA_ESE_CONTEO',
      canceladaTarde: true,
      monto: null,
      regla: null,
    })
  })

  it('una suplencia con poco aviso que después se cancela tarde cobra sólo el sueldo base (sin bono)', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(4), H),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), 2 * H),
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, bonoSuplencia: null, regla: { tipo: 'CANCELACION_TARDIA', horas: 1 } })
    expect(pesos(v!.monto)).toBe('250.00')
  })
})

describe('reglas apagadas y versión anclada', () => {
  it('apagadas (de fábrica): ni bono ni sueldo base, exactamente como en la fase 2', async () => {
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    const can = await clase(m, { staffId: m.ana, inicioIso: DIA(5), status: 'CANCELLED', cancelledAt: menos(DIA(5), H) })
    const v = await vivo(sup)
    expect(v).toMatchObject({ bonoSuplencia: null, canceladaTarde: false, regla: null })
    expect(pesos(v!.monto)).toBe('570.00')
    expect(await vivo(can)).toBeUndefined()
  })

  it('la versión anclada manda: cambiar la regla después no mueve una clase congelada (spec §13-9)', async () => {
    await prender()
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), H),
    })
    const can = await clase(m, { staffId: m.ana, inicioIso: DIA(5), status: 'CANCELLED', cancelledAt: menos(DIA(5), H) })
    const p = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await prisma.$transaction(tx =>
      anclarClases(tx, p.id, [
        { classSessionId: sup, fechaValoracion: '2026-08-04', tableVersionId: versionId },
        { classSessionId: can, fechaValoracion: '2026-08-05', tableVersionId: versionId },
      ]),
    )
    // «Después»: otra revisión del mismo día con otras reglas. El servicio no la deja publicar dentro de un periodo cerrado;
    // aquí se fuerza para probar que el ancla manda.
    const { tableId } = await prisma.servicePayTableVersion.findUniqueOrThrow({ where: { id: versionId }, select: { tableId: true } })
    const v2 = await prisma.servicePayTableVersion.create({
      data: {
        tableId,
        effectiveFrom: fechaComoDbDate('2026-01-01'),
        revision: 2,
        maxCount: 10,
        coverBonusHours: 3,
        coverBonusAmount: new Prisma.Decimal(300),
      },
    })
    const celdas = await prisma.servicePayTableCell.findMany({ where: { versionId }, take: 100 })
    await prisma.servicePayTableCell.createMany({
      data: celdas.map(c => ({ versionId: v2.id, payLevelId: c.payLevelId, count: c.count, amount: c.amount })),
    })

    const enPeriodo = await valorarClases(
      prisma,
      {
        venueId: m.venueId,
        organizationId: m.orgId,
        tz: TZ,
        desde: AGOSTO.from,
        hasta: AGOSTO.to,
        ahora: AHORA,
        modo: 'periodo',
        periodId: p.id,
        claseIds: [sup, can],
      },
      { limite: 10 },
    )
    const de = new Map(enPeriodo.map(c => [c.classSessionId, c]))
    expect(de.get(sup)).toMatchObject({ tableVersionId: versionId, bonoSuplencia: '100.00' })
    expect(pesos(de.get(sup)!.monto)).toBe('670.00')
    expect(de.get(can)).toMatchObject({ tableVersionId: versionId, estado: 'OK', canceladaTarde: true })
    expect(pesos(de.get(can)!.monto)).toBe('250.00')

    // Una clase SIN ancla del mismo mes sí ve la revisión nueva: +$300, y su cancelación tardía ya no se paga.
    const libre = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(6),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(6), H),
    })
    const libreCancelada = await clase(m, { staffId: m.ana, inicioIso: DIA(7), status: 'CANCELLED', cancelledAt: menos(DIA(7), H) })
    expect(await vivo(libre)).toMatchObject({ tableVersionId: v2.id, bonoSuplencia: '300.00' })
    expect(await vivo(libreCancelada)).toBeUndefined()
  })
})

describe('de punta a punta con las estampas reales (D2a + D3a)', () => {
  it('creada con el servicio y sustituida con poco aviso: cobra la celda de la suplente + el bono', async () => {
    await prender()
    const inicio = new Date(Date.now() + 2 * H)
    const fin = new Date(inicio.getTime() + 50 * 60_000)
    const cs = await createClassSession(
      m.venueId,
      {
        productId: m.productId,
        startsAt: inicio.toISOString(),
        endsAt: fin.toISOString(),
        capacity: 10,
        assignedStaffId: m.ana,
        internalNotes: null,
      },
      m.owner,
    )
    await updateClassSession(m.venueId, cs.id, { assignedStaffId: m.sofia }, m.owner)
    const [v] = await valorarClases(
      prisma,
      {
        venueId: m.venueId,
        organizationId: m.orgId,
        tz: TZ,
        desde: new Date(inicio.getTime() - 1),
        hasta: new Date(inicio.getTime() + 1),
        ahora: new Date(fin.getTime() + H),
        claseIds: [cs.id],
      },
      { limite: 1 },
    )
    expect(v).toMatchObject({ staffId: m.sofia, estado: 'OK', conteo: 0, bonoSuplencia: '100.00', regla: { tipo: 'SUPLENCIA', horas: 1 } })
    expect(pesos(v.monto)).toBe('350.00') // celda de 0 lugares de Coach (250) + 100
  })
})

describe('fronteras en la zona de la sede (horas de reloj, cruzando la medianoche local)', () => {
  // Clases a la 01:00 de CDMX: la suplencia y la cancelación caen el día local anterior. Cuenta el tiempo transcurrido.
  it('suplencia de 3 h: un minuto antes del límite sí, justo en el límite y un minuto después no', async () => {
    await prender()
    const asignada = async (dia: number, hhmm: string) =>
      clase(m, {
        staffId: m.ana,
        inicioIso: `2026-08-${dia}T01:00:00-06:00`,
        reservas: confirmadas(8),
        originalStaffId: m.sofia,
        staffAssignedAt: `2026-08-${dia - 1}T${hhmm}:00-06:00`,
      })
    const dentro = await asignada(11, '22:01') // 2 h 59 min antes
    const justo = await asignada(12, '22:00') // 3 h exactas
    const fuera = await asignada(13, '21:59') // 3 h 1 min antes
    expect(await vivo(dentro)).toMatchObject({ bonoSuplencia: '100.00', regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' } })
    expect(pesos((await vivo(dentro))!.monto)).toBe('670.00')
    for (const id of [justo, fuera]) {
      const v = await vivo(id)
      expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: null, regla: null })
      expect(pesos(v!.monto)).toBe('570.00')
    }
  })

  it('cancelación de 2 h: un minuto antes del límite se paga, justo en el límite y un minuto después no', async () => {
    await prender()
    const cancelada = async (dia: number, hhmm: string) =>
      clase(m, {
        staffId: m.ana,
        inicioIso: `2026-08-${dia}T01:00:00-06:00`,
        reservas: confirmadas(8),
        status: 'CANCELLED',
        cancelledAt: `2026-08-${dia - 1}T${hhmm}:00-06:00`,
      })
    const dentro = await cancelada(15, '23:01') // 1 h 59 min antes
    const justo = await cancelada(16, '23:00') // 2 h exactas
    const fuera = await cancelada(17, '22:59') // 2 h 1 min antes
    expect(await vivo(dentro)).toMatchObject({
      estado: 'OK',
      conteo: 0,
      canceladaTarde: true,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
    expect(pesos((await vivo(dentro))!.monto)).toBe('250.00')
    expect(await vivo(justo)).toBeUndefined()
    expect(await vivo(fuera)).toBeUndefined()
  })
})

describe('después del inicio cuenta como 0 h de aviso (D3a r2)', () => {
  it('cambio de coach DESPUÉS de empezar: suplencia con 0 h, su celda + el bono', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), -H), // una hora DESPUÉS del inicio
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', bonoSuplencia: '100.00', regla: { tipo: 'SUPLENCIA', horas: 0, bono: '100.00' } })
    expect(pesos(v!.monto)).toBe('670.00')
  })

  it('cancelación DESPUÉS de empezar: cancelada tarde con 0 h, paga el sueldo base', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), -H) })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', conteo: 0, canceladaTarde: true, regla: { tipo: 'CANCELACION_TARDIA', horas: 0 } })
    expect(pesos(v!.monto)).toBe('250.00')
  })
})

describe('ajustes a mano sobre una cancelada tarde (resolución 12)', () => {
  it('el conteo corregido se ignora: vale la celda de 0 lugares', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payCountOverride: 8, overrideReason: 'Corrección' } })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, payCountOverride: 8, conteo: 0, conteoCalculado: 0, tieneAjuste: true })
    expect(pesos(v!.monto)).toBe('250.00')
  })

  it('el monto acordado manda, y entonces la regla no decidió nada: `regla` null (D3a r2)', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado' },
    })
    const v = await vivo(id)
    expect(v).toMatchObject({ estado: 'OK', canceladaTarde: true, bonoSuplencia: null, regla: null })
    expect(pesos(v!.monto)).toBe('500.00')
  })

  it('excluida a mano: no se paga aunque se haya cancelado tarde', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    await prisma.classSessionPayState.create({ data: { classSessionId: id, payExcluded: true, overrideReason: 'No vino' } })
    expect(await vivo(id)).toMatchObject({ estado: 'EXCLUIDA', monto: null, bonoSuplencia: null, regla: null })
  })
})

describe('una cancelada sin regla o sin estampa sigue EXCLUIDA en el modo periodo', () => {
  const enPeriodo = async (periodId: string, id: string) =>
    (
      await valorarClases(
        prisma,
        {
          venueId: m.venueId,
          organizationId: m.orgId,
          tz: TZ,
          desde: AGOSTO.from,
          hasta: AGOSTO.to,
          ahora: AHORA,
          modo: 'periodo',
          periodId,
          claseIds: [id],
        },
        { limite: 10 },
      )
    )[0]

  it('reglas apagadas: cancelada con poco aviso, $0', async () => {
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    const p = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    expect(await enPeriodo(p.id, id)).toMatchObject({ estado: 'EXCLUIDA', canceladaTarde: false, monto: null, regla: null })
  })

  it('reglas prendidas pero sin `cancelledAt` (clase de antes de la estampa): $0, nunca el sueldo base', async () => {
    await prender()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED' })
    const p = await periodoCerrado(m, '2026-08-01', '2026-08-31')
    expect(await enPeriodo(p.id, id)).toMatchObject({ estado: 'EXCLUIDA', canceladaTarde: false, monto: null, regla: null })
    expect(await vivo(id)).toBeUndefined()
  })
})

/** El módulo prendido para el cierre (fase 2) y el pago al personal activado desde enero, con la sede ACTIVA desde ese día
 *  (como la deja la activación real; desde B11 una clase sin ancla desde el inicio exige su ventana). */
const activar = async () => {
  ;(global as any).__sedes = [m.venueId]
  await prisma.organization.update({ where: { id: m.orgId }, data: { staffPayStartDate: fechaComoDbDate('2026-01-01') } })
  await prisma.staffPayVenueWindow.create({
    data: { organizationId: m.orgId, venueId: m.venueId, desde: fechaComoDbDate('2026-01-01'), activadaPor: m.owner },
  })
}
const cerrarAgosto = async () => {
  const p = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-08-15', ahora: AHORA })
  return cerrarPeriodo({
    userId: m.owner,
    venueId: m.venueId,
    fecha: '2026-08-15',
    ahora: AHORA,
    huellaEsperada: p.huella,
    confirmarHuerfanas: true,
  })
}

/**
 * La herramienta REAL `staff_service_pay_differences` del MCP sobre el servicio y la base reales (D5-fix F2): es lo que el
 * agente le repite al dueño. La prueba unitaria del MCP simula el servicio, así que no ve de dónde sale la causa.
 */
const diferenciasDelMcp = async (periodId: string) => {
  const herramientas = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
  const scope = {
    staffId: m.owner,
    activeOrg: m.orgId,
    allowedVenueIds: [m.venueId],
    perVenueAccess: new Map([[m.venueId, { role: 'OWNER', corePermissions: ['staffpay:read'] }]]),
  } as unknown as McpScope
  registerStaffPayTools({ tool: (...a: unknown[]) => herramientas.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
  const r = await herramientas.get('staff_service_pay_differences')!({ venueId: m.venueId, periodId }, {})
  return JSON.parse(r.content[0].text)
}

describe('el motivo queda en lo congelado y en el recibo (spec fase 3 §6.6)', () => {
  const recibo = () => reciboDePersona({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', limit: 50 })
  const ESPERADOS = ['Reformer · Cancelada 1 h antes: se paga el sueldo base', 'Reformer · Suplencia avisada 2 h antes: +$100']
  /**
   * El PDF arma la fuente con el SELECT agrupado de propinas de B5 y el Excel sin agrupar: los dos `UNION ALL` se compilan
   * aunque no haya propinas, así que una columna `regla` de más o de menos truena aquí (Codex plan r1, P1 B5/D3c). Del PDF
   * sólo se comprueba que lo es (pdfkit comprime); el Excel lleva los mismos conceptos, celda por celda.
   */
  const archivos = async () => {
    const pdf = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', format: 'pdf' })
    expect(pdf.encoded.buffer.subarray(0, 4).toString()).toBe('%PDF')
    const xlsx = await exportarRecibo({ userId: m.owner, venueId: m.venueId, staffId: m.ana, fecha: '2026-08-15', format: 'xlsx' })
    const libro = XLSX.read(xlsx.encoded.buffer)
    return XLSX.utils
      .sheet_to_json<Record<string, unknown>>(libro.Sheets[libro.SheetNames[0]])
      .map(f => String(f.Concepto))
      .filter(c => c.startsWith('Reformer'))
      .sort()
  }

  it('el recibo abierto ya lo dice; el cierre lo congela en el renglón y el recibo cerrado lo sigue diciendo, también en PDF y Excel', async () => {
    await activar()
    await prender()
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(4), 3 * H - SEG),
    })
    const can = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(5), 2 * H - SEG),
    })

    const abierto = await recibo()
    expect(abierto.periodo.estado).toBe('OPEN')
    expect(abierto.renglones.map(r => r.concepto).sort()).toEqual(ESPERADOS)
    expect(await archivos()).toEqual(ESPERADOS)

    await cerrarAgosto()
    const lineas = await prisma.serviceEarning.findMany({
      where: { organizationId: m.orgId, concept: 'SERVICE', sourceType: 'CLASS_SESSION' },
      take: 10,
    })
    const de = new Map(lineas.map(l => [l.sourceId, l]))
    expect(de.get(sup)!.amount.toFixed(2)).toBe('670.00')
    expect(de.get(sup)!.descriptor).toMatchObject({ regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' } })
    expect(de.get(can)!.amount.toFixed(2)).toBe('250.00')
    expect(de.get(can)!.count).toBe(0)
    expect(de.get(can)!.descriptor).toMatchObject({ regla: { tipo: 'CANCELACION_TARDIA', horas: 1 } })

    // Lo congelado no se mueve aunque después se apaguen las reglas de la tabla.
    await prisma.servicePayTableVersion.update({
      where: { id: versionId },
      data: { coverBonusHours: null, coverBonusAmount: null, lateCancelHours: null },
    })
    const cerrado = await recibo()
    expect(cerrado.periodo.estado).toBe('CLOSED')
    expect(cerrado.renglones.map(r => r.concepto).sort()).toEqual(ESPERADOS)
    expect(cerrado.total).toBe('920.00')
    expect(await archivos()).toEqual(ESPERADOS)
  })

  it('con monto acordado la regla no decidió nada: el renglón no la dice y el descriptor no la congela (D3a r2)', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(5), H),
    })
    await prisma.classSessionPayState.create({
      data: { classSessionId: id, payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado' },
    })
    const abierto = await recibo()
    expect(abierto.renglones.map(r => [r.concepto, r.monto])).toEqual([['Reformer', '500.00']])

    await cerrarAgosto()
    const linea = await prisma.serviceEarning.findFirstOrThrow({ where: { organizationId: m.orgId, concept: 'SERVICE', sourceId: id } })
    expect(linea.amount.toFixed(2)).toBe('500.00')
    expect(linea.descriptor).not.toHaveProperty('regla')
    expect((await recibo()).renglones.map(r => [r.concepto, r.monto])).toEqual([['Reformer', '500.00']])
    expect(await archivos()).toEqual(['Reformer'])
  })
})

describe('la tarjeta y las diferencias dicen por qué (spec fase 3 §6.6)', () => {
  it('la respuesta REAL de la tarjeta (la que lee el dashboard) trae `regla` con su bono y no los campos internos', async () => {
    await prender()
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(6),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(6), 3 * H - SEG),
    })
    const res = { json: jest.fn() }
    const next = jest.fn()
    await staffPayController.getClassPay(
      { params: { venueId: m.venueId, sessionId: sup }, authContext: { userId: m.owner } } as any,
      res as any,
      next,
    )
    expect(next).not.toHaveBeenCalled()
    // Por el cable, como lo recibe el navegador.
    const cuerpo = JSON.parse(JSON.stringify(res.json.mock.calls[0][0]))
    expect(cuerpo).toMatchObject({ estado: 'OK', monto: '670.00', regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' } })
    expect(cuerpo).not.toHaveProperty('bonoSuplencia')
    expect(cuerpo).not.toHaveProperty('canceladaTarde')
  })

  it('tarjeta: la cancelada tarde dice cuánto y por qué; la cancelada a tiempo sigue CANCELADA; la suplencia dice su bono', async () => {
    await prender()
    const tarde = await clase(m, { staffId: m.ana, inicioIso: DIA(4), status: 'CANCELLED', cancelledAt: menos(DIA(4), H) })
    const aTiempo = await clase(m, { staffId: m.ana, inicioIso: DIA(5), status: 'CANCELLED', cancelledAt: menos(DIA(5), 3 * H) })
    const sup = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(6),
      reservas: confirmadas(8),
      originalStaffId: m.sofia,
      staffAssignedAt: menos(DIA(6), 3 * H - SEG),
    })
    expect(await pagoDeClase(m.venueId, tarde)).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      conteo: 0,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 1 },
    })
    expect(await pagoDeClase(m.venueId, aTiempo)).toMatchObject({ estado: 'CANCELADA', monto: null, regla: null })
    expect(await pagoDeClase(m.venueId, sup)).toMatchObject({
      estado: 'OK',
      monto: '670.00',
      regla: { tipo: 'SUPLENCIA', horas: 2, bono: '100.00' },
    })
  })

  it('cancelar tarde una clase ya cerrada deja la diferencia hasta el sueldo base, con su motivo (sigue CANCELADA: D5-fix F2)', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.ana,
      staffAssignedAt: menos(DIA(4), 48 * H),
    })
    const { periodId } = await cerrarAgosto()
    // Se cancela DESPUÉS del cierre, con la estampa real (ya había empezado: 0 h de aviso; la versión anclada pide menos de
    // 2 h). Antes del D5-fix la prueba fechaba la cancelación antes del cierre, lo que ningún camino de src/ puede hacer.
    await cancelClassSession(m.venueId, id, m.owner)
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora: AHORA })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      persona: m.ana,
      corresponde: '250.00',
      congelado: '570.00',
      pendiente: '-320.00',
      causa: 'CANCELADA',
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
    // Y el MCP lo dice con su texto, porque esta vez la cancelación sí fue después del cierre.
    expect((await diferenciasDelMcp(periodId)).items).toEqual([
      expect.objectContaining({
        classSessionId: id,
        pendiente: '-320.00',
        causa: 'Clase cancelada después del cierre · Cancelada menos de 1 h antes: se paga el sueldo base',
      }),
    ])
    expect(await pagoDeClase(m.venueId, id)).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      anclada: true,
      regla: { tipo: 'CANCELACION_TARDIA' },
    })
  })

  it('una sustitución con poco aviso después del cierre: la regla va sólo en la fila de la suplente', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.ana,
      staffAssignedAt: menos(DIA(4), 48 * H),
    })
    await cerrarAgosto()
    await prisma.classSession.update({ where: { id }, data: { assignedStaffId: m.sofia, staffAssignedAt: new Date(menos(DIA(4), H)) } })
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora: AHORA })
    const de = new Map(filas.map(f => [f.persona, f]))
    expect(de.get(m.ana)).toMatchObject({ causa: 'COACH_SALE', corresponde: '0.00', regla: null })
    expect(de.get(m.sofia)).toMatchObject({
      causa: 'COACH_ENTRA',
      corresponde: '580.00',
      regla: { tipo: 'SUPLENCIA', horas: 1, bono: '100.00' },
    })
  })

  it('cancelada tarde con el conteo corregido a 8 (resolución 12): el 8 queda en el ajuste, pero se paga y se muestra el conteo 0', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(4),
      reservas: confirmadas(8),
      originalStaffId: m.ana,
      staffAssignedAt: menos(DIA(4), 48 * H),
    })
    await cerrarAgosto()
    // Cancelada después del cierre con la estampa real (D5-fix F2: así sigue siendo CANCELADA), ya empezada: 0 h de aviso.
    await cancelClassSession(m.venueId, id, m.owner)
    await prisma.classSessionPayState.update({ where: { classSessionId: id }, data: { payCountOverride: 8, overrideReason: 'Corrección' } })
    expect(await pagoDeClase(m.venueId, id)).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      conteo: 0,
      conteoCalculado: 0,
      ajuste: { payCountOverride: 8 },
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora: AHORA })
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      corresponde: '250.00',
      pendiente: '-320.00',
      conteo: 0,
      conteoCongelado: 8,
      causa: 'CANCELADA',
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
  })
})

describe('auditoría de Codex del Bloque D (D5-fix)', () => {
  // Codex D-1 (2026, CDMX): una clase que cruza la medianoche del 30 de septiembre (termina a las 00:20 del 1 de octubre),
  // cancelada a las 23:00 (30 min de aviso; la regla pide menos de 2 h), y el cierre de septiembre a las 00:05.
  const INICIO_SEP = '2026-09-30T23:30:00-06:00'
  const CANCELADA_SEP = '2026-09-30T23:00:00-06:00'
  const CIERRE_SEP = new Date('2026-10-01T00:05:00-06:00')
  const cerrarSeptiembre = async () => {
    const pv = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', ahora: CIERRE_SEP })
    const r = await cerrarPeriodo({
      userId: m.owner,
      venueId: m.venueId,
      fecha: '2026-09-15',
      ahora: CIERRE_SEP,
      huellaEsperada: pv.huella,
      confirmarHuerfanas: true,
    })
    return { pv, r }
  }

  it('F1 (Codex): una cancelada tarde cuyo horario termina DESPUÉS del cierre entra al cierre por $250 y queda anclada; la huella del preview es la del cierre', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: INICIO_SEP,
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: CANCELADA_SEP,
    })
    const { pv, r } = await cerrarSeptiembre()
    expect(pv).toMatchObject({ puedeCerrar: true, bloqueos: [], clases: 1, personas: 1, totalServicios: '250.00', total: '250.00' })
    expect(r).toMatchObject({ yaCerrado: false, personas: 1, total: '250.00', huella: pv.huella })
    const linea = await prisma.serviceEarning.findFirstOrThrow({ where: { organizationId: m.orgId, concept: 'SERVICE', sourceId: id } })
    expect([linea.staffId, linea.amount.toFixed(2), linea.count, linea.periodId]).toEqual([m.ana, '250.00', 0, r.periodId])
    expect(linea.descriptor).toMatchObject({ regla: { tipo: 'CANCELACION_TARDIA', horas: 0 } })
    expect(await prisma.classSessionPayState.findUnique({ where: { classSessionId: id } })).toMatchObject({
      originPeriodId: r.periodId,
      valuationVersionId: versionId,
    })
    // La tarjeta, todavía antes de las 00:20: congelada en $250 y nada pendiente que buscar.
    expect(await pagoDeClase(m.venueId, id, prisma, { ahora: CIERRE_SEP })).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      anclada: true,
      llegoTarde: false,
      periodoOrigen: { id: r.periodId, estado: 'CLOSED' },
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
  })

  it('F1: una cancelada tarde de un periodo YA cerrado, creada después del cierre: la tarjeta avisa antes y después de su horario, la diferencia es +$250 y se liquida una vez', async () => {
    await activar()
    await prender()
    const { periodId } = await cerrarAgosto()
    const id = await clase(m, { staffId: m.ana, inicioIso: DIA(20) })
    // La estampa real: después del cierre y ya empezada (0 h de aviso).
    await cancelClassSession(m.venueId, id, m.owner)
    const durante = new Date(new Date(DIA(20)).getTime() + 20 * 60_000)
    const hoy = await pagoDeClase(m.venueId, id)
    expect(hoy).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      conteo: 0,
      anclada: false,
      llegoTarde: true,
      // Sin ancla no hay periodo de origen en la tarjeta (es el de su ancla); el cerrado lo da la diferencia.
      periodoOrigen: null,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
    expect(await pagoDeClase(m.venueId, id, prisma, { ahora: durante })).toEqual(hoy)
    for (const ahora of [durante, undefined]) {
      const { origen, filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora })
      expect(origen?.id).toBe(periodId)
      expect(filas).toEqual([
        expect.objectContaining({ persona: m.ana, corresponde: '250.00', congelado: '0.00', pendiente: '250.00', causa: 'CANCELADA' }),
      ])
    }
    const pv = await previewLiquidacion({ userId: m.owner, venueId: m.venueId, classSessionId: id })
    expect(pv).toMatchObject({ periodoOrigen: { id: periodId }, total: '250.00', bloqueada: false })
    const liquidar = () =>
      liquidarDiferencia({
        userId: m.owner,
        venueId: m.venueId,
        classSessionId: id,
        periodoOrigenId: periodId,
        huellaEsperada: pv.huella,
        solicitudId: 'd5fix-cancelada-tarde',
      })
    expect(await liquidar()).toEqual({ lineas: [{ staffId: m.ana, amount: '250.00' }], yaLiquidada: false })
    expect(await liquidar()).toEqual({ lineas: [{ staffId: m.ana, amount: '250.00' }], yaLiquidada: true })
    const lineas = await prisma.serviceEarning.findMany({
      where: { organizationId: m.orgId, sourceId: id },
      select: { concept: true, amount: true },
      take: 10,
    })
    expect(lineas.map(e => [e.concept, e.amount.toFixed(2)])).toEqual([['RECONCILE', '250.00']])
    expect((await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id })).filas).toEqual([
      expect.objectContaining({ pendiente: '0.00', causa: null }),
    ])
    expect(await pagoDeClase(m.venueId, id)).toMatchObject({ anclada: true, llegoTarde: false, periodoOrigen: { id: periodId } })
  })

  it.each([
    ['con aviso suficiente', true, '2026-09-30T21:00:00-06:00'],
    ['sin la regla', false, CANCELADA_SEP],
  ])(
    'F1: una cancelada que NO se paga (%s) sigue fuera: CANCELADA en la tarjeta, sin diferencia y EXCLUIDA en $0',
    async (_caso, reglas, cancelledAt) => {
      await activar()
      if (reglas) await prender()
      const id = await clase(m, { staffId: m.ana, inicioIso: INICIO_SEP, reservas: confirmadas(8), status: 'CANCELLED', cancelledAt })
      const { pv, r } = await cerrarSeptiembre()
      expect(pv).toMatchObject({ puedeCerrar: true, clases: 0, totalServicios: '0.00', total: '0.00' })
      expect(r.total).toBe('0.00')
      expect(await prisma.serviceEarning.count({ where: { organizationId: m.orgId, sourceId: id } })).toBe(0)
      for (const ahora of [CIERRE_SEP, undefined]) {
        expect(await pagoDeClase(m.venueId, id, prisma, { ahora })).toMatchObject({
          estado: 'CANCELADA',
          monto: null,
          anclada: false,
          llegoTarde: false,
        })
        const { origen, filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id }, { ahora })
        expect(origen?.id).toBe(r.periodId)
        expect(filas).toEqual([
          expect.objectContaining({ persona: m.ana, estadoClase: 'EXCLUIDA', corresponde: '0.00', pendiente: '0.00', causa: null }),
        ])
      }
      const lista = await diferenciasDelPeriodo(
        { userId: m.owner, venueId: m.venueId, periodId: r.periodId, limit: 50 },
        { ahora: CIERRE_SEP },
      )
      expect(lista.items).toEqual([])
    },
  )

  it('F1: la tarjeta de una cancelada tarde es la misma antes de empezar, a media clase y después de su horario', async () => {
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: INICIO_SEP,
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: CANCELADA_SEP,
    })
    const tarjetas = []
    for (const iso of ['2026-09-30T23:10:00-06:00', '2026-09-30T23:45:00-06:00', '2026-10-01T02:00:00-06:00'])
      tarjetas.push(await pagoDeClase(m.venueId, id, prisma, { ahora: new Date(iso) }))
    const [antes, durante, despues] = tarjetas
    expect(despues).toMatchObject({
      estado: 'OK',
      monto: '250.00',
      conteo: 0,
      llegoTarde: false,
      periodoOrigen: null,
      regla: { tipo: 'CANCELACION_TARDIA', horas: 0 },
    })
    expect(antes).toEqual(despues)
    expect(durante).toEqual(despues)
  })

  it('F1 regresión: una clase NO cancelada que no ha terminado sigue bloqueando el cierre y es NO_TERMINADA; la cancelada tarde no suma al bloqueo', async () => {
    await activar()
    await prender()
    const enCurso = await clase(m, { staffId: m.ana, inicioIso: INICIO_SEP, reservas: confirmadas(8) })
    await clase(m, { staffId: m.sofia, inicioIso: INICIO_SEP, status: 'CANCELLED', cancelledAt: CANCELADA_SEP })
    const pv = await previewCierre({ userId: m.owner, venueId: m.venueId, fecha: '2026-09-15', ahora: CIERRE_SEP })
    expect(pv).toMatchObject({ puedeCerrar: false, bloqueos: [{ codigo: 'CLASES_EN_CURSO', n: 1 }] })
    await expect(
      cerrarPeriodo({
        userId: m.owner,
        venueId: m.venueId,
        fecha: '2026-09-15',
        ahora: CIERRE_SEP,
        huellaEsperada: pv.huella,
        confirmarHuerfanas: true,
      }),
    ).rejects.toMatchObject({ code: 'CLASES_EN_CURSO' })
    expect(await pagoDeClase(m.venueId, enCurso, prisma, { ahora: CIERRE_SEP })).toMatchObject({
      estado: 'NO_TERMINADA',
      monto: null,
      llegoTarde: false,
    })
  })

  it('F2 (Codex): cancelada tarde ANTES del cierre, congelada en $250 y acordada después en $500: la causa es MONTO y el MCP no inventa una cancelación posterior', async () => {
    await activar()
    await prender()
    const id = await clase(m, {
      staffId: m.ana,
      inicioIso: DIA(5),
      reservas: confirmadas(8),
      status: 'CANCELLED',
      cancelledAt: menos(DIA(5), H),
    })
    const { periodId } = await cerrarAgosto()
    const congelada = await prisma.serviceEarning.findFirstOrThrow({ where: { organizationId: m.orgId, concept: 'SERVICE', sourceId: id } })
    expect(congelada.amount.toFixed(2)).toBe('250.00')
    await prisma.classSessionPayState.update({
      where: { classSessionId: id },
      data: { payAmountOverride: new Prisma.Decimal(500), overrideReason: 'Acordado después del cierre' },
    })
    const { filas } = await diferenciasDeClase(prisma, { venueId: m.venueId, classSessionId: id })
    expect(filas).toEqual([
      expect.objectContaining({
        persona: m.ana,
        corresponde: '500.00',
        congelado: '250.00',
        pendiente: '250.00',
        regla: null,
        causa: 'MONTO',
      }),
    ])
    expect((await diferenciasDelMcp(periodId)).items).toEqual([
      expect.objectContaining({ classSessionId: id, pendiente: '250.00', causa: 'Monto de la clase corregido' }),
    ])
  })
})
