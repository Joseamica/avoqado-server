// src/services/dashboard/staffPay/huella.ts
import { createHash, Hash } from 'crypto'
import { Prisma } from '@prisma/client'
import type { ClaseValorada } from './valoracion'
import type { LineaBarrible } from './fuentesVenta'

const val = (x: string | number | boolean | null | undefined): string =>
  x === null || x === undefined ? '∅' : typeof x === 'boolean' ? (x ? '1' : '0') : String(x)
const dinero = (d: Prisma.Decimal | string | null): string => (d === null ? '∅' : new Prisma.Decimal(d).toFixed(2))

export function filaCanonicaDeClase(c: ClaseValorada): string {
  return [
    'C',
    c.venueId,
    c.classSessionId,
    val(c.staffId),
    c.fechaValoracion,
    val(c.tableVersionId),
    val(c.payLevelId),
    val(c.conteo),
    val(c.payCountOverride),
    c.payAmountOverride === null ? '∅' : dinero(c.payAmountOverride),
    val(c.excluida),
    c.estado,
    dinero(c.monto),
  ].join('|')
}

/**
 * Spec fase 3 §6.5: M (comisión) y T (propina) llevan id, persona, sede, fecha local y monto; X (reverso por anulación),
 * id, persona y monto. El descriptor (nombres para mostrar) no entra: renombrar un esquema no invalida una vista previa.
 */
export function filaCanonicaDeVenta(l: LineaBarrible): string {
  if (l.concepto === 'RECONCILE') return ['X', l.sourceId, l.staffId, dinero(l.monto)].join('|')
  return [l.fuente === 'COMMISSION' ? 'M' : 'T', l.sourceId, l.staffId, l.venueId, l.fechaLocal, dinero(l.monto)].join('|')
}

/**
 * Huella incremental (spec §6.3 punto 4): `update` por fila, así no depende del tamaño del lote. El preview y el
 * cierre la calculan con esta MISMA clase y en el mismo orden (sede → clase → comisiones → propinas → reversos →
 * ajustes → huérfanas), y el dashboard / MCP la devuelven al confirmar.
 */
export class Huella {
  private readonly h: Hash = createHash('sha256')
  private linea(s: string) {
    this.h.update(`${s}\n`)
  }
  /** Sin el id del periodo: en el preview puede no estar guardado todavía y nacer al cerrar con otro id. */
  cabecera(p: { organizationId: string; start: string; end: string; venueIds: string[] }) {
    this.linea(['P', p.organizationId, p.start, p.end, [...p.venueIds].sort().join(',')].join('|'))
  }
  clase(c: ClaseValorada) {
    this.linea(filaCanonicaDeClase(c))
  }
  ajuste(a: { id: string; staffId: string; venueId: string; amount: Prisma.Decimal | string }) {
    this.linea(['A', a.id, a.staffId, a.venueId, dinero(a.amount)].join('|'))
  }
  comision(l: LineaBarrible) {
    this.venta(l, 'M')
  }
  propina(l: LineaBarrible) {
    this.venta(l, 'T')
  }
  reverso(l: LineaBarrible) {
    this.venta(l, 'X')
  }
  /** Una fila en el método equivocado cambiaría el orden de la huella sin que nadie lo note: se niega. */
  private venta(l: LineaBarrible, tipo: 'M' | 'T' | 'X') {
    const fila = filaCanonicaDeVenta(l)
    if (!fila.startsWith(`${tipo}|`)) throw new Error(`Huella: una fila ${fila[0]} no va donde las ${tipo}`)
    this.linea(fila)
  }
  huerfana(id: string) {
    this.linea(`H|${id}`)
  }
  /** Se llama UNA vez por instancia: `Hash.digest()` lanza ERR_CRYPTO_HASH_FINALIZED en la segunda. */
  digest(): string {
    return this.h.digest('hex')
  }
}
