/**
 * IVA por producto, plan 6b (spec §5.2b, condición D21): puesta al día de los negocios YA encendidos antes del 6b (Testarudo, 30-sep, a
 * mano). Una vez al desplegar; idempotente; nunca bloquea: sella desde su XML las facturas heredadas que se pueden y LISTA las demás
 * para revisarlas a mano (las muestra el diagnóstico del MCP `set_product_iva`).
 *
 * Uso:
 *   Ensayo (sólo lee):  npx ts-node -T -r tsconfig-paths/register scripts/iva/puesta-al-dia-6b.ts --dry-run [--venue <id>]
 *   De verdad:          npx ts-node -T -r tsconfig-paths/register scripts/iva/puesta-al-dia-6b.ts --confirmar-base <base> [--venue <id>]
 * 🔴 En producción sólo con el «sí, en prod» del founder, primero con --dry-run. Para escribir hay que repetir el nombre de la base que
 * imprime el ensayo. El ensayo NO escribe nada: no pide al PAC el XML que falte (`SIN_REPARAR`; una factura sin XML sale «No se pudo leer
 * su XML»). Sólo la corrida autorizada lo pide (eso escribe archivos y `xmlConceptos`, como el reconciliador cada 5 min).
 *
 * Cómo se corre: con el ENTORNO COMPLETO del servidor (no basta `DATABASE_URL`: `config/env` valida al importar `ACCESS_TOKEN_SECRET`,
 * `SESSION_SECRET`, `COOKIE_SECRET`, `OTP_PEPPER` y `RABBITMQ_URL`; la corrida real también necesita lo del PAC y el almacenamiento) y, para la
 * corrida real, con `NODE_ENV=production`: la reparación del XML elige el PAC por `NODE_ENV` (`finalizadorCfdi.ts`, `sandbox ?? NODE_ENV !== 'production'`),
 * así que sin esa variable pide el XML al SANDBOX y no encuentra los timbres reales (las facturas saldrían «No se pudo leer su XML»).
 * Ejemplo: `NODE_ENV=production DATABASE_URL=<la base> npx ts-node -T -r tsconfig-paths/register scripts/iva/puesta-al-dia-6b.ts --confirmar-base <base>`
 * con el resto de las variables del servidor ya puestas (dotenv no pisa las que ya existen).
 */
import prisma from '../../src/utils/prismaClient'
import { bloquearOrdenesParaFacturar } from '../../src/services/fiscal/admisionIva'
import { IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION } from '../../src/services/fiscal/exclusionContable'
import {
  aplicarSelladoHeredado,
  MOTIVO_ORDEN_EN_OTRA_ORGANIZACION,
  MOTIVO_SELLO_DISTINTO,
  planDeSelladoHeredado,
  SelloHeredadoDivergente,
  SIN_REPARAR,
  type NoSellable,
} from '../../src/services/fiscal/sellosHeredados'

/** Sólo el nombre y el código del error, nunca su mensaje ni el objeto (pueden traer valores de la consulta o la URL de la base). */
const nombreDeError = (e: unknown): string =>
  [(e as Error | null)?.name, (e as { code?: string } | null)?.code].filter(Boolean).join(' ') || 'sin nombre'

export type InformeDeNegocio = { venueId: string; porSellar: string[]; sellados: string[]; noSellables: NoSellable[] }

export async function puestaAlDia(opts: { aplicar: boolean; venueId?: string }): Promise<InformeDeNegocio[]> {
  const informe: InformeDeNegocio[] = []
  for (let cursor = ''; ; ) {
    const encendidos = await prisma.venueIvaPorProducto.findMany({
      where: { venueId: opts.venueId ?? { gt: cursor } },
      orderBy: { venueId: 'asc' },
      take: 100,
      select: { venueId: true },
    })
    for (const { venueId } of encendidos) {
      // Codex r1 P2-6: el ensayo sólo LEE; pedir el XML al PAC escribe, así que sólo la corrida autorizada lo hace.
      const plan = await planDeSelladoHeredado(venueId, opts.aplicar ? {} : { reparar: SIN_REPARAR })
      const sellados: string[] = []
      const noSellables = [...plan.noSellables]
      if (opts.aplicar)
        for (const s of plan.sellables) {
          // Una transacción por factura, con el orden de D10: una que falle se lista y no detiene a las demás. Las órdenes se bloquean por
          // id del manifiesto, SIN `venueId` (ruling T6-a): una orden que el job de PlayTelecom movió a otra sede sigue siendo de su factura.
          try {
            const r = await prisma.$transaction(
              async tx => {
                // Codex código r2 N3 (Ruling CX-13): la venta pudo irse a otra organización DESPUÉS del plan. `soloOrganizacion` (la del
                // negocio de la factura) lo comprueba antes de pedir admisiones y otra vez ya con la venta bloqueada: si cambió, 409 y abajo se
                // lista con el motivo del plan, sin sellar.
                const { organizationId } = await tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { organizationId: true } })
                await bloquearOrdenesParaFacturar(tx, [s.orderId], undefined, { soloOrganizacion: organizationId })
                return aplicarSelladoHeredado(tx, { venueId, sellables: [s], noSellables: [] }, { staffId: null, origen: 'PUESTA_AL_DIA' })
              },
              // Ruling T10-a: detrás de una emisión larga (hasta 15 s, una global hasta 60 s) o con una venta de muchos renglones, los 5 s por
              // omisión de Prisma vencen con P2028 y la factura nunca se sella. Mismo patrón que el script de RH (`rh/migracion.ts`).
              { timeout: 60_000, maxWait: 10_000 },
            )
            sellados.push(...r.sellados.map(x => x.folio))
            noSellables.push(...r.cambiaron)
          } catch (e) {
            // Contrato T4: `SelloHeredadoDivergente` sale con renglones ya sellados y la transacción de ESTA factura revierte entera. Un error
            // inesperado se lista sin su mensaje (puede traer valores de la consulta): el informe no lleva datos personales.
            const motivo =
              e instanceof SelloHeredadoDivergente
                ? MOTIVO_SELLO_DISTINTO
                : (e as { code?: string } | null)?.code === IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION
                  ? MOTIVO_ORDEN_EN_OTRA_ORGANIZACION
                  : `Error inesperado al sellar (${nombreDeError(e)}); se reintenta en la siguiente corrida`
            noSellables.push({ cfdiId: s.cfdiId, folio: s.folio, motivo })
          }
        }
      informe.push({ venueId, porSellar: plan.sellables.map(s => `${s.folio} → ${s.tratamiento}`), sellados, noSellables })
    }
    if (opts.venueId || encendidos.length < 100) return informe
    cursor = encendidos[encendidos.length - 1].venueId
  }
}

const USO = 'Sólo se aceptan --dry-run, --venue <id> y --confirmar-base <base> (el valor va separado por espacio, sin «=»).'

/** Lee los argumentos; cualquier cosa fuera de los tres conocidos es un error (un `--venue=<id>` mal escrito recorrería TODOS los negocios). */
function leerArgumentos(args: string[]): { solo?: string; confirmada?: string; dry: boolean } {
  const r: { solo?: string; confirmada?: string; dry: boolean } = { dry: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry-run') r.dry = true
    else if (a === '--venue' || a === '--confirmar-base') {
      const valor = args[++i]
      if (!valor || valor.startsWith('--')) throw new Error(`${a} necesita un valor. ${USO}`)
      if (a === '--venue') r.solo = valor
      else r.confirmada = valor
    } else throw new Error(`Argumento desconocido: «${a}». ${USO}`)
  }
  return r
}

async function main() {
  let args: ReturnType<typeof leerArgumentos>
  try {
    args = leerArgumentos(process.argv.slice(2))
  } catch (e) {
    console.error(`No se hizo nada. ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
    return
  }
  const { solo, confirmada, dry } = args
  if (!process.env.DATABASE_URL) {
    console.error('No se hizo nada. Falta DATABASE_URL.')
    process.exitCode = 1
    return
  }
  const url = new URL(process.env.DATABASE_URL)
  // El nombre que se confirma es el de la base a la que Postgres dice que estamos conectados, no el que se lee de la URL.
  const [{ base }] = await prisma.$queryRaw<Array<{ base: string }>>`SELECT current_database() AS base`
  // Nunca usuario ni contraseña en pantalla: sólo host, puerto y base.
  console.log(`Base: ${base} · host: ${url.hostname}:${url.port || '5432'} · dry-run: ${dry}`)
  if (!dry && confirmada !== base) {
    console.error(
      `No se escribió nada. Para sellar de verdad repite el nombre de la base: --confirmar-base ${base}\n` +
        'Para sólo revisar qué haría, usa --dry-run.',
    )
    process.exitCode = 1
    return
  }

  const informe = await puestaAlDia({ aplicar: !dry, venueId: solo })
  if (informe.length === 0)
    console.log(solo ? 'Ese negocio no existe o no está encendido: no hay nada que poner al día.' : 'Ningún negocio encendido.')
  console.log(JSON.stringify(informe, null, 2))
}

/**
 * Codex código r1 #8 (Ruling CX-8): el error de fuera sale como el del informe, con mensaje fijo y nombre/código; nunca el objeto: el de
 * `new URL(DATABASE_URL)` trae la URL entera (usuario y contraseña) en `input`.
 */
export function ejecutar(): Promise<void> {
  return main().catch(e => {
    console.error(`La puesta al día se detuvo por un error (${nombreDeError(e)}). No se imprime su detalle: puede traer la URL de la base.`)
    process.exitCode = 1
  })
}

if (require.main === module) ejecutar().finally(() => prisma.$disconnect())
