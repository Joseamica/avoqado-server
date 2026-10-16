/**
 * Tarjetas de regalo (`GIFT_CARDS`, fase 1a): la deja lista para venderse como función de Pro y como suelta.
 *
 *   1. La fila `Feature` (la que usa superadmin para encender una función a mano a un negocio).
 *   2. El precio de lista suelto: $249 al mes CON IVA (founder, 14-oct), por el MISMO camino que la pantalla «Precios» de
 *      superadmin (`saveListPrice`: candado del producto, publicación pendiente, Stripe, finalizar).
 *   3. La función en los contratos de plan PRO y PREMIUM vivos (`addPlanFeatureToLivePlanContracts`): una publicación de
 *      plan congela su composición y una función nueva no llega sola a los contratos que ya existen.
 *
 * Idempotente: una fila `Feature` existente sólo se reactiva (su precio no se toca); un precio de lista que ya existe a
 * $249 se reporta («ya existe»), a otro precio NO se cambia («precio distinto»), y uno pendiente por Stripe se termina.
 *
 *   export DATABASE_URL=<destino>        # OBLIGATORIO: dotenv nunca pisa un valor exportado
 *   npx ts-node -T -r tsconfig-paths/register scripts/sembrar-funcion-tarjetas-de-regalo.ts                          # simulación
 *   npx ts-node -T -r tsconfig-paths/register scripts/sembrar-funcion-tarjetas-de-regalo.ts --apply --confirm-host <host> --confirm-db <base> [--staff <id>]
 *
 * `-T` es obligatorio: un ts-node que revisa tipos se queda sin memoria con los tipos de Prisma.
 *
 * 🔴 PRODUCCIÓN: sólo con «sí, en prod» del founder, DESPUÉS de desplegar el server que trae `GIFT_CARDS` en
 * `LEGACY_PLAN_CODES` y en `FEATURE_CATALOG`. Imprime host y base de DATABASE_URL antes de nada, y para escribir hay que
 * repetir los dos (`--confirm-host` y `--confirm-db`), como `seed-plan-list-prices.ts`.
 *
 * Después de --apply: si reporta ofertas de plan por republicar, corre `scripts/seed-plan-list-prices.ts --apply` (listas
 * L_PLAN_*) o republícalas en superadmin (promociones), y vuelve a correr este script.
 *
 * Salida: 0 = todo al día (o simulación) · 1 = contratos que no se pudieron poner al día (ver su motivo) · 2 = no se
 * escribió nada (faltó confirmar) o falta volver a correrlo (ofertas por republicar o compras de plan en curso).
 */
import type { PlanSeedOutcome } from '../src/services/launchCampaigns/hybridListPrice.service'

export const CODIGO = 'GIFT_CARDS'
export const PRODUCTO = `FEATURE:${CODIGO}`
/** Precio suelto al mes, CON IVA (founder, 14-oct-2026). El precio de lista siempre se guarda con `taxIncluded: true`. */
export const PRECIO_SUELTO = 249

export interface OpcionesDeSiembra {
  apply: boolean
  confirmHost?: string
  confirmDb?: string
  staffId?: string
}
export type ResultadoDeFeature = 'CREATE' | 'REACTIVATE' | 'EXISTS'
export interface ReporteDeSiembra {
  host: string
  base: string
  feature: ResultadoDeFeature
  listPrice: { outcome: PlanSeedOutcome; current: number | null; pending: number | null }
  contracts: {
    contracts: number
    grants: number
    skippedContracts: Array<{ contractId: string; reason: string }>
    inFlightPurchases: Array<{ status: string; purchases: number }>
  } | null
  staleCampaigns: Array<{ id: string; code: string }>
}

/** Una negativa: no se escribió nada. El script sale con 2 y el mensaje ya impreso. */
export class NegativaDeSiembra extends Error {}

/** Host y nombre de la base de DATABASE_URL. La URL completa (con su contraseña) nunca se imprime. */
function baseDestino(): { host: string; base: string } {
  const url = process.env.DATABASE_URL
  if (!url) throw new NegativaDeSiembra('Falta DATABASE_URL: no hay base a la que conectarse.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new NegativaDeSiembra('DATABASE_URL no es una URL válida (su valor no se imprime).')
  }
  if (!parsed.hostname) throw new NegativaDeSiembra('DATABASE_URL no declara un host: no hay nada que repetir en --confirm-host.')
  return { host: parsed.hostname, base: parsed.pathname.replace(/^\//, '') }
}

const pesos = (v: number | null) => (v === null ? 'sin precio' : `$${v.toFixed(2)}`)

const MENSAJE_FEATURE: Record<ResultadoDeFeature, (apply: boolean) => string> = {
  CREATE: apply => (apply ? 'creada (activa)' : 'se crearía'),
  REACTIVATE: apply => (apply ? 'reactivada (su precio no se tocó)' : 'existe apagada; --apply la reactiva sin tocar su precio'),
  EXISTS: () => 'ya existe activa',
}

const MENSAJE_PRECIO: Record<PlanSeedOutcome, (r: ReporteDeSiembra['listPrice'], apply: boolean) => string> = {
  CREATE: (_r, apply) =>
    apply ? `creado a ${pesos(PRECIO_SUELTO)} al mes con IVA, en venta` : `se crearía a ${pesos(PRECIO_SUELTO)} al mes con IVA`,
  EXISTS: () => `ya existe a ${pesos(PRECIO_SUELTO)}`,
  DIFFERENT_PRICE: r => `precio distinto: hoy ${pesos(r.current)}; superadmin lo cambió y NO se pisa`,
  PENDING: (r, apply) =>
    apply
      ? `precio pendiente terminado a ${pesos(r.pending ?? PRECIO_SUELTO)}`
      : 'precio pendiente de preparar en Stripe; --apply lo termina',
}

export async function sembrarFuncionTarjetasDeRegalo(
  opciones: OpcionesDeSiembra,
  log: (linea: string) => void = console.log,
): Promise<ReporteDeSiembra> {
  const { host, base } = baseDestino()
  log(`Base: ${host}  base de datos: ${base}  modo: ${opciones.apply ? 'APLICAR' : 'SIMULACIÓN'}`)
  if (opciones.apply && (opciones.confirmHost !== host || opciones.confirmDb !== base))
    throw new NegativaDeSiembra(
      `🔴 No se escribió NADA. Para escribir en esta base repite su host y su nombre exactos:  --confirm-host ${host} --confirm-db ${base}`,
    )

  // Se cargan DESPUÉS de revisar host y base: el cliente de Prisma lee DATABASE_URL al cargarse.
  const { default: prisma } = await import('../src/utils/prismaClient')
  const { listPriceBoard, planSeedOutcome, retryListPrice, saveListPrice } = await import(
    '../src/services/launchCampaigns/hybridListPrice.service'
  )
  const { addPlanFeatureToLivePlanContracts, staleCampaigns } = await import('../src/services/launchCampaigns/hybridPlanCatchUp')

  let staffId = opciones.staffId
  if (opciones.apply) {
    const staff = opciones.staffId
      ? await prisma.staff.findUnique({ where: { id: opciones.staffId }, select: { id: true } })
      : await prisma.staff.findFirst({
          where: { venues: { some: { role: 'SUPERADMIN' } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        })
    if (!staff)
      throw new NegativaDeSiembra(
        opciones.staffId ? `No existe el staff ${opciones.staffId}.` : 'No encontré un SUPERADMIN: pasa --staff <id>.',
      )
    staffId = staff.id
  }

  // 1. La fila Feature. Nunca se le cambia el precio a una que ya existe.
  const existente = await prisma.feature.findUnique({ where: { code: CODIGO }, select: { active: true } })
  const feature: ResultadoDeFeature = !existente ? 'CREATE' : existente.active ? 'EXISTS' : 'REACTIVATE'
  if (opciones.apply && feature !== 'EXISTS')
    await prisma.feature.upsert({
      where: { code: CODIGO },
      update: { active: true },
      create: {
        code: CODIGO,
        name: 'Tarjetas de regalo',
        description: 'Vende tarjetas de regalo en tu POS y cóbralas con su saldo, solo o combinado con otro medio.',
        category: 'MARKETING',
        monthlyPrice: PRECIO_SUELTO,
        active: true,
      },
    })
  log(`Feature ${CODIGO}: ${MENSAJE_FEATURE[feature](opciones.apply)}`)

  // 2. El precio de lista suelto, por el camino de la pantalla «Precios» de superadmin.
  const fila = (await listPriceBoard()).find(r => r.productKey === PRODUCTO)
  if (!fila)
    throw new NegativaDeSiembra(`${PRODUCTO} no está en el catálogo: despliega primero el server con GIFT_CARDS en FEATURE_CATALOG.`)
  if (!fila.editable) throw new NegativaDeSiembra(`${PRODUCTO} no admite precio de lista (${fila.notEditableReason}).`)
  const outcome = planSeedOutcome(fila, PRECIO_SUELTO)
  const listPrice = { outcome, current: fila.price, pending: fila.pendingPrice }
  if (opciones.apply && outcome === 'CREATE')
    await saveListPrice({ productKey: PRODUCTO, price: PRECIO_SUELTO, expectedRevision: fila.revision }, staffId!)
  if (opciones.apply && outcome === 'PENDING') await retryListPrice(PRODUCTO, staffId!, fila.revision ?? undefined)
  log(`${PRODUCTO}: ${MENSAJE_PRECIO[outcome](listPrice, opciones.apply)}`)

  // 3. Los contratos de plan vivos (una publicación de plan congela su composición).
  const contracts = opciones.apply ? await addPlanFeatureToLivePlanContracts(CODIGO) : null
  const porRepublicar = contracts ? contracts.staleCampaigns : await staleCampaigns(CODIGO)
  if (contracts)
    log(
      `Contratos de plan puestos al día: ${contracts.contracts} · accesos de periodo creados: ${contracts.grants} · saltados: ${contracts.skippedContracts.length}`,
    )
  if (porRepublicar.length)
    log(
      `Ofertas de plan sin ${CODIGO} (republícalas y vuelve a correr esto): ${porRepublicar.map(c => c.code).join(', ')}. ` +
        'Las listas L_PLAN_* con scripts/seed-plan-list-prices.ts --apply; una promoción, en superadmin.',
    )

  return {
    host,
    base,
    feature,
    listPrice,
    contracts: contracts
      ? {
          contracts: contracts.contracts,
          grants: contracts.grants,
          skippedContracts: contracts.skippedContracts,
          inFlightPurchases: contracts.inFlightPurchases,
        }
      : null,
    staleCampaigns: porRepublicar,
  }
}

function bandera(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  await import('dotenv/config')
  const apply = process.argv.includes('--apply')
  const r = await sembrarFuncionTarjetasDeRegalo({
    apply,
    confirmHost: bandera('--confirm-host'),
    confirmDb: bandera('--confirm-db'),
    staffId: bandera('--staff'),
  })
  const { default: prisma } = await import('../src/utils/prismaClient')
  await prisma.$disconnect()
  if (!apply || !r.contracts) return 0
  if (r.contracts.skippedContracts.length) return 1
  const enCurso = r.contracts.inFlightPurchases.reduce((suma, x) => suma + x.purchases, 0)
  return r.staleCampaigns.length || enCurso ? 2 : 0
}

if (require.main === module)
  main()
    .then(codigo => process.exit(codigo))
    .catch(error => {
      // Una negativa o un error de negocio (p. ej. Stripe no pudo preparar el precio: vuelve a correrlo) es sólo su mensaje.
      console.error(error instanceof NegativaDeSiembra || error?.isOperational ? error.message : error)
      process.exit(error instanceof NegativaDeSiembra ? 2 : 1)
    })
