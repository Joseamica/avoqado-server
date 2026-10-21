// tests/integration/staffPay/_participacion.ts — lo compartido por las pruebas de participación por sede (fase 3, B9).
//
// Cada archivo llama `prepararParticipacion(nombre)` una vez, en su nivel superior: registra su `beforeEach`/`afterEach`
// (un mundo nuevo por prueba, y la limpieza de lo que la prueba dejó) y devuelve las utilidades atadas a ese mundo. El
// `jest.mock` de `acceso` va en cada archivo (jest lo sube al inicio de SU archivo).
import type { Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { transferVenue } from '@/controllers/dashboard/venues.superadmin.controller'
import { activarPagoAlPersonal } from '@/services/dashboard/staffPay/activacion.service'
import { agregarAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import * as participacion from '@/services/dashboard/staffPay/participacion'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { borrarMundo, crearMundo, crearSede, Mundo } from './_mundo'

export const AHORA = new Date('2026-09-02T12:00:00Z') // agosto ya terminó en CDMX; septiembre abierto
export const ACTIVA_EL = new Date('2026-09-20T18:00:00Z') // activar el 20-sep: mensual ⇒ desde el 1-sep
export const OPERACION_EN_CURSO = {
  statusCode: 409,
  code: 'OPERACION_EN_CURSO',
  message: 'Otra operación está cambiando esta sede o su organización; intenta de nuevo en un momento',
}
export const DEMO_RECHAZADA = { statusCode: 409, code: 'LIVE_DEMO_CON_PAGO_AL_PERSONAL' }
export const dormir = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Resultado de una operación sin que la prueba truene: su valor o su error, y cuánto tardó. */
export async function resultado<T>(p: Promise<T>): Promise<{ valor: T | null; error: any; ms: number }> {
  const t = Date.now()
  return p.then(
    valor => ({ valor, error: null, ms: Date.now() - t }),
    (error: unknown) => ({ valor: null, error, ms: Date.now() - t }),
  )
}

/**
 * Espera a ver una sesión DETENIDA por un candado que retiene `pid` (directa o en cadena: la recursión de `esperarA` de
 * `_mundo.ts`, Codex R3-Nuevo 4), nunca «cualquier sesión esperando algo» en la base compartida. Devuelve false si no hay
 * `pid` (la operación terminó sin llegar a su pausa) o si `mientras` deja de cumplirse (la otra terminó sin detenerse).
 */
export async function esperarDetenidaPor(pid: number | null, mientras: () => boolean): Promise<boolean> {
  if (pid === null) return false
  const limite = Date.now() + 15_000
  for (;;) {
    if (!mientras()) return false
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      WITH RECURSIVE espera(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE pg_blocking_pids(a.pid) @> ARRAY[${pid}::int]
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN espera e ON pg_blocking_pids(a.pid) @> ARRAY[e.pid]
      )
      SELECT COUNT(*)::int AS n FROM espera`
    if (n > 0) return true
    if (Date.now() > limite) throw new Error(`Nadie quedó detenido por la sesión ${pid}`)
    await dormir(10)
  }
}

export function prepararParticipacion(nombre: string) {
  const c = {
    m: undefined as unknown as Mundo,
    orgsExtra: [] as string[],
    espias: [] as jest.SpyInstance[],
    /** Pausas que una prueba fallida dejó puestas: se sueltan antes de limpiar (si no, la limpieza espera sus candados). */
    sueltas: [] as Array<() => void>,
    n: 0,
  }
  beforeEach(async () => {
    c.m = await crearMundo(nombre)
    ;(global as any).__sedes = [c.m.venueId]
  })
  afterEach(async () => {
    for (const soltar of c.sueltas.splice(0)) soltar()
    for (const e of c.espias.splice(0)) e.mockRestore()
    for (const id of c.orgsExtra.splice(0)) {
      // Una sede trasladada ya no la borra `borrarMundo` (es de la otra organización).
      await prisma.serviceEarning.deleteMany({ where: { organizationId: id } })
      await prisma.venue.deleteMany({ where: { organizationId: id } })
      await prisma.staffOrganization.deleteMany({ where: { organizationId: id } })
      await prisma.organization.deleteMany({ where: { id } })
    }
    await borrarMundo(c.m)
  })

  const m = () => c.m

  async function otraOrg(s: string) {
    const o = await prisma.organization.create({
      data: { name: `${c.m.key}-${s}`, slug: `${c.m.key}-${s}`, email: `${c.m.key}-${s}@example.test`, phone: '5500000000' },
    })
    c.orgsExtra.push(o.id)
    return o.id
  }

  /** Una sucursal demo desechable (LIVE_DEMO), con su visitante y su sesión ya caducada. */
  async function demo(s: string) {
    const { venueId, productId } = await crearSede(c.m.orgId, c.m.key, s)
    await prisma.venue.update({ where: { id: venueId }, data: { status: 'LIVE_DEMO' } })
    const visitante = await prisma.staff.create({
      data: { email: `${c.m.key}-${s}-visitante@example.test`, firstName: 'Visitante', lastName: s, active: true },
    })
    const sesion = await prisma.liveDemoSession.create({
      data: { sessionId: `${c.m.key}-${s}`, venueId, staffId: visitante.id, expiresAt: new Date(Date.now() - 60_000) },
    })
    return { venueId, productId, visitante: visitante.id, sesion: { id: sesion.id, venueId, staffId: visitante.id } }
  }

  const periodo = (start: string, end: string, venueIds: string[], status: 'OPEN' | 'CLOSED' = 'OPEN') =>
    prisma.servicePayPeriod.create({
      data: {
        organizationId: c.m.orgId,
        periodStart: fechaComoDbDate(start),
        periodEnd: fechaComoDbDate(end),
        venueIds,
        status,
        ...(status === 'CLOSED' ? { closedAt: new Date(), closedById: c.m.owner, closeFingerprint: 'manual' } : {}),
      },
    })

  const activar = () => activarPagoAlPersonal({ userId: c.m.owner, venueId: c.m.venueId, periodicidad: 'MONTHLY', ahora: ACTIVA_EL })
  const ajuste = (sede: string, amount = 50) =>
    agregarAjusteManual({
      userId: c.m.owner,
      venueId: c.m.venueId,
      sede,
      staffId: c.m.ana,
      amount,
      reason: 'Bono de prueba B9',
      fecha: '2026-08-20',
      clientKey: `${c.m.key}-aj-${++c.n}`,
      ahora: AHORA,
    })

  /** El controlador REAL del traslado, sin HTTP: el error que pasó a `next`, o `{ status, body }`. */
  async function trasladar(venueId: string, targetOrganizationId: string): Promise<any> {
    let error: unknown = null
    let status = 0
    let body: unknown = null
    const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as unknown as Response
    const req = { params: { venueId }, body: { targetOrganizationId }, authContext: { userId: c.m.owner } } as unknown as Request
    await transferVenue(req, res, (e?: unknown) => (error = e))
    return error ?? { status, body }
  }

  /**
   * Pausa la PRIMERA llamada a `participacion[nombre]` DESPUÉS de que hizo su trabajo (con sus candados tomados) y avisa el
   * `pg_backend_pid` de su transacción (el primer argumento), para esperar EXACTAMENTE a quien detiene. `hasta`: con la
   * promesa de la operación, `llego` da null si terminó sin pasar por la pausa (una mutación que ya no llega ahí).
   */
  function pausarDespuesDe(nombre: 'bloquearSedesDeLaOrganizacion' | 'historiaDeSede') {
    let soltar!: () => void
    const suelto = new Promise<void>(r => (soltar = r))
    let avisar!: (pid: number) => void
    const llego = new Promise<number>(r => (avisar = r))
    const real = (participacion as any)[nombre]
    const espia = jest.spyOn(participacion, nombre)
    c.espias.push(espia)
    espia.mockImplementationOnce((async (...a: unknown[]) => {
      const r = await real(...a)
      const [{ pid }] = await (a[0] as Prisma.TransactionClient).$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      avisar(pid)
      await suelto
      return r
    }) as any)
    c.sueltas.push(() => soltar())
    return { hasta: (op: Promise<unknown>) => Promise.race([llego, op.then(() => null)]), soltar: () => soltar() }
  }

  /** El invariante de B9: ningún devengo de una sede que ya no existe o que ya es de otra organización. */
  async function devengosHuerfanos(): Promise<number> {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM "ServiceEarning" e
      WHERE e."organizationId" = ${c.m.orgId}
        AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v.id = e."venueId" AND v."organizationId" = e."organizationId")`
    return n
  }

  const sedeDe = (venueId: string) => prisma.venue.findUnique({ where: { id: venueId }, select: { organizationId: true, status: true } })
  const devengosDe = (venueId: string) => prisma.serviceEarning.findMany({ where: { venueId }, select: { amount: true }, take: 10 })

  /** La demo sigue completa: su sede (de la organización y LIVE_DEMO), su visitante y su sesión. */
  async function demoIntacta(d: Awaited<ReturnType<typeof demo>>) {
    expect(await sedeDe(d.venueId)).toMatchObject({ organizationId: c.m.orgId, status: 'LIVE_DEMO' })
    expect(await prisma.staff.count({ where: { id: d.visitante } })).toBe(1)
    expect(await prisma.liveDemoSession.count({ where: { id: d.sesion.id } })).toBe(1)
  }

  /** Limita la limpieza de demos a las sesiones de ESTA prueba: la base es compartida. */
  function soloEstasDemos(ids: string[]) {
    const realFindMany = prisma.liveDemoSession.findMany.bind(prisma.liveDemoSession)
    c.espias.push(
      jest
        .spyOn(prisma.liveDemoSession, 'findMany')
        .mockImplementation(((a: any) => realFindMany({ ...a, where: { AND: [a?.where ?? {}, { id: { in: ids } }] } })) as any),
    )
  }

  return {
    m,
    espiar: (e: jest.SpyInstance) => c.espias.push(e),
    otraOrg,
    demo,
    periodo,
    activar,
    ajuste,
    trasladar,
    pausarDespuesDe,
    devengosHuerfanos,
    sedeDe,
    devengosDe,
    demoIntacta,
    soloEstasDemos,
  }
}
