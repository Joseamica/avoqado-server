/**
 * Load seed to measure «Clientes» (plan C1, task 17 step 5.1) at 10× and 100× production. It ONLY runs against a disposable
 * copy whose name starts with `av-db-25-crm-c1-carga` (it prints the database and the URL, password hidden, before writing
 * anything), and it only ever adds rows: ids come from Prisma's `@default(cuid())` (cuid v1), never made up.
 *
 *   USE_RENDER_DB=false DATABASE_URL=<copy> npx tsx scripts/crm/carga-clientes.ts --factor 10 [--vendedor <staffId>]
 *
 * Per factor unit (production measured on 2-nov / 3-nov): 27 client organizations with 148 venues, plus ~10 % signups
 * without a card (3 organizations, one venue each). The two worst shapes of task 2 are in every unit — one organization
 * with 60 venues (and block 0's grows by 6 × factor more) and 7 venues with 400 orders; the rest of the venues share the
 * ≈ 60 orders per venue in 30 days (TPV 46 %, AVOQADO_ANDROID 44 %, DASHBOARD_MANUAL 10 %), each charged order with its
 * `Payment` (`TPV`+terminal / `APP` / `OTHER`). Every venue has a terminal and every other one a POS; the plan rows cycle
 * through the states of task 2's table (paid, Premium, trial with and without card, suspended, grace, cancelled, comp,
 * none). ≈ 5 % of the venues also take reservation orders (`TPV` with `reservationId`) charged from `TPV`, `APP` and
 * `OTHER`. Three organizations per unit stopped charging 35–90 days ago and one never charged (it pays a plan).
 * `--vendedor`: the «propios» seller that owns a third of the accounts (and its scope then sees rows).
 *
 * ponytail: no hybrid contracts nor launch-campaign redemptions are seeded (prod has a handful; their SQL is per page).
 */
import { OrderSource, PaymentMethod, PaymentSource, Prisma, PrismaClient, TerminalType } from '@prisma/client'

const DAY = 86_400_000
const LOTE = 5000
const MOTIVOS = ['PRECIO', 'NO_QUISO_TARJETA', 'SOLO_VEIA', 'OTRO_SISTEMA', 'PROBLEMA_TECNICO', 'DESPUES', null] as const

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const factor = Number(option('--factor'))
if (!Number.isInteger(factor) || factor < 1 || factor > 200) {
  console.error('Uso: --factor <1..200>')
  process.exit(1)
}
const vendedor = option('--vendedor') ?? null
const url = process.env.DATABASE_URL ?? ''
const prisma = new PrismaClient({ datasourceUrl: url })
const now = Date.now()
const hace = (ms: number) => new Date(now - ms)
const tag = `carga${factor}x${now.toString(36)}`

async function inBatches<T>(rows: T[], write: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += LOTE) await write(rows.slice(i, i + LOTE))
}

async function main() {
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`SELECT current_database() AS db`
  console.log(`base: ${db}`)
  console.log(`url:  ${url.replace(/:[^:@/]*@/, ':<oculto>@')}`)
  if (!db.startsWith('av-db-25-crm-c1-carga')) throw new Error(`ABORTO: ${db} no es una base de carga`)

  const [pro, premium] = await Promise.all(
    ['PLAN_PRO', 'PLAN_PREMIUM'].map(code => prisma.feature.findUniqueOrThrow({ where: { code }, select: { id: true } })),
  )
  const abierta = await prisma.crmStage.findFirstOrThrow({ where: { kind: 'ABIERTA' }, orderBy: { order: 'asc' }, select: { id: true } })

  // 1. Organizations: 27 clients + 3 signups per unit.
  type OrgSpec = { kind: 'cobra' | 'sinCobros' | 'nunca' | 'alta'; venues: number; i: number; block: number }
  const specs: OrgSpec[] = []
  for (let block = 0; block < factor; block++) {
    const sizes = [60 + (block === 0 ? 6 * factor : 0), 20, 20, ...Array(24).fill(2)]
    sizes.forEach((venues, i) => specs.push({ block, i, venues, kind: i === 26 ? 'nunca' : i >= 23 ? 'sinCobros' : 'cobra' }))
    for (let i = 27; i < 30; i++) specs.push({ block, i, venues: 1, kind: 'alta' })
  }
  const emailOf = (s: OrgSpec) => `${tag}-b${s.block}-o${s.i}@carga.invalid`
  const orgByEmail = new Map<string, string>()
  await inBatches(specs, async batch => {
    for (const made of await prisma.organization.createManyAndReturn({
      data: batch.map(s => ({
        name: `Carga ${tag} b${s.block} o${s.i}`,
        email: emailOf(s),
        phone: '5555555555',
        createdAt: hace((s.block * 30 + s.i) * 3_600_000),
      })),
      select: { id: true, email: true },
    }))
      orgByEmail.set(made.email, made.id)
  })
  // RETURNING's order is not a contract: every id is matched back by its unique key.
  const orgs = specs.map(s => ({ id: orgByEmail.get(emailOf(s))! }))
  console.log(`organizaciones: ${orgs.length}`)

  // 2. Venues (createdAt older than every order) and their devices.
  type VenueSpec = { organizationId: string; spec: OrgSpec; k: number }
  const venueSpecs: VenueSpec[] = specs.flatMap((spec, o) =>
    Array.from({ length: spec.venues }, (_, k) => ({ organizationId: orgs[o].id, spec, k })),
  )
  const slugOf = (v: VenueSpec) => `${tag}-b${v.spec.block}-o${v.spec.i}-s${v.k}`
  const venueBySlug = new Map<string, string>()
  await inBatches(venueSpecs, async batch => {
    for (const made of await prisma.venue.createManyAndReturn({
      data: batch.map(v => ({
        organizationId: v.organizationId,
        name: `Sucursal ${v.k} b${v.spec.block} o${v.spec.i}`,
        slug: slugOf(v),
        status: 'ACTIVE' as const,
        createdAt: hace(120 * DAY),
      })),
      select: { id: true, slug: true },
    }))
      venueBySlug.set(made.slug, made.id)
  })
  const venues = venueSpecs.map(v => ({ id: venueBySlug.get(slugOf(v))! }))
  console.log(`sucursales: ${venues.length}`)
  const terminalOf = new Map<string, string>()
  await inBatches(
    venues.flatMap((v, j) => [
      { venueId: v.id, name: `TPV ${j}`, type: TerminalType.TPV_ANDROID, serialNumber: `${tag}-t${j}` },
      ...(j % 2 === 0 ? [{ venueId: v.id, name: `POS ${j}`, type: TerminalType.POS_ANDROID, serialNumber: `${tag}-p${j}` }] : []),
    ]),
    async batch => {
      const made = await prisma.terminal.createManyAndReturn({ data: batch, select: { id: true, venueId: true, type: true } })
      for (const t of made) if (t.type === TerminalType.TPV_ANDROID) terminalOf.set(t.venueId, t.id)
    },
  )

  // 3. Plan rows: the states of task 2's table, by venue; a signup keeps the 5-day trial its venue was born with.
  const planRows: Prisma.VenueFeatureCreateManyInput[] = []
  venueSpecs.forEach((v, j) => {
    const venueId = venues[j].id
    const sub = `sub_${tag}_${j}`
    const base = { venueId, featureId: pro.id, monthlyPrice: 999, startDate: hace(60 * DAY) }
    if (v.spec.kind === 'alta') return planRows.push({ ...base, active: true, endDate: new Date(now + 5 * DAY) })
    if (v.spec.kind === 'nunca') return planRows.push({ ...base, active: true, stripeSubscriptionId: sub })
    const tipo = j % 9
    if (tipo === 0) planRows.push({ ...base, active: true, stripeSubscriptionId: sub })
    if (tipo === 1) planRows.push({ ...base, featureId: premium.id, monthlyPrice: 1699, active: true, stripeSubscriptionId: sub })
    if (tipo === 2) planRows.push({ ...base, active: true, endDate: new Date(now + 10 * DAY), stripeSubscriptionId: sub })
    if (tipo === 3) planRows.push({ ...base, active: true, endDate: new Date(now + 3 * DAY) })
    if (tipo === 4) planRows.push({ ...base, active: false, suspendedAt: hace(5 * DAY), stripeSubscriptionId: sub })
    if (tipo === 5)
      planRows.push({
        ...base,
        active: true,
        gracePeriodEndsAt: new Date(now + 3 * DAY),
        paymentFailureCount: 1,
        stripeSubscriptionId: sub,
      })
    if (tipo === 6) planRows.push({ ...base, active: false, endDate: hace(10 * DAY) })
    if (tipo === 7) planRows.push({ ...base, active: true })
  })
  await inBatches(planRows, batch => prisma.venueFeature.createMany({ data: batch }))
  console.log(`filas de plan: ${planRows.length}`)

  // 4. Signups without a card and the CRM accounts (a third owned by the «propios» seller).
  const altas = specs.flatMap((s, o) => (s.kind === 'alta' ? [orgs[o].id] : []))
  await inBatches(altas, batch =>
    prisma.onboardingProgress.createMany({
      data: batch.map((organizationId, i) => ({ organizationId, completedSteps: [], acquisitionSource: i % 2 ? 'landing' : 'directo' })),
    }),
  )
  const cuentas = orgs.flatMap((org, o) => (o % 2 === 0 || specs[o].kind === 'alta' ? [{ org, o }] : []))
  await inBatches(cuentas, batch =>
    prisma.crmAccount.createMany({
      data: batch.map(({ org, o }) => ({
        name: `Cuenta ${tag} ${o}`,
        source: specs[o].kind === 'alta' ? 'ALTA' : 'MANUAL',
        stageId: abierta.id,
        organizationId: org.id,
        ownerStaffId: vendedor && o % 3 === 0 ? vendedor : null,
        altaMotivo: specs[o].kind === 'alta' ? MOTIVOS[o % MOTIVOS.length] : null,
      })),
    }),
  )
  console.log(`altas: ${altas.length} · cuentas: ${cuentas.length}`)

  // 5. Orders and payments, venue by venue in batches of LOTE.
  const ordenesDe = (v: VenueSpec, j: number) =>
    v.spec.kind === 'alta' || v.spec.kind === 'nunca' ? 0 : j === 0 ? 60 * factor : j % 21 === 3 ? 400 : 43
  let pendientes: Array<
    Prisma.OrderCreateManyInput & { pago: { source: PaymentSource; method: PaymentMethod; terminalId?: string } | null; reserva: boolean }
  > = []
  let ordenes = 0
  let pagos = 0
  let reservas = 0
  const vaciar = async () => {
    if (!pendientes.length) return
    const lote = pendientes
    pendientes = []
    const conReserva = lote.filter(o => o.reserva)
    if (conReserva.length) {
      const made = await prisma.reservation.createManyAndReturn({
        data: conReserva.map(o => {
          const startsAt = new Date((o.createdAt as Date).getTime() - 3_600_000)
          const endsAt = new Date(startsAt.getTime() + 3_000_000)
          return {
            venueId: o.venueId,
            confirmationCode: `R-${o.orderNumber}`,
            status: 'CHECKED_IN' as const,
            startsAt,
            endsAt,
            duration: 50,
            blockedEndsAt: endsAt,
            partySize: 1,
          }
        }),
        select: { id: true, confirmationCode: true },
      })
      const byCode = new Map(made.map(r => [r.confirmationCode, r.id]))
      for (const o of conReserva) o.reservationId = byCode.get(`R-${o.orderNumber}`)
      reservas += made.length
    }
    const made = await prisma.order.createManyAndReturn({
      data: lote.map(({ pago: _pago, reserva: _reserva, ...order }) => order),
      select: { id: true, orderNumber: true },
    })
    const idOf = new Map(made.map(o => [o.orderNumber, o.id]))
    const payments: Prisma.PaymentCreateManyInput[] = lote.flatMap(o =>
      o.pago
        ? [
            {
              venueId: o.venueId,
              orderId: idOf.get(o.orderNumber)!,
              amount: o.total,
              method: o.pago.method,
              source: o.pago.source,
              status: 'COMPLETED' as const,
              terminalId: o.pago.terminalId,
              feePercentage: 0,
              feeAmount: 0,
              netAmount: o.total,
              createdAt: o.createdAt,
            },
          ]
        : [],
    )
    await prisma.payment.createMany({ data: payments })
    ordenes += made.length
    pagos += payments.length
    if (ordenes % 50_000 < LOTE) console.log(`  órdenes: ${ordenes} · pagos: ${pagos} · reservas: ${reservas}`)
  }

  for (let j = 0; j < venueSpecs.length; j++) {
    const v = venueSpecs[j]
    const venueId = venues[j].id
    const terminalId = terminalOf.get(venueId)
    const conReservas = j % 20 === 7
    const count = ordenesDe(v, j)
    for (let k = 0; k < count; k++) {
      const r = (j * 7919 + k * 104_729) % 100
      const at = v.spec.kind === 'sinCobros' ? hace((35 + (k % 55)) * DAY + k * 1000) : hace((k % 30) * DAY + (k % 86_400) * 1000)
      const reserva = conReservas && k % 5 === 0
      const source: OrderSource = reserva ? 'TPV' : r < 46 ? 'TPV' : r < 90 ? 'AVOQADO_ANDROID' : 'DASHBOARD_MANUAL'
      const pagada = r % 20 !== 0
      const tarjeta = k % 3 === 0
      const pago = !pagada
        ? null
        : reserva
          ? { source: (['TPV', 'APP', 'OTHER'] as const)[k % 3], method: PaymentMethod.CASH }
          : source === 'TPV'
            ? {
                source: PaymentSource.TPV,
                method: tarjeta ? PaymentMethod.CREDIT_CARD : PaymentMethod.CASH,
                terminalId: tarjeta ? terminalId : undefined,
              }
            : source === 'AVOQADO_ANDROID'
              ? { source: PaymentSource.APP, method: PaymentMethod.CASH }
              : { source: PaymentSource.OTHER, method: PaymentMethod.BANK_TRANSFER }
      const total = new Prisma.Decimal(50 + ((r * 7) % 450))
      pendientes.push({
        venueId,
        orderNumber: `${tag}-${j}-${k}`,
        source,
        paymentStatus: pagada ? 'PAID' : 'PENDING',
        subtotal: total,
        taxAmount: 0,
        total,
        createdAt: at,
        pago,
        reserva,
      })
      if (pendientes.length >= LOTE) await vaciar()
    }
  }
  await vaciar()
  console.log(`LISTO ${tag}: órdenes ${ordenes} · pagos ${pagos} · reservas ${reservas}`)
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
