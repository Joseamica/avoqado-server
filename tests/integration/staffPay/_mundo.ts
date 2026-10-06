// tests/integration/staffPay/_mundo.ts — fixtures de la fase 2. Cada archivo crea su propio mundo con una llave única.
import { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { fechaComoDbDate } from '@/services/dashboard/staffPay/periodos'
import { lockClase, lockPeriodosDeOrganizacion } from '@/services/dashboard/staffPay/periodosGuardados'

export const TZ = 'America/Mexico_City'
export const PN_HC = [0, 430, 430, 430, 430, 460, 490, 530, 570, 610, 650]
export const PN_C = [0, 400, 400, 400, 400, 400, 400, 440, 480, 520, 560]

export interface Mundo {
  key: string
  orgId: string
  venueId: string
  productId: string
  hc: string
  coach: string
  ana: string
  sofia: string
  carla: string
  owner: string
}

export async function crearSede(orgId: string, key: string, s: string) {
  const v = await prisma.venue.create({ data: { organizationId: orgId, name: `${key}-${s}`, slug: `${key}-${s}`, timezone: TZ } })
  const cat = await prisma.menuCategory.create({ data: { venueId: v.id, name: 'Clases', slug: `${key}-${s}-c`, availableDays: [] } })
  const p = await prisma.product.create({
    data: {
      venueId: v.id,
      categoryId: cat.id,
      sku: `${key}-${s}-p`,
      name: 'Reformer',
      type: 'CLASS',
      price: new Prisma.Decimal(300),
      duration: 50,
      maxParticipants: 10,
      tags: [],
      allergens: [],
    },
  })
  return { venueId: v.id, productId: p.id }
}

export async function crearMundo(nombre: string): Promise<Mundo> {
  const key = `${nombre}-${process.pid}-${Date.now()}`
  const org = await prisma.organization.create({ data: { name: key, slug: key, email: `${key}@example.test`, phone: '5500000000' } })
  const { venueId, productId } = await crearSede(org.id, key, 'pn')
  const mk = async (n: string) =>
    (await prisma.staff.create({ data: { email: `${key}-${n}@example.test`, firstName: n, lastName: 'QA', active: true } })).id
  const [ana, sofia, carla, owner] = [await mk('Ana'), await mk('Sofia'), await mk('Carla'), await mk('Owner')]
  await prisma.staffVenue.createMany({
    data: [
      ...[ana, sofia, carla].map(staffId => ({ staffId, venueId, role: 'MANAGER' as const, active: true })),
      { staffId: owner, venueId, role: 'OWNER' as const, active: true },
    ],
  })
  const hc = (await prisma.staffPayLevel.create({ data: { organizationId: org.id, name: 'Head Coach', sortOrder: 0 } })).id
  const coach = (await prisma.staffPayLevel.create({ data: { organizationId: org.id, name: 'Coach', sortOrder: 1 } })).id
  const desde = fechaComoDbDate('2026-01-01')
  await prisma.staffPayLevelAssignment.createMany({
    data: [
      { organizationId: org.id, staffId: ana, payLevelId: hc, effectiveFrom: desde, revision: 1 },
      { organizationId: org.id, staffId: sofia, payLevelId: coach, effectiveFrom: desde, revision: 1 },
      { organizationId: org.id, staffId: carla, payLevelId: coach, effectiveFrom: desde, revision: 1 },
    ],
  })
  return { key, orgId: org.id, venueId, productId, hc, coach, ana, sofia, carla, owner }
}

/** Orden obligado por las FKs Restrict: devengos y recibos → sedes (borra clases y anclas) → periodos → org. */
export async function borrarMundo(m: Mundo | undefined) {
  if (!m?.orgId) return
  await prisma.serviceEarning.deleteMany({ where: { organizationId: m.orgId } })
  await prisma.staffPayStatement.deleteMany({ where: { period: { organizationId: m.orgId } } })
  // Fase 3: ventas de las pruebas del sobre. `Payment` frena el borrado de la sede (Restrict) y las comisiones y sus
  // esquemas el de la persona: van antes que las sedes y que el staff.
  const deLaOrg = { venue: { organizationId: m.orgId } }
  await prisma.commissionCalculation.deleteMany({ where: deLaOrg })
  await prisma.commissionConfig.deleteMany({ where: deLaOrg })
  await prisma.payment.deleteMany({ where: deLaOrg })
  await prisma.order.deleteMany({ where: deLaOrg })
  await prisma.venue.deleteMany({ where: { organizationId: m.orgId } })
  await prisma.servicePayPeriod.deleteMany({ where: { organizationId: m.orgId } })
  await prisma.staffPayLevelAssignment.deleteMany({ where: { organizationId: m.orgId } })
  await prisma.staffPayLevel.deleteMany({ where: { organizationId: m.orgId } })
  await prisma.staff.deleteMany({ where: { email: { startsWith: m.key } } })
  await prisma.organization.delete({ where: { id: m.orgId } })
}

/** La tabla real de Mindform Prado Norte (techo 10), vigente desde `desde`. */
export async function tablaMindform(m: Mundo, venueId = m.venueId, desde = '2026-01-01') {
  const t = await prisma.servicePayTable.create({ data: { venueId, name: 'Todas las clases', productIds: [] } })
  const v = await prisma.servicePayTableVersion.create({
    data: { tableId: t.id, effectiveFrom: fechaComoDbDate(desde), revision: 1, maxCount: 10 },
  })
  await prisma.servicePayTableCell.createMany({
    data: [
      ...PN_HC.map((a, count) => ({ versionId: v.id, payLevelId: m.hc, count, amount: new Prisma.Decimal(a) })),
      ...PN_C.map((a, count) => ({ versionId: v.id, payLevelId: m.coach, count, amount: new Prisma.Decimal(a) })),
    ],
  })
  return { tableId: t.id, versionId: v.id }
}

let seq = 0
export const confirmadas = (n: number) => Array.from({ length: n }, () => ({ status: 'CONFIRMED' }))

export async function clase(
  m: Mundo,
  o: {
    staffId: string | null
    inicioIso: string
    reservas?: Array<{ status: string; partySize?: number; confirmed?: boolean }>
    venueId?: string
    productId?: string
    status?: 'CANCELLED'
  },
) {
  const venueId = o.venueId ?? m.venueId
  const productId = o.productId ?? m.productId
  const startsAt = new Date(o.inicioIso)
  const endsAt = new Date(startsAt.getTime() + 50 * 60000)
  const cs = await prisma.classSession.create({
    data: { venueId, productId, startsAt, endsAt, duration: 50, capacity: 12, assignedStaffId: o.staffId, status: o.status ?? 'SCHEDULED' },
  })
  const reservas = o.reservas ?? []
  if (reservas.length) {
    await prisma.reservation.createMany({
      data: reservas.map(r => ({
        venueId,
        classSessionId: cs.id,
        productId,
        confirmationCode: `${m.key}-${++seq}`,
        status: r.status as any,
        startsAt,
        endsAt,
        duration: 50,
        blockedEndsAt: endsAt,
        partySize: r.partySize ?? 1,
        confirmedAt: r.confirmed === false ? null : new Date(startsAt.getTime() - 86400000),
      })),
    })
  }
  return cs.id
}

/** Un periodo ya cerrado, creado a mano (para probar guardas y lecturas sin pasar por el cierre). */
export async function periodoCerrado(m: Mundo, start: string, end: string) {
  return prisma.servicePayPeriod.create({
    data: {
      organizationId: m.orgId,
      periodStart: fechaComoDbDate(start),
      periodEnd: fechaComoDbDate(end),
      status: 'CLOSED',
      venueIds: [m.venueId],
      closedAt: new Date(),
      closedById: m.owner,
      closeFingerprint: 'manual',
    },
  })
}

/**
 * Barrera REAL para las pruebas de carrera (Codex R2-R1-15): `Promise.allSettled` no garantiza que dos operaciones se
 * crucen. Un cliente aparte («bloqueador») toma el candado del periodo; las operaciones se lanzan y se quedan esperando
 * ESE candado; un «observador» las ve en `pg_stat_activity`; sólo entonces se suelta. Mismo patrón que
 * `tests/integration/master-catalog/catalogPublicationIntegrationHarness.ts` (`waitForLockWaiter`).
 * El periodo tiene que EXISTIR antes (las dos operaciones lo encuentran y se detienen en su `SELECT … FOR UPDATE`).
 *
 * Codex R3-Nuevo 4: sólo cuentan las sesiones que esperan el candado de ESTE bloqueador, identificado por su
 * `pg_backend_pid()`, nunca «cualquier sesión esperando algo» en la base. Se cuenta la CADENA de espera que nace en él:
 * con un candado de fila, la primera sesión espera al bloqueador y la segunda espera a la primera (`pg_blocking_pids`
 * de la segunda no trae al bloqueador), así que una búsqueda recursiva desde su pid es lo que ve a las dos.
 */
export const barreraDelPeriodo = (periodId: string) =>
  barrera(t => t.$queryRaw`SELECT id FROM "ServicePayPeriod" WHERE id = ${periodId} FOR UPDATE`)

/** La misma barrera sobre el candado de UNA clase (`lockClase`): quien llega ahí ya tiene SU periodo tomado (B2). */
export const barreraDeLaClase = (classSessionId: string) => barrera(t => lockClase(t, classSessionId))

/** La misma barrera sobre el candado de periodos de la ORGANIZACIÓN (activar, propinas, crear periodos). */
export const barreraDeLaOrganizacion = (organizationId: string) => barrera(t => lockPeriodosDeOrganizacion(t, organizationId))

async function barrera(tomar: (t: Prisma.TransactionClient) => Promise<unknown>) {
  const url = process.env.DATABASE_URL
  const bloqueador = new PrismaClient({ datasources: { db: { url } } })
  const observador = new PrismaClient({ datasources: { db: { url } } })
  let soltarTx!: () => void
  let tomado!: (pid: number) => void
  const suelto = new Promise<void>(r => (soltarTx = r))
  const listo = new Promise<number>(r => (tomado = r))
  const tx = bloqueador.$transaction(
    async t => {
      const [{ pid }] = await t.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await tomar(t)
      tomado(pid)
      await suelto
    },
    { maxWait: 10_000, timeout: 60_000 },
  )
  const pidBloqueador = await Promise.race([listo, tx.then(() => -1)])
  if (pidBloqueador < 0) throw new Error('La barrera no pudo tomar su candado')
  let cerrada = false
  return {
    /** Espera hasta ver `n` sesiones detenidas por el candado de ESTE bloqueador (directa o en cadena). */
    async esperarA(n: number) {
      const limite = Date.now() + 15_000
      for (;;) {
        const [{ esperando }] = await observador.$queryRaw<Array<{ esperando: number }>>`
          WITH RECURSIVE espera(pid) AS (
            SELECT a.pid FROM pg_stat_activity a WHERE pg_blocking_pids(a.pid) @> ARRAY[${pidBloqueador}::int]
            UNION
            SELECT a.pid FROM pg_stat_activity a JOIN espera e ON pg_blocking_pids(a.pid) @> ARRAY[e.pid]
          )
          SELECT COUNT(*)::int AS esperando FROM espera`
        if (esperando >= n) return
        if (Date.now() > limite) throw new Error(`La barrera esperaba ${n} sesiones detenidas por su candado y vio ${esperando}`)
        await new Promise(r => setTimeout(r, 10))
      }
    },
    /** Suelta el candado y cierra los dos clientes. Se puede llamar más de una vez (va en un `finally`). */
    async soltar() {
      if (cerrada) return
      cerrada = true
      soltarTx()
      await tx
      await Promise.all([bloqueador.$disconnect(), observador.$disconnect()])
    },
  }
}
