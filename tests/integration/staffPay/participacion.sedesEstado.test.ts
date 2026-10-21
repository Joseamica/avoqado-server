// tests/integration/staffPay/participacion.sedesEstado.test.ts — fase 3, B13 (diseño r3.7(1), r4.5, r4.7, r5.1, r5.4; revisión de
// B12): la pantalla 1, Configuración › Sedes (`estadoSedes`, `GET /sedes`): cada sede con su estado, desde y hasta cuándo, qué
// puede hacer el usuario y cuánto de lo vendido en periodos SIN CERRAR hoy no entra (`fueraEstePeriodo`, el `entran` de activar
// desde su mínimo efectivo). El aviso de devoluciones pendientes del ajuste manual por ruta y por MCP, y lo de la revisión de B12
// que se cierra aquí. SÓLO LECTURA: nada de esto cambia qué se paga. Los permisos son los REALES (roles por sede); sólo el plan
// va simulado (`__sedes`). Fechas de 2026 en UTC; CDMX = UTC−6.
import type { Request, Response } from 'express'
import prisma from '@/utils/prismaClient'
import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { vistaPreviaParticipacion } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import { activarSede, desactivarSede } from '@/services/dashboard/staffPay/participacion'
import { cerrarPeriodo, previewCierre, TIMEOUT_CIERRE_MS } from '@/services/dashboard/staffPay/cierre.service'
import { reciboDePersona } from '@/services/dashboard/staffPay/recibos.service'
import * as foto from '@/services/dashboard/staffPay/foto'
import * as pendientesMod from '@/services/dashboard/staffPay/devolucionesPendientes'
import { getAdjustmentPreview, getSedes } from '@/controllers/dashboard/staffPay.dashboard.controller'
import { registerStaffPayTools } from '@/mcp/tools/staffPay'
import type { McpScope } from '@/mcp/scope'
import { borrarMundo, clase, confirmadas, crearMundo, crearSede, Mundo, periodoCerrado, tablaFija } from './_mundo'
import { activar, cobro, reembolso, sedeActiva } from './_ventas'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
  organizacionTieneServicePay: jest.fn(async () => ((global as any).__sedes ?? []).length > 0),
  venueHasServicePayAccess: jest.fn(async (v: string) => ((global as any).__sedes ?? []).includes(v)),
}))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: jest.fn() }))

const OCT20 = new Date('2026-10-20T18:00:00Z') // 12:00 del 20-oct en CDMX
const OCT21 = new Date('2026-10-21T18:00:00Z')
const NOV2 = new Date('2026-11-02T18:00:00Z')
const OCT = '2026-10-15'
const TZ = 'America/Mexico_City'
const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

let m: Mundo
let A: string
let B: string
let C: string
let productoB: string
let encargado: string // ADMIN en A y B: lee, no cierra
let soloA: string // ADMIN sólo en A

beforeEach(async () => {
  m = await crearMundo('part-sedes')
  A = m.venueId
  const b = await crearSede(m.orgId, m.key, 'b')
  B = b.venueId
  productoB = b.productId
  C = (await crearSede(m.orgId, m.key, 'c')).venueId
  ;(global as any).__sedes = [A, B] // C sin el plan
  // El dueño también es OWNER en B y C; los otros dos sólo leen (ADMIN: staffpay:read y manage, sin close).
  const mk = async (n: string) =>
    (await prisma.staff.create({ data: { email: `${m.key}-${n}@example.test`, firstName: n, lastName: 'QA', active: true } })).id
  encargado = await mk('Encargado')
  soloA = await mk('SoloA')
  await prisma.staffVenue.createMany({
    data: [
      { staffId: m.owner, venueId: B, role: 'OWNER', active: true },
      { staffId: m.owner, venueId: C, role: 'OWNER', active: true },
      { staffId: encargado, venueId: A, role: 'ADMIN', active: true },
      { staffId: encargado, venueId: B, role: 'ADMIN', active: true },
      { staffId: soloA, venueId: A, role: 'ADMIN', active: true },
    ],
  })
})
afterEach(async () => {
  jest.restoreAllMocks()
  await borrarMundo(m)
})

const estado = (ahora: Date, userId = m.owner) => estadoSedes({ userId, venueId: A, ahora })
const sedeDe = (e: Awaited<ReturnType<typeof estadoSedes>>, venueId: string) => e.sedes.find(s => s.venueId === venueId)!
const cero = { n: 0, total: '0.00' }
const cuenta = (c: { clases?: [number, string, number?]; comisiones?: [number, string]; propinas?: [number, string] } = {}) => ({
  clases: { n: c.clases?.[0] ?? 0, total: c.clases?.[1] ?? '0.00', pendientesDeValoracion: c.clases?.[2] ?? 0 },
  comisiones: c.comisiones ? { n: c.comisiones[0], total: c.comisiones[1] } : cero,
  propinas: c.propinas ? { n: c.propinas[0], total: c.propinas[1] } : cero,
})
const propinaB = (iso: string, monto: number) => cobro(m, { iso, propina: monto, servedById: m.carla, venueId: B })
/** El `entran` de la vista previa de activar B desde `fecha` (B11): lo que `fueraEstePeriodo` tiene que decir. */
const entranDesde = async (fecha: string, ahora: Date) => {
  const v = await vistaPreviaParticipacion({ userId: m.owner, venueId: A, sedeId: B, accion: 'activar', fecha, ahora })
  return v.accion === 'activar' ? v.entran : null
}

describe('los cuatro estados, desde/hasta, el mínimo efectivo y qué puede hacer el usuario (r3.7(1), ruling de B12 #3)', () => {
  it('activar, desactivar con fecha pasada y hasta hoy, perder el plan con la ventana abierta, y sin plan ni ventana', async () => {
    // Inicio 1-sep; septiembre ya cerrado ⇒ el mínimo de la organización es el 1-oct (no el inicio).
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: null })
    await periodoCerrado(m, '2026-09-01', '2026-09-30')
    const e = await estado(OCT20)
    expect(e).toMatchObject({ activado: true, startDate: '2026-09-01', periodo: { start: '2026-10-01', end: '2026-10-31' } })
    expect(e.sedes.map(s => s.venueId).sort()).toEqual([A, B, C].sort())
    expect(sedeDe(e, A)).toEqual({
      venueId: A,
      nombre: `${m.key}-pn`,
      zona: TZ,
      tienePlan: true,
      estado: 'ACTIVA',
      desde: '2026-09-01',
      hasta: null,
      minimo: null, // activa: no se puede activar
      puedeActivar: false,
      puedeDesactivar: true,
      fueraEstePeriodo: cuenta(),
    })
    expect(sedeDe(e, B)).toMatchObject({
      tienePlan: true,
      estado: 'SIN_ACTIVAR',
      desde: null,
      hasta: null,
      minimo: '2026-10-01',
      puedeActivar: true,
      puedeDesactivar: false,
    })
    expect(sedeDe(e, C)).toMatchObject({
      tienePlan: false,
      estado: 'SIN_PLAN',
      minimo: null,
      puedeActivar: false,
      puedeDesactivar: false,
    })

    // Activar B desde el 15-oct.
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, desde: '2026-10-15', ahora: OCT20 })
    expect(sedeDe(await estado(OCT20), B)).toMatchObject({
      estado: 'ACTIVA',
      desde: '2026-10-15',
      hasta: null,
      minimo: null,
      puedeActivar: false,
      puedeDesactivar: true,
    })
    // Desactivarla con HOY como último día: hoy todavía entra ⇒ ACTIVA; ya no hay nada que desactivar y no se puede volver a
    // activar hasta mañana (su mínimo efectivo sería el 21-oct).
    await desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta: '2026-10-20', ahora: OCT20 })
    // La vista previa del cierre dice lo MISMO ese día (la misma definición; octubre todavía no termina, pero se previsualiza).
    expect(
      (await previewCierre({ userId: m.owner, venueId: A, fecha: OCT, ahora: OCT20 })).porSede.find(s => s.venueId === B)?.estado,
    ).toBe('ACTIVA')
    expect(sedeDe(await estado(OCT20), B)).toMatchObject({
      estado: 'ACTIVA',
      desde: '2026-10-15',
      hasta: '2026-10-20',
      minimo: null,
      puedeActivar: false,
      puedeDesactivar: false,
    })
    // Al día siguiente: SIN_ACTIVAR, con la última ventana y el mínimo efectivo de la sede (después de su último día).
    expect(sedeDe(await estado(OCT21), B)).toMatchObject({
      estado: 'SIN_ACTIVAR',
      desde: '2026-10-15',
      hasta: '2026-10-20',
      minimo: '2026-10-21',
      puedeActivar: true,
      puedeDesactivar: false,
    })

    // A pierde el plan con su ventana abierta ⇒ ACTIVA_SIN_PLAN: la MISMA sede que bloquea el cierre y el mismo estado que
    // dice la vista previa del cierre (una sola definición).
    ;(global as any).__sedes = [B]
    const sinPlan = await estado(OCT21)
    expect(sedeDe(sinPlan, A)).toMatchObject({ tienePlan: false, estado: 'ACTIVA_SIN_PLAN', puedeActivar: false, puedeDesactivar: true })
    const p = await previewCierre({ userId: m.owner, venueId: A, fecha: OCT, ahora: NOV2 })
    expect(p.bloqueos).toContainEqual({ codigo: 'SEDE_ACTIVA_SIN_PLAN', venueIds: [A], otrasConPlan: true })
    expect(p.porSede.find(s => s.venueId === A)?.estado).toBe('ACTIVA_SIN_PLAN')
    expect(sedeDe(sinPlan, C)).toMatchObject({ estado: 'SIN_PLAN' })
  })

  it('con permiso de leer pero sin staffpay:close no puede activar ni desactivar; con permiso sólo en A no ve B (ni C)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    const e = await estado(OCT20, encargado)
    expect(e.sedes.map(s => s.venueId).sort()).toEqual([A, B].sort())
    expect(sedeDe(e, A)).toMatchObject({ estado: 'ACTIVA', puedeActivar: false, puedeDesactivar: false })
    // El mínimo se ve (se PODRÍA activar), pero él no puede.
    expect(sedeDe(e, B)).toMatchObject({ estado: 'SIN_ACTIVAR', minimo: '2026-10-01', puedeActivar: false, puedeDesactivar: false })
    expect((await estado(OCT20, soloA)).sedes.map(s => s.venueId)).toEqual([A])
  })

  it('sin activar la organización: periodo null, ceros y nada que activar', async () => {
    const e = await estado(OCT20)
    expect(e).toMatchObject({ activado: false, startDate: null, periodo: null })
    for (const s of e.sedes)
      expect(s).toMatchObject({ minimo: null, puedeActivar: false, puedeDesactivar: false, fueraEstePeriodo: cuenta() })
    expect(sedeDe(e, B).estado).toBe('SIN_ACTIVAR')
  })
})

describe('fueraEstePeriodo: lo de periodos SIN CERRAR que hoy no entra (ruling de B12 §5: el `entran` de activar desde el mínimo efectivo)', () => {
  it('dos clases de $500 de B sin activar ⇒ $1,000; una sin tabla no suma $0: pendientesDeValoracion 1; igual al `entran` de activar', async () => {
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-10T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-12T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    const b = sedeDe(await estado(OCT20), B)
    expect(b.fueraEstePeriodo).toEqual(cuenta({ clases: [2, '1000.00'] }))
    expect(b.fueraEstePeriodo).toEqual(await entranDesde(b.minimo!, OCT20))
    await prisma.servicePayTable.updateMany({ where: { venueId: B }, data: { productIds: [productoB] } })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-13T15:00:00Z', venueId: B, productId: m.productId, reservas: confirmadas(5) })
    const conExcepcion = sedeDe(await estado(OCT20), B)
    expect(conExcepcion.fueraEstePeriodo).toEqual(cuenta({ clases: [2, '1000.00', 1] }))
    expect(conExcepcion.fueraEstePeriodo).toEqual(await entranDesde(conExcepcion.minimo!, OCT20))
  })

  it('+$60 y su devolución −$60 ⇒ $0 (por neto, nunca por positivos)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    const t = await propinaB('2026-10-10T18:00:00Z', 60)
    await reembolso(m, t, { iso: '2026-10-12T18:00:00Z', propina: 60 })
    expect(sedeDe(await estado(OCT20), B).fueraEstePeriodo).toEqual(cuenta({ propinas: [2, '0.00'] }))
  })

  it('desde su mínimo EFECTIVO: lo de antes de su última ventana cerrada ya no puede entrar y no aparece', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-10-02T18:00:00Z', 40) // antes de su ventana: activarla hoy ya no la puede meter
    await propinaB('2026-10-07T18:00:00Z', 50) // dentro de su ventana del 5 al 10: entra
    await propinaB('2026-10-12T18:00:00Z', 60) // después: queda fuera y SÍ la puede meter (activar desde el 11-oct)
    await sedeActiva(m, B, '2026-10-05', '2026-10-10')
    const b = sedeDe(await estado(OCT20), B)
    expect(b).toMatchObject({ estado: 'SIN_ACTIVAR', minimo: '2026-10-11', fueraEstePeriodo: cuenta({ propinas: [1, '60.00'] }) })
    expect(b.fueraEstePeriodo).toEqual(await entranDesde('2026-10-11', OCT20))
  })

  it('B activada a media quincena: lo anterior a su `desde` aparece fuera; lo de después, no', async () => {
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-10-10T18:00:00Z', 60)
    await propinaB('2026-10-18T18:00:00Z', 70)
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-12T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await clase(m, { staffId: m.ana, inicioIso: '2026-10-17T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    await activarSede({ userId: m.owner, venueId: A, sedeId: B, desde: '2026-10-15', ahora: OCT20 })
    expect(sedeDe(await estado(OCT21), B)).toMatchObject({
      estado: 'ACTIVA',
      fueraEstePeriodo: cuenta({ clases: [1, '500.00'], propinas: [1, '60.00'] }),
    })
  })

  it('una venta de B en un periodo YA CERRADO no aparece (el dueño ya no puede hacer nada con ella)', async () => {
    await activar(m, { desde: '2026-09-01', sedes: [A], propinasDesde: '2026-09-01T06:00:00Z' })
    await propinaB('2026-09-10T18:00:00Z', 40)
    await periodoCerrado(m, '2026-09-01', '2026-09-30')
    await propinaB('2026-10-10T18:00:00Z', 60)
    const b = sedeDe(await estado(OCT20), B)
    expect(b).toMatchObject({ minimo: '2026-10-01', fueraEstePeriodo: cuenta({ propinas: [1, '60.00'] }) })
    expect(b.fueraEstePeriodo).toEqual(await entranDesde('2026-10-01', OCT20))
  })
})

describe('sin puerta de plan y una sola foto', () => {
  const porRuta = async (userId: string) => {
    let body: unknown = null
    let error: unknown = null
    const req = { params: { venueId: A }, query: {}, body: {}, authContext: { userId } } as unknown as Request
    await getSedes(req, { json: (b: unknown) => (body = b) } as unknown as Response, (e?: unknown) => (error = e ?? null))
    return { body: body as Awaited<ReturnType<typeof estadoSedes>> | null, error }
  }

  it('la sede que pide sin el plan (o ninguna con el plan) contesta igual: 200 con las sedes', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    ;(global as any).__sedes = [B]
    const r = await porRuta(m.owner)
    expect(r.error).toBeNull()
    expect(r.body?.sedes.find(s => s.venueId === A)).toMatchObject({ estado: 'ACTIVA_SIN_PLAN' })
    ;(global as any).__sedes = []
    expect((await porRuta(m.owner)).error).toBeNull()
  })

  it('desactivar B y vender ENTRE dos lecturas internas no mezcla: todo dice lo de antes; la siguiente lectura ya ve lo nuevo', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A, B], propinasDesde: '2026-10-01T06:00:00Z' })
    await propinaB('2026-10-10T18:00:00Z', 60)
    await propinaB('2026-10-17T18:00:00Z', 70)
    let corrio = false
    const e = await estadoSedes({
      userId: m.owner,
      venueId: A,
      ahora: NOV2,
      entreLecturas: async () => {
        await desactivarSede({ userId: m.owner, venueId: A, sedeId: B, hasta: '2026-10-15', ahora: NOV2 })
        await propinaB('2026-10-16T18:00:00Z', 5)
        await cobro(m, { iso: '2026-10-16T18:00:00Z', propina: 9, servedById: m.carla, venueId: C }) // C sin plan: fuera
        corrio = true
      },
    })
    expect(corrio).toBe(true)
    expect(sedeDe(e, B)).toMatchObject({ estado: 'ACTIVA', hasta: null, fueraEstePeriodo: cuenta() })
    expect(sedeDe(e, C).fueraEstePeriodo).toEqual(cuenta())
    expect(sedeDe(await estado(NOV2), C).fueraEstePeriodo).toEqual(cuenta({ propinas: [1, '9.00'] }))
    expect(sedeDe(await estado(NOV2), B)).toMatchObject({
      estado: 'SIN_ACTIVAR',
      hasta: '2026-10-15',
      minimo: '2026-10-16',
      fueraEstePeriodo: cuenta({ propinas: [2, '75.00'] }),
    })
  })
})

describe('el aviso de devoluciones pendientes del ajuste manual, por ruta y por MCP (r5.1)', () => {
  // Reloj real (la ruta y el MCP no pasan `ahora`): todo en julio y agosto de 2026, ya pasados.
  const preparar = async () => {
    await activar(m, { desde: '2026-07-01', sedes: [A, B], propinasDesde: '2026-07-01T06:00:00Z' })
    const enA = await cobro(m, { iso: '2026-07-10T18:00:00Z', propina: 50, servedById: m.carla })
    const enB = await propinaB('2026-07-11T18:00:00Z', 30)
    const ago2 = new Date('2026-08-02T12:00:00Z')
    const p = await previewCierre({ userId: m.owner, venueId: A, fecha: '2026-07-15', ahora: ago2 })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: A,
      fecha: '2026-07-15',
      ahora: ago2,
      confirmarHuerfanas: true,
      huellaEsperada: p.huella,
    })
    await reembolso(m, enA, { iso: '2026-08-10T18:00:00Z', propina: 50 })
    await reembolso(m, enB, { iso: '2026-08-11T18:00:00Z', propina: 30 })
  }
  const herramientas = (allowedVenueIds: string[]) => {
    const h = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    const acceso = { role: 'OWNER', corePermissions: ['staffpay:read', 'staffpay:close'] }
    const scope = {
      staffId: m.owner,
      activeOrg: m.orgId,
      scopes: ['mcp:read', 'mcp:write'],
      allowedVenueIds,
      perVenueAccess: new Map(allowedVenueIds.map(v => [v, acceso])),
    } as unknown as McpScope
    registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, scope)
    return h
  }

  it('la ruta devuelve avisoPendientes de esa persona en las sedes que el usuario lee; el MCP lo dice con la frase', async () => {
    await preparar()
    let body: any = null
    let error: unknown = null
    const req = {
      params: { venueId: A },
      query: { sede: A, staffId: m.carla, amount: -50, reason: 'Devolución de propina' },
      body: {},
      authContext: { userId: m.owner },
    } as unknown as Request
    await getAdjustmentPreview(req, { json: (b: unknown) => (body = b) } as unknown as Response, (e?: unknown) => (error = e ?? null))
    expect(error).toBeNull()
    expect(body.avisoPendientes).toMatchObject({ n: 2, total: '-80.00', truncado: false })
    expect(body.avisoPendientes.porDestino).toEqual([
      {
        seDescuenta: { tipo: 'AL_CERRAR', periodo: { start: '2026-08-01', end: '2026-08-31' } },
        n: 2,
        total: '-80.00',
        porSede: [
          { venueId: A, n: 1, total: '-50.00' },
          { venueId: B, n: 1, total: '-30.00' },
        ].sort((x, y) => (x.venueId < y.venueId ? -1 : 1)),
      },
    ])

    const r = await herramientas([A, B]).get('add_service_pay_adjustment')!(
      { venueId: A, staffId: m.carla, amount: -50, reason: 'Devolución de propina', idempotencyKey: 'clave-b13-1' },
      {},
    )
    const mcp = JSON.parse(r.content[0].text)
    expect(mcp).toMatchObject({ requiresConfirmation: true, preview: { avisoPendientes: { n: 2, total: '-80.00' } } })
    expect(mcp.message).toContain(
      'Carla QA tiene −$80.00 en devoluciones que se descontarán solas al cerrar el periodo de agosto de 2026. Si este ajuste es por eso, no lo registres.',
    )
  })

  it('el MCP lo acota a las sedes de la CONEXIÓN, aunque el usuario lea más', async () => {
    await preparar()
    const r = await herramientas([A]).get('add_service_pay_adjustment')!(
      { venueId: A, staffId: m.carla, amount: -50, reason: 'Devolución de propina', idempotencyKey: 'clave-b13-2' },
      {},
    )
    const mcp = JSON.parse(r.content[0].text)
    expect(mcp.preview.avisoPendientes).toMatchObject({ n: 1, total: '-50.00' })
    expect(mcp.preview.avisoPendientes.items.map((i: { venueId: string }) => i.venueId)).toEqual([A])
    expect(mcp.message).toContain('Carla QA tiene −$50.00 en devoluciones')
  })
})

describe('MCP: las sedes de la pantalla 1 en `staff_service_pay_config` y los montos de `accion: "sede"`', () => {
  it('config trae las sedes del service acotadas a la conexión; la vista previa de una sede trae los montos de la ruta', async () => {
    await tablaFija(m, B, 500)
    await activar(m, { desde: '2026-08-01', sedes: [A], propinasDesde: null })
    await clase(m, { staffId: m.ana, inicioIso: '2026-08-20T15:00:00Z', venueId: B, productId: productoB, reservas: confirmadas(5) })
    const h = new Map<string, (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>>()
    const acceso = { role: 'OWNER', corePermissions: ['staffpay:read', 'staffpay:close'] }
    const scope = {
      staffId: m.owner,
      activeOrg: m.orgId,
      scopes: ['mcp:read', 'mcp:write'],
      allowedVenueIds: [A, B], // sin C
      perVenueAccess: new Map([
        [A, acceso],
        [B, acceso],
      ]),
    } as unknown as McpScope
    registerStaffPayTools({ tool: (...a: unknown[]) => h.set(a[0] as string, a[a.length - 1] as never) } as never, scope)

    const config = JSON.parse((await h.get('staff_service_pay_config')!({ venueId: A }, {})).content[0].text)
    const service = await estadoSedes({ userId: m.owner, venueId: A, soloSedes: [A, B] })
    expect(config.sedes).toEqual(service.sedes)
    expect(config.sedes.map((s: { venueId: string }) => s.venueId).sort()).toEqual([A, B].sort())
    expect(config.sedes.find((s: { venueId: string }) => s.venueId === B).fueraEstePeriodo).toEqual(cuenta({ clases: [1, '500.00'] }))

    const r = JSON.parse(
      (await h.get('configure_service_pay')!({ venueId: A, accion: 'sede', sede: B, activa: true, fecha: '2026-08-01' }, {})).content[0]
        .text,
    )
    expect(r.preview).toEqual(
      await vistaPreviaParticipacion({ userId: m.owner, venueId: A, sedeId: B, accion: 'activar', fecha: '2026-08-01' }),
    )
    expect(r.preview.entran).toEqual(cuenta({ clases: [1, '500.00'] }))
  })
})

describe('revisión de B12 que se cierra en B13', () => {
  it('#1 la vista previa del cierre lleva el timeout del cierre; si su foto vence, 409 LECTURA_VENCIDA (nunca P2028/500)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    const real = foto.enUnaFoto
    const espia = jest.spyOn(foto, 'enUnaFoto')
    await previewCierre({ userId: m.owner, venueId: A, fecha: OCT, ahora: NOV2 })
    expect(espia).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ planPersonalizado: true, timeoutMs: TIMEOUT_CIERRE_MS }),
    )
    espia.mockImplementation(((fn: any, o: any) => real(fn, { ...o, timeoutMs: 300 })) as any)
    await expect(
      previewCierre({ userId: m.owner, venueId: A, fecha: OCT, ahora: NOV2, entreLecturas: async () => void (await dormir(900)) }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LECTURA_VENCIDA' })
  })

  it('#4 dos vistas previas sin permiso no comparten el objeto de pendientes (fábrica, no un objeto de módulo)', async () => {
    await activar(m, { desde: '2026-10-01', sedes: [A], propinasDesde: null })
    const p1 = await previewCierre({ userId: encargado, venueId: A, fecha: OCT, ahora: NOV2 })
    expect(p1.bloqueos).toEqual([{ codigo: 'SIN_PERMISO' }])
    ;(p1.pendientes.porDestino as unknown[]).push({ ensuciado: true })
    const p2 = await previewCierre({ userId: encargado, venueId: A, fecha: OCT, ahora: NOV2 })
    expect(p2.pendientes).toEqual({ n: 0, total: '0.00', porDestino: [] })
  })

  it('#5 el recibo calcula las pendientes sólo en su primera página (sin cursor); las siguientes traen null', async () => {
    await activar(m, { desde: '2026-07-01', sedes: [A], propinasDesde: '2026-07-01T06:00:00Z' })
    const julio = await cobro(m, { iso: '2026-07-10T18:00:00Z', propina: 50, servedById: m.carla })
    const ago2 = new Date('2026-08-02T12:00:00Z')
    const p = await previewCierre({ userId: m.owner, venueId: A, fecha: '2026-07-15', ahora: ago2 })
    await cerrarPeriodo({
      userId: m.owner,
      venueId: A,
      fecha: '2026-07-15',
      ahora: ago2,
      confirmarHuerfanas: true,
      huellaEsperada: p.huella,
    })
    await reembolso(m, julio, { iso: '2026-09-05T18:00:00Z', propina: 50 }) // septiembre: pendiente del recibo de agosto
    await cobro(m, { iso: '2026-08-12T18:00:00Z', propina: 20, servedById: m.carla })
    await cobro(m, { iso: '2026-08-13T18:00:00Z', propina: 30, servedById: m.carla })
    const espia = jest.spyOn(pendientesMod, 'devolucionesPendientes')
    const pagina = (cursor?: string) =>
      reciboDePersona({ userId: m.owner, venueId: A, staffId: m.carla, fecha: '2026-08-15', cursor, limit: 1 })
    const p1 = await pagina()
    expect(p1.pendientes).toMatchObject({ n: 1, total: '-50.00' })
    expect(p1.siguiente).not.toBeNull()
    const p2 = await pagina(p1.siguiente!)
    expect(p2.renglones).toHaveLength(1)
    expect(p2.pendientes).toBeNull()
    expect(espia).toHaveBeenCalledTimes(1)
  })
})
