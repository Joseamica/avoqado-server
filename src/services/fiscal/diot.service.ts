import { type DiotTipoTercero } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * DIOT (Declaración Informativa de Operaciones con Terceros) — read-model sobre los GASTOS.
 *
 * La DIOT lista, por proveedor, el IVA que el contribuyente PAGÓ (cash-basis) en el periodo,
 * separado por tipo de tercero (04 nacional / 05 extranjero / 15 global) y por tasa. Se alimenta
 * de los CFDIs recibidos (Expense) PAGADOS, deducibles y con IVA acreditable del periodo — la
 * MISMA población que `getAcreditablePagado`, así que el IVA acreditable total de la DIOT DEBE
 * cuadrar con el del IVA-flujo (se expone `cuadraConIvaFlujo` para verificarlo). Gated PREMIUM (CFDI).
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Código de tercero del formato DIOT del SAT. */
const TIPO_TERCERO_CODIGO: Record<DiotTipoTercero, string> = {
  NACIONAL: '04',
  EXTRANJERO: '05',
  GLOBAL: '15',
}

export interface DiotRow {
  proveedorRfc: string
  proveedorNombre: string
  tipoTercero: DiotTipoTercero
  /** Código de tercero DIOT (04/05/15). */
  tipoTerceroCodigo: string
  /** Valor de los actos gravados a 16% (base, sin IVA). */
  base16Cents: number
  /** IVA acreditable pagado a 16%. */
  iva16Cents: number
  base8Cents: number
  iva8Cents: number
  /** Valor de actos a tasa 0%. */
  base0Cents: number
  /** Valor de actos exentos. */
  exentoCents: number
  /** IVA retenido al proveedor por el contribuyente. */
  ivaRetenidoCents: number
  /** IVA acreditable total del proveedor en el periodo (= iva16 + iva8). */
  ivaAcreditableCents: number
  /** CFDIs del proveedor incluidos. */
  comprobantes: number
}

export interface DiotResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  rows: DiotRow[]
  totals: {
    proveedores: number
    comprobantes: number
    base16Cents: number
    iva16Cents: number
    base8Cents: number
    iva8Cents: number
    base0Cents: number
    exentoCents: number
    ivaRetenidoCents: number
    ivaAcreditableCents: number
  }
  /** El IVA acreditable total de la DIOT cuadra con el IVA-flujo (mismo cálculo, sanity check). */
  cuadraConIvaFlujo: boolean
}

const round = (n: number) => Math.round(n)

/** Base de un IVA a una tasa (deriva la base cuando el desglose no la trae explícita). */
function baseFromIva(ivaCents: number, rate: number): number {
  if (ivaCents <= 0 || rate <= 0) return 0
  return round(ivaCents / rate)
}

/**
 * DIOT del periodo para el contribuyente (org, RFC) del local. Agrupa por proveedor los gastos
 * PAGADOS, INGRESO, deducibles y con IVA acreditable cuyo `paidPeriod` == period (no cancelados),
 * de TODOS los locales del RFC. Devuelve `needsFiscalSetup` si el local no tiene RFC fiscal.
 */
export async function getDiot(venueId: string, period: string): Promise<DiotResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) {
    return {
      needsFiscalSetup: true,
      organizationId: null,
      rfc: null,
      period,
      rows: [],
      totals: {
        proveedores: 0,
        comprobantes: 0,
        base16Cents: 0,
        iva16Cents: 0,
        base8Cents: 0,
        iva8Cents: 0,
        base0Cents: 0,
        exentoCents: 0,
        ivaRetenidoCents: 0,
        ivaAcreditableCents: 0,
      },
      cuadraConIvaFlujo: true,
    }
  }

  const expenses = await prisma.expense.findMany({
    where: {
      rfc: scope.rfc,
      status: 'REGISTERED',
      comprobanteTipo: 'INGRESO',
      deducible: true,
      ivaAcreditable: true,
      paymentStatus: 'PAID',
      paidPeriod: period,
    },
    select: {
      proveedorRfc: true,
      proveedorNombre: true,
      tipoTercero: true,
      ivaCents: true,
      iva16Cents: true,
      iva8Cents: true,
      iva0BaseCents: true,
      exentoBaseCents: true,
      ivaRetenidoCents: true,
    },
  })

  // Agrupa por (proveedorRfc, tipoTercero). El proveedorNombre toma el del primer CFDI visto.
  const groups = new Map<string, DiotRow>()
  for (const e of expenses) {
    const key = `${e.proveedorRfc}|${e.tipoTercero}`
    let row = groups.get(key)
    if (!row) {
      row = {
        proveedorRfc: e.proveedorRfc,
        proveedorNombre: e.proveedorNombre,
        tipoTercero: e.tipoTercero,
        tipoTerceroCodigo: TIPO_TERCERO_CODIGO[e.tipoTercero],
        base16Cents: 0,
        iva16Cents: 0,
        base8Cents: 0,
        iva8Cents: 0,
        base0Cents: 0,
        exentoCents: 0,
        ivaRetenidoCents: 0,
        ivaAcreditableCents: 0,
        comprobantes: 0,
      }
      groups.set(key, row)
    }
    // Reparte el IVA por tasa. Si el desglose 16/8 no cubre todo el IVA, el remanente se asume 16%.
    const iva16 = e.iva16Cents > 0 ? e.iva16Cents : Math.max(0, e.ivaCents - e.iva8Cents)
    const iva8 = e.iva8Cents
    row.iva16Cents += iva16
    row.base16Cents += baseFromIva(iva16, 0.16)
    row.iva8Cents += iva8
    row.base8Cents += baseFromIva(iva8, 0.08)
    row.base0Cents += e.iva0BaseCents
    row.exentoCents += e.exentoBaseCents
    row.ivaRetenidoCents += e.ivaRetenidoCents
    row.ivaAcreditableCents += iva16 + iva8
    row.comprobantes += 1
  }

  const rows = [...groups.values()].sort((a, b) => b.ivaAcreditableCents - a.ivaAcreditableCents)
  const totals = rows.reduce(
    (t, r) => {
      t.proveedores += 1
      t.comprobantes += r.comprobantes
      t.base16Cents += r.base16Cents
      t.iva16Cents += r.iva16Cents
      t.base8Cents += r.base8Cents
      t.iva8Cents += r.iva8Cents
      t.base0Cents += r.base0Cents
      t.exentoCents += r.exentoCents
      t.ivaRetenidoCents += r.ivaRetenidoCents
      t.ivaAcreditableCents += r.ivaAcreditableCents
      return t
    },
    {
      proveedores: 0,
      comprobantes: 0,
      base16Cents: 0,
      iva16Cents: 0,
      base8Cents: 0,
      iva8Cents: 0,
      base0Cents: 0,
      exentoCents: 0,
      ivaRetenidoCents: 0,
      ivaAcreditableCents: 0,
    },
  )

  // Cross-check: la suma del IVA acreditable de la DIOT debe igualar el Σ ivaCents de la misma
  // población (lo que reporta el IVA-flujo). Pequeño desfase posible por el reparto 16/8 derivado.
  const ivaCentsTotal = expenses.reduce((s, e) => s + e.ivaCents, 0)
  const cuadraConIvaFlujo = totals.ivaAcreditableCents === ivaCentsTotal

  return { needsFiscalSetup: false, organizationId: scope.organizationId, rfc: scope.rfc, period, rows, totals, cuadraConIvaFlujo }
}
