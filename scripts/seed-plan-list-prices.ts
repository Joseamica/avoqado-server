/**
 * Seeds the list price of the Pro and Premium plans (spec 2026-09-30 «Precios de lista y promociones» §4.2).
 *
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-plan-list-prices.ts                                  # dry run
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-plan-list-prices.ts --apply --confirm-host <host> [--staff <id>]
 *
 * Why: a venue that bought loose functions and then wants Pro hits PLAN_ABSORBE_SUELTA in the classic purchase; with a
 * LIST of the plan that upgrade becomes self-service. Phase 1 seeds both plans at the classic monthly price
 * (STANDARD_PLAN_GROSS_CENTS: $1,158.84 and $1,970.84 with IVA) and never edits them: phase 2 decides plan prices.
 *
 * Idempotent: a plan list that already exists at that price is reported («ya existe»); one at another price is NOT
 * changed («precio distinto: la fase 2 lo decide»); a price left pending by a failed Stripe preparation is finished.
 *
 * 🔴 It prints the host of DATABASE_URL first, and writing requires repeating that exact host in --confirm-host (the
 * `cancelar-ordenes-fantasma.ts` pattern): the only defense against an inherited DATABASE_URL pointing elsewhere. The
 * Prisma client is loaded only after that check, from that same DATABASE_URL.
 */
import { STANDARD_PLAN_GROSS_CENTS } from '../src/services/access/planPricing.constants'
import type { PlanSeedOutcome } from '../src/services/launchCampaigns/hybridListPrice.service'

const TIERS = ['PRO', 'PREMIUM'] as const

export interface SeedOptions {
  apply: boolean
  confirmHost?: string
  staffId?: string
}
export interface SeedResult {
  productKey: string
  outcome: PlanSeedOutcome
  price: number
  /** The price on sale before this run (null when the plan had none). */
  current: number | null
}

/** A refusal: nothing was written. The script exits 2 with the message already printed. */
export class SeedRefusal extends Error {}

/** Host and database name of the DATABASE_URL this run connects to. The full URL (with its password) is never printed. */
function database(): { host: string; name: string } {
  const url = process.env.DATABASE_URL
  if (!url) throw new SeedRefusal('Falta DATABASE_URL: no hay base a la que conectarse.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SeedRefusal('DATABASE_URL no es una URL válida (su valor no se imprime).')
  }
  if (!parsed.hostname) throw new SeedRefusal('DATABASE_URL no declara un host: no hay nada que repetir en --confirm-host.')
  return { host: parsed.hostname, name: parsed.pathname.replace(/^\//, '') }
}

const pesos = (value: number | null) => (value === null ? 'sin precio' : `$${value.toFixed(2)}`)

const MESSAGES: Record<PlanSeedOutcome, (r: SeedResult, apply: boolean) => string> = {
  CREATE: (r, apply) => (apply ? `creada a ${pesos(r.price)} al mes, en venta` : `se crearía a ${pesos(r.price)} al mes`),
  EXISTS: r => `ya existe a ${pesos(r.price)}`,
  DIFFERENT_PRICE: r => `precio distinto: la fase 2 lo decide (hoy ${pesos(r.current)}, clásico ${pesos(r.price)}); no se cambió`,
  PENDING: (r, apply) => (apply ? `precio pendiente terminado a ${pesos(r.price)}` : `precio pendiente de preparar; --apply lo termina`),
}

export async function seedPlanLists(
  options: SeedOptions,
  log: (line: string) => void = console.log,
): Promise<{ host: string; results: SeedResult[] }> {
  const { host, name } = database()
  log(`Base: ${host}  base de datos: ${name}  modo: ${options.apply ? 'APLICAR' : 'SIMULACIÓN'}`)
  if (options.apply && options.confirmHost !== host)
    throw new SeedRefusal(`🔴 No se escribió NADA. Para escribir en esta base repite su host exacto:  --confirm-host ${host}`)

  // Loaded after the host check: the client reads DATABASE_URL when it loads.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { listPriceBoard, planSeedOutcome, seedPlanList } = await import('../src/services/launchCampaigns/hybridListPrice.service')

  let staffId = options.staffId
  if (options.apply) {
    const staff = options.staffId
      ? await prisma.staff.findUnique({ where: { id: options.staffId }, select: { id: true } })
      : await prisma.staff.findFirst({
          where: { venues: { some: { role: 'SUPERADMIN' } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
    if (!staff)
      throw new SeedRefusal(options.staffId ? `No existe el staff ${options.staffId}.` : 'No encontré un SUPERADMIN: pasa --staff <id>.')
    staffId = staff.id
  }

  const board = await listPriceBoard()
  const results: SeedResult[] = []
  for (const tier of TIERS) {
    const productKey = `PLAN:${tier}`
    const price = STANDARD_PLAN_GROSS_CENTS[tier].monthly / 100
    const row = board.find(candidate => candidate.productKey === productKey)!
    const outcome = options.apply ? (await seedPlanList(tier, price, staffId!)).outcome : planSeedOutcome(row, price)
    const result = { productKey, outcome, price, current: row.price }
    results.push(result)
    log(`${productKey}: ${MESSAGES[outcome](result, options.apply)}`)
  }
  return { host, results }
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  await import('dotenv/config')
  await seedPlanLists({ apply: process.argv.includes('--apply'), confirmHost: flag('--confirm-host'), staffId: flag('--staff') })
  const { default: prisma } = await import('../src/utils/prismaClient')
  await prisma.$disconnect()
}

if (require.main === module)
  main()
    .then(() => process.exit(0))
    .catch(error => {
      // A refusal or a business error (e.g. Stripe could not prepare a price: rerun to finish it) is its message alone.
      console.error(error instanceof SeedRefusal || error?.isOperational ? error.message : error)
      process.exit(error instanceof SeedRefusal ? 2 : 1)
    })
