/**
 * Menú de cada aparato (`DEVICE_MENUS`): la deja lista al publicar, como función INCLUIDA en Pro y Premium (founder,
 * 30-oct-2026). No se vende suelta: este script NO crea ningún precio de lista.
 *
 *   1. La fila `Feature` (con ella el dashboard enseña la función como tarjeta: desbloqueada en Pro y Premium, y bloqueada con
 *      su upsell en Gratis). Nace activa y con `monthlyPrice: 0`.
 *   2. La función en los contratos de plan PRO y PREMIUM vivos (`addPlanFeatureToLivePlanContracts`): una publicación de
 *      plan congela su composición y una función nueva no llega sola a los contratos que ya existen.
 *
 * También pone al día los contratos vivos con KITCHEN_DISPLAY y CUSTOMER_DISPLAY_PROMOS (sin fila `Feature`; ver CODIGOS_SIN_FILA).
 *
 * Idempotente. Una fila `Feature` que ya existe NO se modifica (ni precio ni nombre). Si existe pero está APAGADA, se reporta y
 * se deja así —alguien pudo apagarla a propósito—: sólo `--reactivar` la enciende, y sólo toca `active`. Los contratos que ya
 * la tienen no se vuelven a tocar.
 *
 *   export DATABASE_URL=<destino>        # OBLIGATORIO: dotenv nunca pisa un valor exportado
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-device-menus-feature.ts                          # simulación
 *   npx ts-node -T -r tsconfig-paths/register scripts/seed-device-menus-feature.ts --apply --confirm-host <host> --confirm-db <base> [--reactivar]
 *
 * `-T` es obligatorio: un ts-node que revisa tipos se queda sin memoria con los tipos de Prisma.
 *
 * 🔴 PRODUCCIÓN: sólo con «sí, en prod» del founder, DESPUÉS de desplegar el server que trae `DEVICE_MENUS` en
 * `LEGACY_PLAN_CODES`, en `FEATURE_CATALOG` y en `PLAN_CATCH_UP_CODES`. Imprime host y base de DATABASE_URL antes de nada
 * (nunca la URL completa), y para escribir hay que repetir los dos (`--confirm-host` y `--confirm-db`), como
 * `sembrar-funcion-tarjetas-de-regalo.ts`. Corre primero la simulación y lee a qué base apunta.
 *
 * Después de --apply: si reporta ofertas de plan por republicar, corre `scripts/seed-plan-list-prices.ts --apply` (listas
 * L_PLAN_*) o republícalas en superadmin (promociones), y vuelve a correr este script.
 *
 * Salida: 0 = todo al día (o simulación) · 1 = contratos que no se pudieron poner al día (ver su motivo) · 2 = no se
 * escribió nada (faltó confirmar) o falta volver a correrlo (ofertas por republicar o compras de plan en curso).
 */
export const CODIGO = 'DEVICE_MENUS'
/**
 * D4 (31-oct): Pro desde antes y sin entrada en el catálogo hasta ahora; entran a la oferta de plan y a la puesta al día de los
 * contratos vivos. SIN fila `Feature` nueva: su acceso lo decide el código (`venueHasFeatureAccess`), el tablero de precios sale
 * del catálogo, y ninguna de las dos tuvo fila en producción por diseño (basePlan.service: «sin venta suelta ni fila Feature»).
 */
export const CODIGOS_SIN_FILA = ['KITCHEN_DISPLAY', 'CUSTOMER_DISPLAY_PROMOS'] as const
const CODIGOS_DE_PLAN = [CODIGO, ...CODIGOS_SIN_FILA] as const

export interface OpcionesDeSiembra {
  apply: boolean
  confirmHost?: string
  confirmDb?: string
  /** Enciende una fila `Feature` que existe APAGADA. Sin esto se reporta y se deja como está. */
  reactivar?: boolean
}
/**
 * CREATE: no hay fila · EXISTS: ya está activa · INACTIVE: existe apagada y se DEJA así ·
 * REACTIVATE: existe apagada y `--reactivar` la enciende.
 */
export type ResultadoDeFeature = 'CREATE' | 'EXISTS' | 'INACTIVE' | 'REACTIVATE'
export interface ReporteDeSiembra {
  host: string
  base: string
  feature: ResultadoDeFeature
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

const MENSAJE_FEATURE: Record<ResultadoDeFeature, (apply: boolean) => string> = {
  CREATE: apply => (apply ? 'creada (activa, precio 0: no se vende suelta)' : 'se crearía (activa, precio 0: no se vende suelta)'),
  EXISTS: () => 'ya existe activa (no se toca)',
  INACTIVE: () => 'existe APAGADA y se deja así (alguien pudo apagarla a propósito). Si fue un descuido, repite con --reactivar',
  REACTIVATE: apply =>
    apply ? 'reactivada (su precio y su nombre no se tocaron)' : 'existe apagada; --apply --reactivar la enciende sin tocar su precio',
}

/** Cuántos contratos saltados se imprimen con su motivo (el reporte los trae todos). */
const MOTIVOS_A_IMPRIMIR = 20

export async function sembrarFuncionMenuDelAparato(
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
  const { FEATURE_CATALOG } = await import('../src/config/featureCatalog')
  const { elPlanConcede } = await import('../src/services/access/basePlan.service')
  const { PLAN_CATCH_UP_CODES, addPlanFeatureToLivePlanContracts, staleCampaigns } = await import(
    '../src/services/launchCampaigns/hybridPlanCatchUp'
  )

  // Las negativas, ANTES de escribir nada: una NegativaDeSiembra significa «no se escribió nada». Se corre desde el árbol que ya
  // trae las funciones (catálogo, planes Pro y Premium, lista de puesta al día); si no, la puesta al día revienta DESPUÉS de crear la fila.
  for (const codigo of CODIGOS_DE_PLAN) {
    if (!FEATURE_CATALOG.some(f => f.featureCode === codigo))
      throw new NegativaDeSiembra(`${codigo} no está en el catálogo: corre esto desde el árbol que ya trae ${codigo} en FEATURE_CATALOG.`)
    if (!(PLAN_CATCH_UP_CODES as readonly string[]).includes(codigo) || !elPlanConcede('PRO', codigo) || !elPlanConcede('PREMIUM', codigo))
      throw new NegativaDeSiembra(
        `${codigo} no es una función de plan en este árbol (lista de puesta al día y planes Pro y Premium): corre esto desde el árbol que ya la trae.`,
      )
  }

  // 1. La fila Feature. Una que ya existe nunca se modifica, salvo `active` y sólo con --reactivar.
  const existente = await prisma.feature.findUnique({ where: { code: CODIGO }, select: { active: true } })
  const feature: ResultadoDeFeature = !existente ? 'CREATE' : existente.active ? 'EXISTS' : opciones.reactivar ? 'REACTIVATE' : 'INACTIVE'
  if (opciones.apply && feature === 'CREATE')
    await prisma.feature.upsert({
      where: { code: CODIGO },
      update: {}, // si otra corrida la creó en este instante, no se toca
      create: {
        code: CODIGO,
        name: 'Menú de cada aparato',
        description: 'Elige qué menús muestra cada aparato; la búsqueda y el escáner siguen encontrando todo.',
        category: 'OPERATIONS',
        monthlyPrice: 0,
        active: true,
      },
    })
  if (opciones.apply && feature === 'REACTIVATE') await prisma.feature.update({ where: { code: CODIGO }, data: { active: true } })
  log(`Feature ${CODIGO}: ${MENSAJE_FEATURE[feature](opciones.apply)}`)
  log(`Precio de lista: no se crea ninguno (${CODIGO} va incluida en Pro y Premium, no se vende suelta).`)

  // 2. Los contratos de plan vivos (una publicación de plan congela su composición), un código tras otro.
  type Puesta = Awaited<ReturnType<typeof addPlanFeatureToLivePlanContracts>>
  let contracts = null as Puesta | null
  let porRepublicar: Array<{ id: string; code: string }> = []
  for (const codigo of CODIGOS_DE_PLAN) {
    if (opciones.apply) {
      const r = await addPlanFeatureToLivePlanContracts(codigo)
      contracts = contracts
        ? {
            ...contracts,
            contracts: contracts.contracts + r.contracts,
            grants: contracts.grants + r.grants,
            skippedContracts: [...contracts.skippedContracts, ...r.skippedContracts.map(x => ({ ...x, reason: `${codigo}: ${x.reason}` }))],
            // las compras en curso son las mismas en cada corrida: se cuentan una vez
          }
        : { ...r, skippedContracts: r.skippedContracts.map(x => ({ ...x, reason: `${codigo}: ${x.reason}` })) }
      porRepublicar.push(...r.staleCampaigns)
    } else porRepublicar.push(...(await staleCampaigns(codigo)))
  }
  porRepublicar = [...new Map(porRepublicar.map(c => [c.id, c])).values()]
  if (contracts) {
    log(
      `Contratos de plan puestos al día: ${contracts.contracts} · accesos de periodo creados: ${contracts.grants} · saltados: ${contracts.skippedContracts.length}`,
    )
    for (const { contractId, reason } of contracts.skippedContracts.slice(0, MOTIVOS_A_IMPRIMIR)) log(`  saltado ${contractId}: ${reason}`)
    if (contracts.skippedContracts.length > MOTIVOS_A_IMPRIMIR)
      log(`  …y ${contracts.skippedContracts.length - MOTIVOS_A_IMPRIMIR} más (el reporte los trae todos)`)
    if (contracts.inFlightPurchases.length)
      log(
        `Compras de plan en curso (no se tocaron; vuelve a correr esto cuando se completen): ${contracts.inFlightPurchases.map(x => `${x.status}: ${x.purchases}`).join(', ')}`,
      )
  } else {
    log('Contratos de plan vivos: sin --apply no se tocan.')
  }
  if (porRepublicar.length)
    log(
      `Ofertas de plan sin alguna de ${CODIGOS_DE_PLAN.join(', ')} (republícalas y vuelve a correr esto): ${porRepublicar.map(c => c.code).join(', ')}. ` +
        'Las listas L_PLAN_* con scripts/seed-plan-list-prices.ts --apply; una promoción, en superadmin.',
    )

  return {
    host,
    base,
    feature,
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

/** 0 = al día (o simulación) · 1 = contratos sin poner al día · 2 = falta volver a correrlo. Una fila apagada que se dejó así NO cuenta. */
export function codigoDeSalida(apply: boolean, r: ReporteDeSiembra): number {
  if (!apply || !r.contracts) return 0
  if (r.contracts.skippedContracts.length) return 1
  const enCurso = r.contracts.inFlightPurchases.reduce((suma, x) => suma + x.purchases, 0)
  return r.staleCampaigns.length || enCurso ? 2 : 0
}

function bandera(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  await import('dotenv/config')
  const apply = process.argv.includes('--apply')
  const r = await sembrarFuncionMenuDelAparato({
    apply,
    confirmHost: bandera('--confirm-host'),
    confirmDb: bandera('--confirm-db'),
    reactivar: process.argv.includes('--reactivar'),
  })
  const { default: prisma } = await import('../src/utils/prismaClient')
  await prisma.$disconnect()
  return codigoDeSalida(apply, r)
}

if (require.main === module)
  main()
    .then(codigo => process.exit(codigo))
    .catch(error => {
      // Una negativa o un error de negocio es sólo su mensaje.
      console.error(error instanceof NegativaDeSiembra || error?.isOperational ? error.message : error)
      process.exit(error instanceof NegativaDeSiembra ? 2 : 1)
    })
