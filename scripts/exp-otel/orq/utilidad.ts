/**
 * EXPERIMENTO OTel — UTILIDAD (plan 1a/1b/1c; corrección 6). En el runner. BRAZO=… REP=n.
 *
 * Cinco corridas por brazo, en orden aleatorio reproducible, cada una con server y base nuevos:
 *   referencia (sin falla) · db_lenta · cpu · externa_lenta (SINTÉTICA) · efecto_falla
 * Cada corrida queda en exp-out/utilidad/<id-al-azar>/ con SÓLO lo crudo que vería quien investiga: servidor.log,
 * los spans exportados por el colector (familia B), llaves.json (la llave de partida de cada cobro) y meta.json
 * (brazo, repetición, y si es la referencia). QUÉ falla se sembró va aparte, en exp-out/claves/, que el calificador
 * no lee. `entorno.json` omite EXP_INYECTOR.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { OUT, Brazo, barajar, correrActoresAsync, escribirJson, log } from '../lib/comun'
import { bajar, entornoActores, levantar, prepararBase } from './base'

const BRAZO = (process.env.BRAZO || 'A') as Brazo
const REP = Number(process.env.REP || 1)

async function main() {
  await prepararBase()
  const fallas = barajar(['referencia', 'db_lenta', 'cpu', 'externa_lenta', 'efecto_falla'], REP * 31337 + BRAZO.charCodeAt(0) + BRAZO.length)
  const clave: Record<string, string> = {}
  for (const falla of fallas) {
    const id = crypto.randomBytes(6).toString('hex')
    clave[id] = falla
    const dir = path.join(OUT, 'utilidad', id)
    const extra: Record<string, string> = falla === 'referencia' ? {} : { EXP_INYECTOR: falla, EXP_FALSO_URL: 'http://servicios:8080/lento' }
    const l = await levantar(BRAZO, `u-${BRAZO}-${REP}-${id}`, dir, { extra, conExternoFalso: true })
    const codigo = await correrActoresAsync('scripts/exp-otel/actores/utilidad.ts', entornoActores(l, { CORRIDA: '.', OUT_DIR: dir, N_COBROS: '5' }))
    await bajar(l)
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ brazo: BRAZO, rep: REP, esReferencia: falla === 'referencia', codigoActores: codigo }))
    log(`utilidad ${BRAZO} rep ${REP}: corrida ${id} lista (actores ${codigo})`)
  }
  escribirJson(`claves/utilidad-${BRAZO.replace('+', 'mas')}-rep${REP}.json`, clave)
}

main().catch(e => {
  console.error('❌ utilidad:', e)
  process.exit(1)
})
