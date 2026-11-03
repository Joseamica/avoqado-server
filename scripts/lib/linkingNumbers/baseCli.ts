/**
 * Lo común de los dos scripts del lanzamiento del número de vinculación, con el patrón de `scripts/cancelar-ordenes-fantasma.ts`:
 * elegir la base ANTES de cargar Prisma (el cliente lee `DATABASE_URL` al construirse) y exigir su host para escribir.
 * 🔴 Sin imports de la app: uno que alcanzara `src/utils/prismaClient` ataría el cliente a la base equivocada
 * (lo vigila `tests/unit/architecture/grafoDeImports.guard.test.ts`).
 */

/** Rechazo de seguridad: el motivo ya se imprimió; esto sólo lleva el código de salida a `correr`. */
export class Rechazo extends Error {
  constructor(readonly codigo: number) {
    super(`rechazo (${codigo})`)
    this.name = 'Rechazo'
  }
}

/** `--bandera=valor` o `--bandera valor`. */
export function leerValor(bandera: string): string | undefined {
  const conIgual = process.argv.find(a => a.startsWith(`${bandera}=`))
  if (conIgual) return conIgual.slice(bandera.length + 1)
  const i = process.argv.indexOf(bandera)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** `--base render` cambia DATABASE_URL por RENDER_DATABASE_URL. Ninguna URL se imprime. */
export function elegirBase(): void {
  const base = leerValor('--base')
  if (base === undefined || base === 'local') return
  if (base !== 'render') {
    console.error(`--base sólo acepta «render» o «local» (recibí «${base}»).`)
    throw new Rechazo(2)
  }
  const url = process.env.RENDER_DATABASE_URL
  if (!url) {
    console.error('--base render: falta RENDER_DATABASE_URL en el entorno.')
    throw new Rechazo(2)
  }
  process.env.DATABASE_URL = url
}

/** Host de la base a la que ESTA corrida se va a conectar. */
export function hostDeLaBase(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('Falta DATABASE_URL: no hay base a la que conectarse.')
    throw new Rechazo(2)
  }
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    console.error('DATABASE_URL no es una URL válida (su valor no se imprime).')
    throw new Rechazo(2)
  }
  if (!host) {
    console.error('DATABASE_URL no declara un host (¿conexión por socket?): no hay nada que repetir en --confirm-host.')
    throw new Rechazo(2)
  }
  return host
}

/** Escribir exige repetir el host: la única defensa contra un DATABASE_URL heredado de otra pestaña. */
export function exigirHostConfirmado(host: string): void {
  const confirmado = leerValor('--confirm-host')
  if (confirmado === host) return
  console.error('🔴 No se escribió NADA.')
  console.error(`Para escribir en esta base hay que repetir su host exacto:  --confirm-host=${host}`)
  console.error(confirmado === undefined ? 'No recibí --confirm-host.' : `Recibí «${confirmado}».`)
  throw new Rechazo(2)
}

function drenar(flujo: NodeJS.WriteStream): Promise<void> {
  if (flujo.writableLength === 0) return Promise.resolve()
  return new Promise(resolve => flujo.write('', () => resolve()))
}

/** Corre `main` y sale drenando stdout/stderr (un `process.exit` seco hacia un pipe se come el renglón con el host). */
export function correr(main: () => Promise<void>): void {
  main()
    .then(() => Promise.all([drenar(process.stdout), drenar(process.stderr)]))
    .then(() => process.exit(0))
    .catch(async e => {
      if (!(e instanceof Rechazo)) console.error(e)
      await Promise.all([drenar(process.stdout), drenar(process.stderr)])
      process.exit(e instanceof Rechazo ? e.codigo : 1)
    })
}
