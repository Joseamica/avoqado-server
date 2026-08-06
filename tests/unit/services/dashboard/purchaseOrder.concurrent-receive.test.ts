/**
 * Guardia contra la pérdida de recepciones por concurrencia.
 *
 * Ambos caminos de recepción escribían el saldo del insumo como VALOR ABSOLUTO,
 * calculado desde una lectura previa:
 *
 *     currentStock: previousStock.add(recibido)     // ❌ pierde actualizaciones
 *
 * Con eso, dos renglones del mismo insumo en una misma orden —o dos recepciones
 * concurrentes de dos paradores distintos— hacían que la segunda escritura pisara
 * a la primera: se perdía una recepción completa, en silencio.
 *
 * Estar dentro de una transacción NO lo previene: con el aislamiento por defecto
 * de PostgreSQL (READ COMMITTED) dos transacciones pueden leer el mismo saldo y
 * ambas escribir el suyo. Sólo delegar la suma a la base lo evita:
 *
 *     currentStock: { increment: recibido }         // ✅ atómico
 *
 * Esta prueba verifica la FORMA de la escritura, que es lo que da la garantía.
 * Si alguien vuelve a poner una asignación absoluta, truena.
 */
import * as fs from 'fs'
import * as path from 'path'

const ARCHIVO = path.join(__dirname, '../../../../src/services/dashboard/purchaseOrder.service.ts')

describe('recepción de órdenes de compra: incremento atómico del saldo', () => {
  const fuente = fs.readFileSync(ARCHIVO, 'utf8')

  it('NO escribe currentStock como valor absoluto en ningún camino', () => {
    // Cualquier `currentStock: <algo>` que no sea un objeto `{ increment | decrement }`
    // es una asignación absoluta y reintroduce la pérdida de actualizaciones.
    // Se excluyen `true`/`false`, que son cláusulas `select` de Prisma, no escrituras.
    const asignacionesAbsolutas = (fuente.match(/currentStock:\s*(?!\{)\w+/g) || []).filter(m => !/:\s*(true|false)$/.test(m))

    expect(asignacionesAbsolutas).toEqual([])
  })

  it('usa increment en el camino legacy (receivePurchaseOrder)', () => {
    const legacy = fuente.slice(
      fuente.indexOf('export async function receivePurchaseOrder'),
      fuente.indexOf('export async function applyItemReceiveStatusInTx'),
    )

    expect(legacy).toContain('currentStock: { increment:')
  })

  it('usa increment en el camino moderno (applyItemReceiveStatusInTx)', () => {
    const moderno = fuente.slice(fuente.indexOf('export async function applyItemReceiveStatusInTx'))

    expect(moderno).toContain('currentStock: { increment:')
  })

  it('el camino moderno sigue recibiendo el cliente de transacción como primer parámetro', () => {
    // Si alguien le quita el `tx`, las escrituras dejan de ser atómicas entre sí
    // y los lotes pueden quedar huérfanos ante un fallo parcial.
    expect(fuente).toMatch(/export async function applyItemReceiveStatusInTx\(\s*tx: Prisma\.TransactionClient/)
  })

  it('deja constancia de por qué no se puede usar asignación absoluta', () => {
    // El comentario es parte de la defensa: sin el porqué, el siguiente que pase
    // "simplifica" el increment y vuelve a meter el bug.
    expect(fuente).toContain('READ COMMITTED')
  })
})
