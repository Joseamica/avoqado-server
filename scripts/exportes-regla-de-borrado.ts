/**
 * Regla de borrado del bucket para los exportes (Codex r5 B1; decisión del founder «a», 3-nov-2026).
 *
 * Agrega al bucket de Firebase Storage una regla de ciclo de vida de Google: `Delete` con `age: 8` y
 * `matchesPrefix: ['private/<env>/exports/']`. Así ningún archivo de exporte vive más de 8 días desde que nace, haga lo
 * que haga el código (la limpieza diaria lo borra a los 7 días y marca EXPIRED; esto es el cinturón que no depende de él).
 * Idempotente: si una regla igual o más amplia ya está, no cambia nada. Agrega SIN pisar las reglas que ya existan
 * (`addLifecycleRule`, append por default); NUNCA `setMetadata({ lifecycle })`, que las borraría.
 *
 *   npx tsx scripts/exportes-regla-de-borrado.ts --verificar        # sólo lee; sale con 1 si falta
 *   npx tsx scripts/exportes-regla-de-borrado.ts --entorno=dev      # agrega la regla de private/dev/exports/
 *
 * `--entorno` debe coincidir con `getStorageEnvPrefix()` (NODE_ENV): un candado contra escribir en el entorno que no era.
 * 🔴 En PRODUCCIÓN sólo con el «publica» del founder, como job de Render (Tarea 13, paso 5). Google tarda hasta 24 h en
 * aplicar un cambio de reglas.
 */
import 'dotenv/config'
import type { storage } from 'firebase-admin'
import { getStorageBucket } from '../src/config/firebase'
import { PRIVATE_PREFIX } from '../src/services/privateStorage.service'
import { getStorageEnvPrefix } from '../src/services/storage.service'

export const DIAS_DE_VIDA = 8

type Bucket = ReturnType<storage.Storage['bucket']>
type Regla = { action?: { type?: string }; condition?: { age?: number; matchesPrefix?: string[] } }
type Log = Pick<Console, 'log' | 'error'>

export const prefijoDeExportes = (env: string): string => `${PRIVATE_PREFIX}/${env}/exports/`

/** ¿Alguna regla ya borra TODO lo de `prefijo` a los 8 días o antes? Una con otras condiciones (sufijo, clase…) no cubre todo. */
export function yaTraeLaRegla(reglas: readonly Regla[] | null | undefined, prefijo: string): boolean {
  return (reglas ?? []).some(
    ({ action, condition: c }) =>
      action?.type === 'Delete' &&
      c != null &&
      typeof c.age === 'number' &&
      c.age <= DIAS_DE_VIDA &&
      (c.matchesPrefix ?? []).some(p => prefijo.startsWith(p)) &&
      Object.keys(c).every(k => k === 'age' || k === 'matchesPrefix'),
  )
}

export async function aplicarRegla(
  bucket: Pick<Bucket, 'name' | 'getMetadata' | 'addLifecycleRule'>,
  prefijo: string,
  soloVerificar: boolean,
  log: Log = console,
): Promise<0 | 1> {
  log.log(
    `Bucket: ${bucket.name} · prefijo: ${prefijo} · regla: Delete a los ${DIAS_DE_VIDA} días${soloVerificar ? ' · SÓLO VERIFICAR' : ''}`,
  )
  const [meta] = await bucket.getMetadata()
  if (yaTraeLaRegla(meta.lifecycle?.rule, prefijo)) {
    log.log('✅ La regla ya está: no se cambia nada.')
    return 0
  }
  if (soloVerificar) {
    log.error('❌ Falta la regla.')
    return 1
  }
  await bucket.addLifecycleRule(
    { action: { type: 'Delete' }, condition: { age: DIAS_DE_VIDA, matchesPrefix: [prefijo] } },
    { append: true, ifMetagenerationMatch: meta.metageneration }, // append explícito; si el bucket cambió en medio, Google la rechaza
  )
  const [despues] = await bucket.getMetadata()
  if (!yaTraeLaRegla(despues.lifecycle?.rule, prefijo)) {
    log.error('❌ Se pidió la regla y no aparece en el bucket.')
    return 1
  }
  log.log(`✅ Regla agregada (${despues.lifecycle?.rule?.length ?? 0} reglas en el bucket). Google tarda hasta 24 h en aplicarla.`)
  return 0
}

async function main(): Promise<number> {
  const soloVerificar = process.argv.includes('--verificar')
  const entorno = getStorageEnvPrefix()
  const pedido = process.argv.find(a => a.startsWith('--entorno='))?.slice('--entorno='.length)
  if (!soloVerificar && pedido !== entorno) {
    console.error(
      `❌ Este proceso escribe en «${entorno}» (NODE_ENV). Para agregar la regla pasa --entorno=${entorno}; para sólo leer, --verificar.`,
    )
    return 2
  }
  const storageAdmin = getStorageBucket()
  if (!storageAdmin) {
    console.error('❌ Firebase Storage no está configurado (FIREBASE_SERVICE_ACCOUNT_BASE64 o GOOGLE_APPLICATION_CREDENTIALS).')
    return 2
  }
  return aplicarRegla(storageAdmin.bucket(), prefijoDeExportes(entorno), soloVerificar)
}

// Sólo corre si se invoca directo; importarlo desde la prueba no dispara nada.
if (require.main === module) {
  main().then(
    codigo => (process.exitCode = codigo),
    err => {
      console.error(`❌ ${err?.message ?? err}`)
      process.exitCode = 1
    },
  )
}
