/**
 * Plan Básico (revisión de Task 6, hallazgo 1): la preferencia que apaga los avisos SIN cobro es `SUBSCRIPTION_CANCELLED`
 * porque ningún aviso del producto usa ese tipo: una fila suya sólo la escribe una decisión explícita (la baja en un clic o
 * su interruptor). Si alguien empieza a mandar avisos con él, `createNotification` crearía sola una fila `[IN_APP]` y esa
 * fila apagaría en silencio «Tu prueba termina» / «Tu prueba terminó» — justo el defecto que se corrigió. Este guardia lo
 * impide: el tipo sólo puede aparecer en `notifications/avisosSinCobro.ts`. Además el servidor rechaza mandarlo
 * (`createNotification` y los envíos del dashboard) y toda fila nueva suya nace con correo (`canalesAlCrear`).
 */
import fs from 'fs'
import path from 'path'

// Los demás usan la constante `TIPO_AVISOS_SIN_COBRO`; sólo su módulo nombra el tipo.
const PERMITIDOS = new Set(['src/services/notifications/avisosSinCobro.ts'])

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivos(p) : /\.ts$/.test(e.name) ? [p] : []
  })
}

describe('guardia: SUBSCRIPTION_CANCELLED sólo para la preferencia de los avisos sin cobro', () => {
  it('no aparece fuera de la baja del plan', () => {
    const raiz = path.resolve(__dirname, '../../..')
    const usos = archivos(path.join(raiz, 'src'))
      .map(f => path.relative(raiz, f).split(path.sep).join('/'))
      .filter(f => !PERMITIDOS.has(f) && fs.readFileSync(path.join(raiz, f), 'utf8').includes('SUBSCRIPTION_CANCELLED'))
    expect(usos).toEqual([])
  })
})
