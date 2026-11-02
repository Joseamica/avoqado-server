/**
 * El archivo de secretos de los avisos de Rappi (`scripts/rappi-registrar-webhooks.ts`): escribirlo sin poder dejarlo a medias, y
 * que dos corridas no lo usen a la vez. Sin red y sin `@/config/env`; lo prueba `tests/unit/scripts/archivoDeSecretos.test.ts`
 * contra un directorio temporal real.
 *
 * 🔴 NUNCA `writeFileSync` SOBRE EL ARCHIVO DE SECRETOS: trunca el destino ANTES de escribir, y un disco lleno a media escritura lo
 * deja vacío. Ahí viven los secretos de los avisos de tienda, que Rappi no vuelve a mostrar (hallazgo #2 de Codex, bloque 0 de
 * «Rappi fase 2»). Toda escritura pasa por `escribirAtomico600`.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * Escribe `texto` en `ruta` de golpe: queda el contenido anterior o el nuevo, nunca uno a medias, y nunca con permisos abiertos.
 *  1. Un temporal en la MISMA carpeta (el `rename` sólo es atómico dentro del mismo disco), creado con `wx` (nunca reusa ni sigue
 *     un archivo que ya estuviera ahí) y modo 600 desde que nace: la umask sólo puede quitar permisos, y `fchmod` lo deja en 600
 *     exacto antes de escribir un solo byte.
 *  2. Se escribe completo y se confirma con `fsync` (un disco lleno puede avisar hasta ahí).
 *  3. `rename` encima del destino; el resultado conserva el 600 del temporal.
 * Si algo falla antes del `rename`, el destino no se tocó y el temporal se borra. El error sale tal cual.
 */
export function escribirAtomico600(ruta: string, texto: string): void {
  const temporal = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  const fd = fs.openSync(temporal, 'wx', 0o600)
  try {
    try {
      fs.fchmodSync(fd, 0o600)
      const datos = Buffer.from(texto, 'utf8')
      for (let escritos = 0; escritos < datos.length; ) escritos += fs.writeSync(fd, datos, escritos, datos.length - escritos)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporal, ruta)
  } catch (e) {
    fs.rmSync(temporal, { force: true })
    throw e
  }
}

/** Lo que dice un candado ajeno (pid y hora de quien lo tomó), en una línea y corto. Nunca lanza. */
function quienLoTiene(ruta: string): string {
  try {
    const texto = fs.readFileSync(ruta, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 200)
    return texto ? ` (dice: ${texto})` : ''
  } catch {
    return ''
  }
}

/**
 * Corre `tarea` con el candado `ruta` tomado y lo suelta al terminar, también si la tarea falla.
 *
 * 🔴 El candado es un archivo creado con `wx`: si ya existe, el sistema operativo se niega a crearlo, y eso es atómico aun entre
 * dos procesos que llegan al mismo tiempo. Entonces NO se corre nada y se dice qué hacer (hallazgo #3 de Codex: dos corridas a la
 * vez terminaban «bien» con claves distintas en Rappi y en disco).
 * 🔴 Un candado viejo (de una corrida que murió) NO se borra solo: desde aquí no hay forma segura de saber que esa corrida ya no
 * está escribiendo. Lo decide una persona, con la ruta que da el mensaje.
 * Al soltarlo sólo se borra si sigue siendo el NUESTRO: si alguien lo borró a mano y otra corrida tomó uno nuevo, ése no se toca.
 */
export async function conCandado<T>(ruta: string, tarea: () => Promise<T>): Promise<T> {
  const marca = `pid=${process.pid} desde=${new Date().toISOString()} id=${crypto.randomBytes(6).toString('hex')}\n`
  let fd: number
  try {
    fd = fs.openSync(ruta, 'wx', 0o600)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    throw new Error(
      `Ya existe el candado ${ruta}${quienLoTiene(ruta)}: hay otra corrida con este mismo archivo, o una anterior murió sin ` +
        `soltarlo. No se hizo nada. Si estás seguro de que no hay otra corrida, bórralo a mano: rm ${JSON.stringify(ruta)}`,
    )
  }
  try {
    try {
      fs.writeSync(fd, marca)
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    fs.rmSync(ruta, { force: true }) // es nuestro: lo acabamos de crear y no llegó a servir
    throw e
  }

  try {
    return await tarea()
  } finally {
    try {
      if (fs.readFileSync(ruta, 'utf8') === marca) fs.rmSync(ruta, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`🚨 No se pudo soltar el candado ${ruta}: bórralo a mano cuando estés seguro de que no hay otra corrida.`)
      }
    }
  }
}
