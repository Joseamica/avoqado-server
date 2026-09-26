/**
 * 🔴 `pg_advisory_xact_lock` devuelve `void`, y Prisma NO sabe deserializar una columna `void`: con
 * `$queryRaw` la consulta REVIENTA con «Failed to deserialize column of type 'void'» — siempre, no a
 * veces. Las formas correctas son `$executeRaw` (no lee el resultado) o castear: `...)::text`.
 *
 * Por qué es una guarda y no una prueba de cada servicio: con Prisma simulado la llamada «pasa», así
 * que NINGUNA prueba unitaria lo ve. Así llegó a producción el 22-sep (a901700a): la entrega del plan
 * (`entregarSuscripcionDePlan`) tomaba el candado del negocio con `$queryRaw` sin cast ⇒ Stripe cobraba
 * y el acceso nunca se concedía («Estamos confirmando tu pago» para siempre). Lo destapó el founder el
 * 26-sep pagando con una tarjeta de prueba. Eran SIETE sitios con el mismo patrón.
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function archivos(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivos(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

/** Cada `$queryRaw` cuyo SQL llama a un candado consultivo sin castear lo que devuelve. */
function candadosSinCast(codigo: string): string[] {
  const malos: string[] = []
  const inicio = /\$queryRaw(?:Unsafe)?\s*(?:<[^>]*>)?\s*[`(]/g
  let m: RegExpExecArray | null
  while ((m = inicio.exec(codigo))) {
    const trozo = codigo.slice(m.index, m.index + 600)
    const candado = /pg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\s*\(/.exec(trozo)
    if (!candado) continue
    // Recorre los paréntesis de la llamada al candado y mira qué sigue al que la cierra.
    let nivel = 0
    let fin = -1
    for (let i = candado.index + candado[0].length - 1; i < trozo.length; i++) {
      if (trozo[i] === '(') nivel++
      else if (trozo[i] === ')' && --nivel === 0) {
        fin = i
        break
      }
    }
    const despues = fin >= 0 ? trozo.slice(fin + 1) : ''
    // `pg_try_advisory_*` devuelve boolean (se deserializa bien); sólo los que devuelven void necesitan cast.
    const devuelveVoid = !/pg_try_/.test(candado[0])
    if (devuelveVoid && !/^\s*::\s*\w+/.test(despues)) malos.push(trozo.split('\n')[0].trim().slice(0, 140))
  }
  return malos
}

describe('ningún `$queryRaw` toma un candado consultivo sin castear su `void`', () => {
  it('🔴 todos los candados que devuelven void usan $executeRaw o `::text`', () => {
    const hallazgos = archivos(SRC).flatMap(f => candadosSinCast(fs.readFileSync(f, 'utf8')).map(l => `${path.relative(SRC, f)}: ${l}`))
    expect(hallazgos).toEqual([])
  })

  it('la guarda sí distingue (control)', () => {
    expect(candadosSinCast('await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`a:${b}`}))`')).toHaveLength(1)
    expect(candadosSinCast('await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`a:${b}`}))::text`')).toHaveLength(0)
    expect(candadosSinCast('await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`')).toHaveLength(0)
    expect(candadosSinCast('await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(1) AS ok`')).toHaveLength(0)
  })
})
