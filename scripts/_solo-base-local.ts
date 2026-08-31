/**
 * Cortafuegos para los scripts de prueba: **se niegan a correr si la base no es LOCAL**.
 *
 * 🔴 Hallazgo #9 de la auditoría de Codex (29-ago-2026). Los scripts de horas extra borran
 * autorizaciones, borran asientos de bitácora y SOBRESCRIBEN cuadrantes de empleados activos.
 * Nada impedía correrlos con una `DATABASE_URL` de staging o de producción apuntada por
 * accidente — y `--limpiar` ni siquiera restaura los cuadrantes que pisó.
 *
 * El coste de equivocarse es asimétrico: si esto rechaza una base local rara, alguien pierde
 * un minuto; si deja pasar producción, se pierden datos de nómina. Por eso la lista de lo
 * permitido es corta y explícita, y ante la duda **corta**.
 */

/** Hosts que se consideran locales. Nada de comodines: si no está aquí, no corre. */
const HOSTS_LOCALES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

/** Fragmentos que delatan un entorno remoto aunque el host pareciera local. */
const SEÑALES_REMOTAS = ['render.com', 'fly.dev', 'neon.tech', 'supabase', 'rds.amazonaws', 'azure', 'digitalocean']

/**
 * 🔴 Un host local NO prueba que la base sea local: `-L 5433:prod:5432` deja producción
 * escuchando en `localhost` (2ª auditoría de Codex, 30-ago-2026, P1 #6). Dos cortes más:
 *
 *  · el PUERTO tiene que ser el de Postgres. Un túnel se abre casi siempre en otro puerto
 *    para no chocar con el Postgres que ya corre en el 5432;
 *  · el NOMBRE de la base tiene que ser uno conocido de desarrollo.
 *
 * ⚠️ Lo que sigue SIN cubrir, dicho explícitamente: alguien que tunelice producción al
 * 5432 **y** la llame `av-db-25` pasa el corte. Eso ya es apuntarse a los pies a propósito;
 * lo que se cierra aquí es el accidente.
 */
const PUERTOS_LOCALES = new Set(['5432', ''])
const BASES_LOCALES = new Set(['av-db-25', 'avoqado', 'avoqado_dev', 'postgres'])

export interface ResultadoDelCorte {
  ok: boolean
  motivo?: string
  host?: string
  base?: string
}

/** Comprueba una URL de conexión. Separada de `exigirBaseLocal` para poder probarla. */
export function esBaseLocal(databaseUrl: string | undefined): ResultadoDelCorte {
  if (!databaseUrl) return { ok: false, motivo: 'No hay DATABASE_URL definida' }

  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    // Si no se puede leer, no se puede afirmar que sea local. Se corta.
    return { ok: false, motivo: 'La DATABASE_URL no se pudo interpretar' }
  }

  const host = url.hostname
  const base = url.pathname.replace(/^\//, '')

  const remota = SEÑALES_REMOTAS.find(s => databaseUrl.includes(s))
  if (remota) return { ok: false, motivo: `La URL apunta a un proveedor remoto (${remota})`, host, base }

  if (!HOSTS_LOCALES.has(host)) return { ok: false, motivo: `El host "${host}" no es local`, host, base }

  if (!PUERTOS_LOCALES.has(url.port)) {
    return {
      ok: false,
      motivo: `El puerto ${url.port} no es el de Postgres — un host local en otro puerto suele ser un túnel SSH a un servidor remoto`,
      host,
      base,
    }
  }

  if (!BASES_LOCALES.has(base) && !/[-_]test$/.test(base)) {
    return { ok: false, motivo: `La base "${base}" no está en la lista de bases de desarrollo`, host, base }
  }

  return { ok: true, host, base }
}

/**
 * Le pregunta al SERVIDOR dónde está, en vez de creerle a la URL.
 *
 * 🔴 Por qué hace falta, y por qué la comprobación de arriba no basta (3ª auditoría de Codex,
 * 31-ago-2026, P1 #4): host, puerto y nombre salen todos de la MISMA cadena, y esa cadena la
 * escribe quien abre el túnel. `ssh -L 5432:produccion:5432` deja producción respondiendo en
 * `localhost:5432`, y si además la base se llama `av-db-25` la URL pasa entera. La URL del
 * cliente nunca puede probar dónde termina el socket.
 *
 * `inet_server_addr()` es evidencia INDEPENDIENTE: la devuelve el propio servidor y dice en qué
 * dirección está escuchando ÉL. Un Postgres de verdad local contesta `NULL` (socket unix) o una
 * de loopback; uno alcanzado por túnel contesta su propia IP, que no es ninguna de las dos.
 *
 * ⚠️ Sobre-atrapar es seguro: lo peor que pasa es que alguien con un Postgres en Docker tenga
 * que añadir su red aquí. Sub-atrapar borra datos de nómina.
 */
export async function esServidorLocal(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<Array<Record<string, unknown>>>
}): Promise<ResultadoDelCorte> {
  let filas: Array<Record<string, unknown>>
  try {
    filas = await prisma.$queryRawUnsafe(
      "SELECT host(coalesce(inet_server_addr(), '127.0.0.1'::inet)) AS dir, current_database() AS base",
    )
  } catch (e) {
    // Si no se puede preguntar, no se puede afirmar que sea local.
    return { ok: false, motivo: `No pude preguntarle al servidor dónde está: ${(e as Error).message}` }
  }

  const dir = String(filas?.[0]?.dir ?? '')
  const base = String(filas?.[0]?.base ?? '')
  if (!dir) return { ok: false, motivo: 'El servidor no reportó su dirección' }

  const esLoopback = dir === '127.0.0.1' || dir === '::1' || dir.startsWith('127.')
  if (!esLoopback) {
    return {
      ok: false,
      motivo: `El servidor de Postgres está escuchando en ${dir}, no en loopback — la URL dice «localhost» pero el socket termina en otra máquina (¿un túnel?)`,
      host: dir,
      base,
    }
  }

  return { ok: true, host: dir, base }
}

/**
 * El corte COMPLETO: la URL primero (barato, no abre conexión) y después el servidor.
 *
 * Se llama con `await` desde el `main()` de cada script, ANTES de escribir o borrar nada.
 */
export async function exigirBaseLocalDeVerdad(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<Array<Record<string, unknown>>>
}): Promise<void> {
  exigirBaseLocal()
  const r = await esServidorLocal(prisma)
  if (r.ok) return
  console.error('\n🔴 ABORTADO: la URL parecía local, pero el servidor no lo es.')
  console.error(`   ${r.motivo}`)
  console.error('   Un túnel SSH deja una base REMOTA respondiendo en localhost.\n')
  process.exit(1)
}

/**
 * Corta el proceso si la base no es local. Se llama ANTES de sembrar o borrar nada.
 *
 * Sale con código 1 y un mensaje que dice qué pasó, en vez de lanzar: estos son scripts de
 * consola y una excepción con stack no comunica mejor que una línea clara.
 */
export function exigirBaseLocal(): void {
  const r = esBaseLocal(process.env.DATABASE_URL)
  if (r.ok) return
  console.error('\n🔴 ABORTADO: este script escribe y BORRA datos, y sólo puede correr contra la base local.')
  console.error(`   ${r.motivo}`)
  if (r.host) console.error(`   host: ${r.host}   base: ${r.base}`)
  console.error('   Si de verdad quieres correrlo aquí, cambia la DATABASE_URL a localhost.\n')
  process.exit(1)
}
