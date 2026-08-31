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
 * Comprueba que el clúster de Postgres sea EXACTAMENTE el que esta máquina reconoce como suyo.
 *
 * 🔴 Por qué no vale mirar la red, que fue mi primer intento y NO funcionaba: con
 * `ssh -L 5432:localhost:5432 produccion`, OpenSSH abre la conexión de destino **desde la
 * máquina remota**, así que el Postgres de producción la acepta sobre SU PROPIO loopback y
 * `inet_server_addr()` contesta `127.0.0.1`. La guarda pasaba feliz. Fabriqué una protección
 * que no protegía, que es peor que no tener ninguna (4ª auditoría de Codex, 31-ago-2026, P1 #3).
 *
 * Host, puerto, nombre y dirección son todos propiedades RELATIVAS a la conexión, y quien abre
 * el túnel las controla. Lo único que no puede falsificar es la identidad del clúster:
 * `pg_control_system().system_identifier` es un número que Postgres genera en el `initdb` y que
 * es distinto en cada instalación.
 *
 * El desarrollador lo autoriza UNA vez, a mano, en `AVQ_LOCAL_DB_ID` — ese paso humano es lo
 * que lo vuelve evidencia fuera de banda. Sin la variable no se adivina: se corta y se imprime
 * el identificador para que pueda copiarlo tras comprobar él mismo dónde está apuntando.
 */
export async function esClusterAutorizado(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<Array<Record<string, unknown>>>
}): Promise<ResultadoDelCorte> {
  let filas: Array<Record<string, unknown>>
  try {
    filas = await prisma.$queryRawUnsafe('SELECT system_identifier::text AS id, current_database() AS base FROM pg_control_system()')
  } catch (e) {
    // Si no se puede preguntar, no se puede afirmar que sea local.
    return { ok: false, motivo: `No pude identificar el clúster: ${(e as Error).message}` }
  }

  const id = String(filas?.[0]?.id ?? '')
  const base = String(filas?.[0]?.base ?? '')
  if (!id) return { ok: false, motivo: 'El servidor no reportó su identificador de clúster' }

  const autorizados = (process.env.AVQ_LOCAL_DB_ID ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

  if (autorizados.length === 0) {
    return {
      ok: false,
      base,
      motivo:
        `No hay ningún clúster autorizado. Comprueba TÚ que esta base sea la local y, si lo es, ` +
        `exporta AVQ_LOCAL_DB_ID=${id} (el identificador del clúster al que estás conectado ahora). ` +
        `No se adivina a propósito: un túnel SSH hace que producción se vea idéntica a localhost.`,
    }
  }

  if (!autorizados.includes(id)) {
    return {
      ok: false,
      base,
      motivo: `El clúster ${id} no está en AVQ_LOCAL_DB_ID. Si de verdad es tu base local, añádelo; si no, acabas de evitar un desastre.`,
    }
  }

  return { ok: true, base }
}

/**
 * El corte COMPLETO: la URL primero (barato, no abre conexión) y después la identidad del
 * clúster, que es lo único que un túnel no puede falsificar.
 *
 * Se llama con `await` desde el `main()` de cada script, ANTES de escribir o borrar nada.
 */
export async function exigirBaseLocalDeVerdad(prisma: {
  $queryRawUnsafe: (sql: string) => Promise<Array<Record<string, unknown>>>
}): Promise<void> {
  exigirBaseLocal()
  const r = await esClusterAutorizado(prisma)
  if (r.ok) return
  console.error('\n🔴 ABORTADO: la URL parecía local, pero no puedo probar que la base lo sea.')
  console.error(`   ${r.motivo}`)
  console.error('   Host, puerto y nombre los escribe quien abre el túnel; el identificador del clúster, no.\n')
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
