// src/services/dashboard/staffPay/recibos.formato.ts — cómo se LEE un renglón del recibo: su concepto, las columnas del PDF y
// del Excel y los totales por tipo de arriba. Puro: sin base ni permisos (E6a-fix F13 lo saca de `recibos.service.ts`, que ya
// pasaba de 500 líneas; el servicio lo re-exporta para sus llamadores).
import { Prisma } from '@prisma/client'
import { ExportColumnDef, fechaMx } from '../export.helpers'
import { MESES_LARGOS } from './periodos'
import { ReglaDeClase, textoDeRegla } from './valoracion'

export interface RenglonRecibo {
  tipo: 'CLASE' | 'DIFERENCIA' | 'AJUSTE' | 'COMISION' | 'PROPINA'
  fecha: string
  hora: string | null
  sede: string
  concepto: string
  lugares: number | null
  monto: string
}

/** Una fila de la fuente del recibo: la misma forma para lo congelado y para lo valorado en vivo. */
export interface FilaRecibo {
  tipo: RenglonRecibo['tipo']
  instante: Date
  id: string
  venueId: string
  fecha: string
  hora: string | null
  clase: string | null
  sedeFoto: string | null
  reason: string | null
  /** De una DIFERENCIA: el inicio del periodo de origen de su clase (`descriptor.periodoOrigen.start`, B2). */
  origen: string | null
  lugares: number | null
  monto: Prisma.Decimal
  /**
   * Columna 13 de la fuente, justo después de `monto`, en TODOS los brazos (contrato con el Bloque D, D3c): la regla de
   * clase que movió el monto (suplencia, cancelación tardía). B5 la deja `NULL::jsonb` en todos; D3c sólo la llena en las
   * ramas de CLASES (en vivo y congeladas). Ventas, ajustes, diferencias y filas agrupadas la dejan en NULL.
   */
  regla: Prisma.JsonValue | null
  /** De una venta (comisión o propina): número de orden, esquema, base y motivo (VENTA | DEVOLUCION | ANULACION). */
  orden: string | null
  esquema: string | null
  base: Prisma.Decimal | null
  /** De una comisión por porcentaje: la tasa aplicada («0.0300»), de su foto o en vivo (E6a-fix F13); null en lo demás. */
  tasa: Prisma.Decimal | null
  /** Final-fix G6: una venta que el esquema subió a su mínimo o bajó a su tope (`DescriptorVenta.limite`); null en lo demás. */
  limite: 'MINIMO' | 'TOPE' | null
  motivo: string | null
  /** Propinas de un día juntas (pantalla y PDF): `cobros` dice cuántas. */
  agrupada: boolean
  cobros: number
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`
const ventaDe = (r: FilaRecibo) => (r.orden ? `venta #${r.orden}` : null)
/**
 * E6a-fix F13 (QA E6a H11): el nombre del esquema SIN su «Comisión» del frente, que el concepto ya lleva («Comisión Estándar
 * Meseros» decía «Comisión Comisión Estándar Meseros»). Sólo la palabra al inicio; el resto del nombre queda igual.
 */
const esquemaSinPrefijo = (esquema: string | null) => (esquema ?? '').replace(/^comisi[oó]n(es)?(\s+|$)/i, '').trim() || null
/** «3 %», «2.5 %»: la tasa aplicada sin ceros de más (E6a-fix F13). Sólo la traen las comisiones por porcentaje o por niveles. */
const tasaDe = (r: FilaRecibo) => (r.tasa === null ? null : `${Number(new Prisma.Decimal(r.tasa).times(100).toFixed(2))} %`)

/**
 * Una comisión dice su esquema, su venta y su base (spec fase 3 §11): «Comisión Lagree 3 % · venta #1042 · base
 * $3,000.00»; una devolución o una anulación lo dicen al frente. Las propinas de un día van juntas en pantalla y PDF
 * («Propinas del 12 ago 2026 · 2 cobros») y una por cobro en el Excel («Propina · venta #1042»).
 */
export function conceptoDe(r: FilaRecibo): string {
  if (r.tipo === 'AJUSTE') return r.reason ?? 'Ajuste'
  if (r.tipo === 'PROPINA') {
    if (r.agrupada) {
      return r.motivo === 'DEVOLUCION'
        ? `Propinas devueltas del ${fechaMx(r.fecha)} · ${plural(r.cobros, 'devolución', 'devoluciones')}`
        : `Propinas del ${fechaMx(r.fecha)} · ${plural(r.cobros, 'cobro', 'cobros')}`
    }
    return [r.motivo === 'DEVOLUCION' ? 'Devolución de propina' : 'Propina', ventaDe(r)].filter(Boolean).join(' · ')
  }
  if (r.tipo === 'COMISION') {
    const cabeza = r.motivo === 'ANULACION' ? 'Anulación · comisión' : r.motivo === 'DEVOLUCION' ? 'Devolución · comisión' : 'Comisión'
    const venta = r.motivo === 'VENTA' && r.base !== null
    // Final-fix G6: «base $1.00 → mínimo $5.00»: el 3 % de la base no da el monto porque el esquema lo subió o lo bajó.
    const limite = venta && r.limite ? ` → ${r.limite === 'MINIMO' ? 'mínimo' : 'tope'} ${pesos.format(Number(r.monto))}` : ''
    const base = venta ? `base ${pesos.format(Number(r.base))}${limite}` : null
    const quien = [cabeza, esquemaSinPrefijo(r.esquema), tasaDe(r)].filter(Boolean).join(' ')
    return [quien, ventaDe(r), base].filter(Boolean).join(' · ')
  }
  const clase = r.clase ?? 'Clase'
  // `regla` sólo la llenan los brazos de clases, con la forma de `ReglaDeClase` (D3a).
  if (r.tipo === 'CLASE') return r.regla ? `${clase} · ${textoDeRegla(r.regla as ReglaDeClase)}` : clase
  // Una diferencia dice de qué clase es (QA bloque B, defecto 3): «Diferencia · Yoga del 28 sep 2026 (clase de septiembre)».
  // La fecha es la local de la clase en su sede (la de su foto) y el mes, el de su periodo de origen.
  const mes = r.origen ? ` (clase de ${MESES_LARGOS[Number(r.origen.slice(5, 7)) - 1]})` : ''
  return `Diferencia · ${clase} del ${fechaMx(r.fecha)}${mes}`
}

/** Las filas que reciben LOS DOS formatos, PDF y Excel (Codex R2-R1-14): cada renglón con su signo + el total. Pura. */
export function filasDelRecibo(r: { renglones: RenglonRecibo[]; total: string; parcial: boolean }): RenglonRecibo[] {
  return [
    ...r.renglones,
    {
      tipo: 'AJUSTE',
      fecha: '',
      hora: null,
      sede: '',
      concepto: r.parcial ? 'Total (vista parcial)' : 'Total',
      lugares: null,
      monto: r.total,
    },
  ]
}

const pesos = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
/** «29 sep 2026»; un ajuste se fecha cuando se capturó y lo dice. La fila del total va sin fecha. */
const fechaDelRenglon = (r: RenglonRecibo) => (r.fecha ? `${fechaMx(r.fecha)}${r.tipo === 'AJUSTE' ? ' (captura)' : ''}` : '')
/**
 * `pdfAncho`: el Concepto se lleva casi la mitad de la hoja para que una diferencia se lea entera en el PDF («Diferencia ·
 * Yoga (clase grupal) del 28 sep 2026 (clase de septiembre)», ~280 pt a 9 pt) sin cortar fecha de captura, sede ni monto.
 */
const COLUMNAS: ExportColumnDef<RenglonRecibo>[] = [
  { id: 'fecha', label: 'Fecha', value: fechaDelRenglon, pdfAncho: 1.3 },
  { id: 'hora', label: 'Hora', value: r => r.hora, pdfAncho: 0.6 },
  // E6a-fix F13 (QA E6a H13): el concepto de una comisión («… · venta #… · base $…») y el nombre largo de una sede no caben en
  // una línea: se parten, no se cortan con «…».
  { id: 'sede', label: 'Sede', value: r => r.sede, pdfAncho: 1.5, pdfAjustar: true },
  { id: 'concepto', label: 'Concepto', value: r => r.concepto, pdfAncho: 4, pdfAjustar: true },
  { id: 'lugares', label: 'Lugares', value: r => r.lugares, pdfAncho: 0.7 },
  { id: 'monto', label: 'Monto', value: r => pesos.format(Number(r.monto)), pdfAncho: 1 },
]
/** El Excel lleva el monto como NÚMERO con formato de moneda (el dueño lo suma); `monto` ya viene con 2 decimales. */
const COLUMNAS_EXCEL: ExportColumnDef<RenglonRecibo>[] = COLUMNAS.map(c =>
  c.id === 'monto' ? { ...c, value: r => Number(r.monto), numFmt: '$#,##0.00' } : c,
)
/** Las columnas de cada formato (exportada para su prueba). */
export const columnasDelRecibo = (formato: 'pdf' | 'xlsx') => (formato === 'xlsx' ? COLUMNAS_EXCEL : COLUMNAS)

/** El orden y el nombre de cada tipo en los totales de arriba: los mismos que la pantalla (`DesglosePersona`, `period.byType`). */
const TIPOS_DEL_RECIBO: Array<[RenglonRecibo['tipo'], string]> = [
  ['CLASE', 'Clases'],
  ['COMISION', 'Comisiones'],
  ['PROPINA', 'Propinas'],
  ['DIFERENCIA', 'Diferencias'],
  ['AJUSTE', 'Ajustes'],
]
/**
 * E6a-fix F13 (QA E6a H13): «Clases $6,210.00 · Comisiones $222.38 · Propinas $220.92», la línea de arriba del PDF, como en
 * pantalla. Con un solo tipo no se repite (ya es el «Total»). Pura (exportada para su prueba).
 */
export function totalesPorTipoDelRecibo(porTipo: Partial<Record<RenglonRecibo['tipo'], string>>): string[] {
  const tipos = TIPOS_DEL_RECIBO.filter(([tipo]) => porTipo[tipo] != null)
  return tipos.length > 1 ? [tipos.map(([tipo, nombre]) => `${nombre} ${pesos.format(Number(porTipo[tipo]))}`).join(' · ')] : []
}
export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
