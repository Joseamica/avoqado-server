import { z } from 'zod'
import type { ProductoDelRecibo } from './productosDelRecibo'

/**
 * D1 «fotocopia del ticket» (28-oct): los renglones que imprimió el cobro de UNA parte de una venta dividida, tal cual los manda la
 * app en `/pay`. Es sólo el TEXTO del ticket: no dice qué está pagado (no toca inventario, la TPV, reportes ni devoluciones).
 * La reimpresión, el recibo digital y el correo de esa parte la pintan en vez de toda la venta.
 * Promesa y rondas de Codex: Avoqado/docs/audit/2026-10-28-parte-por-producto/.
 */
export type LineaDelTicket = {
  nombre: string
  cantidad: number
  unitarioCents: number
  totalCents: number
  modificadores?: string[]
  cortesia?: boolean
  /** Componente de un combo, en $0 (el combo lleva el precio). */
  pieza?: boolean
  /** Resumen impreso de un producto pesado («0.435 kg × $420.00/kg»). */
  peso?: string
  nota?: string
  /** Etiqueta del área de un vale. */
  area?: string
}

export type LineasDelTicket = {
  lineas: LineaDelTicket[]
  /** Σ de los renglones: la mercancía BRUTA del papel, sin propina. */
  subtotalCents: number
  /** El «Descuento» del papel: subtotal − lo cobrado sin propina. */
  descuentoCents: number
}

/** Mismo tope en la app y aquí: un cobro por petición queda muy lejos del límite del body (Codex plan r2 #2). */
export const TOPE_BYTES_DE_LA_COPIA = 8 * 1024

const centavos = z.number().int().nonnegative()
const texto = (max: number) => z.string().min(1).max(max)

const esquema = z.object({
  lineas: z
    .array(
      z.object({
        nombre: texto(120),
        cantidad: z.number().positive().finite(),
        unitarioCents: centavos,
        totalCents: centavos,
        modificadores: z.array(texto(60)).max(10).optional(),
        cortesia: z.boolean().optional(),
        pieza: z.boolean().optional(),
        peso: texto(40).optional(),
        nota: texto(140).optional(),
        area: texto(60).optional(),
      }),
    )
    .min(1)
    .max(100),
  subtotalCents: centavos,
  descuentoCents: centavos,
})

function leer(raw: unknown): LineasDelTicket | null {
  const r = esquema.safeParse(raw)
  if (!r.success) return null
  const copia = r.data
  if (JSON.stringify(copia).length > TOPE_BYTES_DE_LA_COPIA) return null
  if (copia.lineas.reduce((s, l) => s + l.totalCents, 0) !== copia.subtotalCents) return null
  return copia
}

/**
 * La copia que se guarda con el pago, o null. Tiene que cuadrar EXACTAMENTE con `aplicadoCents` (lo que quedó en el pago, sin
 * propina): si el servidor recortó el efectivo porque otra caja cobró en medio, ya no es el papel de este cobro y se descarta
 * (Codex plan r2 #5). Nunca lanza: el dinero ya se cobró.
 */
export function copiaQueCuadra(raw: unknown, aplicadoCents: number): LineasDelTicket | null {
  if (raw === undefined || raw === null) return null
  const copia = leer(raw)
  if (!copia || copia.subtotalCents - copia.descuentoCents !== aplicadoCents) return null
  return copia
}

/** La copia guardada en `Payment.processorData` (ya cuadró al escribirse), o null. */
export function copiaGuardada(processorData: unknown): LineasDelTicket | null {
  const raw = (processorData as { lineasDelTicket?: unknown } | null | undefined)?.lineasDelTicket
  return raw === undefined || raw === null ? null : leer(raw)
}

/** Los renglones de la copia en el formato del recibo digital (pesos). */
export function productosDeLaCopia(copia: LineasDelTicket): ProductoDelRecibo[] {
  return copia.lineas.map(l => ({
    name: l.nombre,
    quantity: l.cantidad,
    price: l.unitarioCents / 100,
    totalPrice: l.totalCents / 100,
    weightKg: null,
    ...(l.peso ? { peso: l.peso } : {}),
    ...(l.nota ? { nota: l.nota } : {}),
    ...(l.area ? { area: l.area } : {}),
    modifiers: (l.modificadores ?? []).map(name => ({ name, price: 0 })),
  }))
}

/**
 * Los totales que PINTAN el HTML legado y el correo cuando el recibo trae copia: el subtotal y el «Descuento» del papel; la propina y
 * el total, los del cobro. `ticketTotals` NO se toca (lo leen las apps viejas, que imprimirían «Pago parcial» con el bruto).
 * Sin cargo ni IVA aparte: la copia ya cuadra con lo cobrado sin propina, así que subtotal − descuento + propina = total.
 */
export function totalesConLaCopia<T extends { subtotal: number; discount?: number; serviceCharge: number; addedTax: number }>(
  totales: T,
  snapshot: unknown,
): T {
  const copia = copiaGuardada(snapshot)
  if (!copia) return totales
  const { discount: _sinDescuento, ...resto } = totales
  return {
    ...resto,
    subtotal: copia.subtotalCents / 100,
    serviceCharge: 0,
    addedTax: 0,
    ...(copia.descuentoCents > 0 ? { discount: copia.descuentoCents / 100 } : {}),
  } as T
}
