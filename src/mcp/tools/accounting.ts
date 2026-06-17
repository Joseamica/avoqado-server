import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { getBankAndCashSummary, getBusinessSummary, getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { createAccount, getCatalog, seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { getMappings, setMapping } from '@/services/fiscal/accountMapping.service'
import { createManualEntry, listEntries } from '@/services/fiscal/journalEntry.service'
import { currentPeriod, getTrialBalance } from '@/services/fiscal/trialBalance.service'
import { getAccountingReports } from '@/services/fiscal/accountingReports.service'
import { getIvaCashflow } from '@/services/fiscal/ivaFlujo.service'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { listStatements } from '@/services/dashboard/bankReconciliation.service'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { planGateMessage } from '../planGate'
import { text } from '../respond'

/** Centavos enteros → pesos con 2 decimales (para lectura humana/LLM). */
const pesos = (cents: number): number => Math.round(cents) / 100

export function registerAccountingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'accounting_income_statement',
    'Estado de resultados (ingresos) de un local en un periodo — Capa A, gerencial (no fiscal). Devuelve: ventas brutas, devoluciones, ingreso neto cobrado, base gravable e IVA trasladado (precios IVA-incluido), propinas (informativas, NO son ingreso) y conteo de ventas. Responde "¿cuánto gané este mes/periodo?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha inicial YYYY-MM-DD (zona del local)'),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha final YYYY-MM-DD (zona del local)'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId) // lanza ScopeError si el venue está fuera de alcance
      guard.requirePermission('accounting:read', venueId) // mismo gate que el dashboard

      const data = await getIncomeStatement(venueId, { from, to })

      return text({
        venue: data.venueName,
        venueId: data.venueId,
        currency: data.currency,
        timezone: data.timezone,
        period: data.period,
        ivaRateAssumed: data.taxRateAssumed,
        ingresos: {
          ventasBrutas: pesos(data.revenue.grossSalesCents),
          devoluciones: pesos(data.revenue.refundsCents),
          ingresoNeto: pesos(data.revenue.netRevenueCents),
          baseGravable: pesos(data.revenue.taxableBaseCents),
          ivaTrasladado: pesos(data.revenue.ivaCents),
        },
        propinas: pesos(data.tips.totalCents),
        metricas: {
          ventas: data.metrics.salesCount,
          devoluciones: data.metrics.refundCount,
          ticketPromedio: pesos(data.metrics.averageTicketCents),
        },
      })
    },
  )

  server.tool(
    'accounting_business_summary',
    'Resumen del negocio (Capa A, gerencial — portada de Contabilidad) de un local en un periodo. Reúne: ingreso neto cobrado (base + IVA), facturación del periodo (CFDIs timbrados, % del ingreso ya facturado y cuánto falta por facturar), cómo cobró (efectivo/caja vs banco/electrónico), comisiones de procesamiento, propinas y el estatus de la conciliación bancaria. Responde "¿cómo me fue este mes/periodo?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha inicial YYYY-MM-DD (zona del local)'),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha final YYYY-MM-DD (zona del local)'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)

      const d = await getBusinessSummary(venueId, { from, to })
      return text({
        venue: d.venueName,
        venueId: d.venueId,
        currency: d.currency,
        period: d.period,
        ingresos: {
          ventasBrutas: pesos(d.revenue.grossSalesCents),
          devoluciones: pesos(d.revenue.refundsCents),
          ingresoNeto: pesos(d.revenue.netRevenueCents),
          baseGravable: pesos(d.revenue.taxableBaseCents),
          ivaTrasladado: pesos(d.revenue.ivaCents),
        },
        facturacion: {
          cfdisTimbrados: d.invoicing.stampedCount,
          nominativos: d.invoicing.nominativeCount,
          globales: d.invoicing.globalCount,
          totalFacturado: pesos(d.invoicing.invoicedApproxCents),
          sinFacturar: pesos(d.invoicing.uninvoicedApproxCents),
          porcentajeFacturado: d.invoicing.invoicedPct,
        },
        cobro: {
          efectivo: pesos(d.collection.cashCents),
          electronico: pesos(d.collection.electronicCents),
          porcentajeEfectivo: d.collection.cashPct,
        },
        comisiones: pesos(d.costs.processingFeesCents),
        ingresoMenosComisiones: pesos(d.result.netAfterFeesCents),
        propinas: pesos(d.tips.totalCents),
        conciliacionBancaria: {
          estadosDeCuenta: d.reconciliation.statements,
          movimientos: d.reconciliation.lineCount,
          conciliados: d.reconciliation.matchedCount,
        },
        metricas: {
          ventas: d.metrics.salesCount,
          devoluciones: d.metrics.refundCount,
          ticketPromedio: pesos(d.metrics.averageTicketCents),
        },
      })
    },
  )

  server.tool(
    'accounting_banks_summary',
    'Bancos y cajas (Capa A) de un local en un periodo: cuánto entró por cada forma de cobro (efectivo, tarjetas, transferencias, monederos, cripto…), separando lo que se quedó en CAJA (efectivo) de lo que va al BANCO (electrónico, neto de comisiones). Responde "¿cuánto tengo en efectivo y cuánto me deposita el banco?". Pasa venueId y el rango from/to en formato YYYY-MM-DD (zona horaria del local).',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha inicial YYYY-MM-DD (zona del local)'),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha final YYYY-MM-DD (zona del local)'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)

      const d = await getBankAndCashSummary(venueId, { from, to })
      return text({
        venue: d.venueName,
        venueId: d.venueId,
        currency: d.currency,
        period: d.period,
        cuentas: d.accounts.map(a => ({
          cuenta: a.key,
          tipo: a.kind === 'cash' ? 'caja' : 'banco',
          metodos: a.methods,
          entradas: pesos(a.inflowCents),
          ventas: a.count,
        })),
        totales: {
          efectivoCaja: pesos(d.totals.cashInflowCents),
          electronicoBruto: pesos(d.totals.electronicInflowCents),
          comisiones: pesos(d.totals.feesCents),
          netoAlBanco: pesos(d.totals.netToBankCents),
        },
        conciliacionBancaria: {
          estadosDeCuenta: d.reconciliation.statements,
          movimientos: d.reconciliation.lineCount,
          conciliados: d.reconciliation.matchedCount,
        },
      })
    },
  )

  server.tool(
    'chart_of_accounts',
    'Catálogo de cuentas (contabilidad fiscal, Capa B — PREMIUM, bundle con CFDI) de un local: las cuentas contables con su código agrupador del SAT (c_CuentasSAT / Anexo 24), tipo (activo/pasivo/capital/ingreso/costo/gasto), naturaleza (deudora/acreedora) y jerarquía. Responde "¿qué cuentas tengo en mi contabilidad?". Si el local aún no tiene RFC/emisor fiscal devuelve needsFiscalSetup. Pasa venueId.',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El catálogo de cuentas (contabilidad fiscal)')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const catalog = await getCatalog(venueId)
      if (catalog.needsFiscalSetup) {
        return text({ ok: true, needsFiscalSetup: true, mensaje: 'Este local aún no tiene RFC/emisor fiscal configurado.' })
      }
      return text({
        ok: true,
        rfc: catalog.rfc,
        sembrado: catalog.seeded,
        totalCuentas: catalog.accounts.length,
        cuentas: catalog.accounts.map(a => ({
          codigo: a.code,
          nombre: a.name,
          codigoAgrupadorSat: a.satGroupingCode,
          tipo: a.type,
          naturaleza: a.nature,
          nivel: a.level,
          afectable: a.isPostable,
          activa: a.isActive,
        })),
      })
    },
  )

  server.tool(
    'seed_chart_of_accounts',
    'Genera (siembra) el catálogo de cuentas BASE de un local, ya mapeado al código agrupador del SAT y adaptado a su giro. Idempotente: solo inserta las cuentas que falten, NUNCA sobrescribe lo que el usuario editó. Úsalo cuando el local aún no tiene catálogo (chart_of_accounts → sembrado:false). Escritura: requiere permiso accounting:manage y la feature CFDI (PREMIUM). Pasa venueId.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'El catálogo de cuentas (contabilidad fiscal)')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const result = await seedBaseChart(venueId, { staffId: scope.staffId }) // el servicio se auto-audita
      return text({ ok: true, rfc: result.rfc, totalCuentas: result.accounts.length })
    },
  )

  server.tool(
    'add_ledger_account',
    'Agrega UNA cuenta nueva al catálogo de cuentas de un local. La naturaleza (deudora/acreedora) se asigna sola por el tipo; si das un código padre, la subcuenta hereda el tipo del padre. Escritura: requiere permiso accounting:manage y la feature CFDI (PREMIUM). Pasa venueId, code (NumCta SAT, p.ej. "102.01.01"), name, satGroupingCode (código agrupador) y type; opcionalmente parentCode y nature.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      code: z.string().describe('Número de cuenta SAT, p.ej. 102.01.01'),
      name: z.string().describe('Nombre de la cuenta'),
      satGroupingCode: z.string().describe('Código agrupador del SAT, p.ej. 102'),
      type: z.enum(['ACTIVO', 'PASIVO', 'CAPITAL', 'INGRESO', 'COSTO', 'GASTO', 'ORDEN']).describe('Tipo de cuenta'),
      parentCode: z.string().optional().describe('Código de la cuenta padre (opcional; omite para cuenta de mayor)'),
      nature: z.enum(['DEUDORA', 'ACREEDORA']).optional().describe('Naturaleza (opcional; default por tipo)'),
    },
    async ({ venueId, code, name, satGroupingCode, type, parentCode, nature }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'El catálogo de cuentas (contabilidad fiscal)')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const a = await createAccount(
        venueId,
        { code, name, satGroupingCode, type, parentCode: parentCode ?? null, nature },
        { staffId: scope.staffId },
      )
      return text({
        ok: true,
        cuenta: {
          codigo: a.code,
          nombre: a.name,
          codigoAgrupadorSat: a.satGroupingCode,
          tipo: a.type,
          naturaleza: a.nature,
          nivel: a.level,
          afectable: a.isPostable,
        },
      })
    },
  )

  server.tool(
    'account_mapping',
    'Configuración contable (Capa B fiscal, PREMIUM): el mapa "tipo de movimiento → cuenta del catálogo" que hace que el sistema postee los asientos solo (ventas, costo de venta, comisiones, propinas por pagar, etc.). Devuelve los 16 movimientos con la cuenta que tienen asignada (o sin asignar). Responde "¿a qué cuenta cae cada cosa?". Pasa venueId.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La configuración contable')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getMappings(venueId)
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        catalogoSembrado: r.catalogSeeded,
        mapeos: r.mappings.map(m => ({
          movimiento: m.movementType,
          concepto: m.label,
          cuenta: m.account ? `${m.account.code} ${m.account.name}` : null,
          cuentaDefault: m.defaultCode,
        })),
      })
    },
  )

  server.tool(
    'set_account_mapping',
    'Reasigna UN movimiento contable a una cuenta del catálogo (Configuración contable, PREMIUM). Solo se puede mapear a cuentas afectables (hojas). Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, movementType (p.ej. SALES_REVENUE, COST_OF_GOODS_SOLD) y ledgerAccountId (o null para limpiar).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      movementType: z.string().describe('Tipo de movimiento, p.ej. SALES_REVENUE / COST_OF_GOODS_SOLD'),
      ledgerAccountId: z.string().nullable().describe('Id de la cuenta del catálogo (o null para dejar sin asignar)'),
    },
    async ({ venueId, movementType, ledgerAccountId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'La configuración contable')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const row = await setMapping(venueId, movementType, ledgerAccountId, { staffId: scope.staffId })
      return text({
        ok: true,
        mapeo: {
          movimiento: row.movementType,
          concepto: row.label,
          cuenta: row.account ? `${row.account.code} ${row.account.name}` : null,
        },
      })
    },
  )

  server.tool(
    'journal_entries',
    'Libro diario — las pólizas (asientos de doble partida) de un local (Capa B fiscal, PREMIUM). Cada póliza está balanceada (Σcargo = Σabono). Devuelve folio, fecha, concepto, total y sus líneas (cuenta, cargo, abono). Responde "¿qué asientos tengo?". Pasa venueId y opcionalmente period (YYYY-MM).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional)'),
    },
    async ({ venueId, period }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El libro diario')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await listEntries(venueId, { period })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        polizas: r.entries.map(e => ({
          folio: e.folio,
          fecha: e.date,
          tipo: e.type,
          origen: e.source,
          concepto: e.concept,
          total: pesos(e.totalDebitCents),
          lineas: e.lines.map(l => ({
            cuenta: `${l.accountCode} ${l.accountName}`,
            cargo: pesos(l.debitCents),
            abono: pesos(l.creditCents),
          })),
        })),
      })
    },
  )

  server.tool(
    'add_journal_entry',
    'Crea una póliza MANUAL (asiento de doble partida) en el libro diario (Capa B, PREMIUM). DEBE cuadrar: Σcargo = Σabono (en centavos enteros) y cada cuenta debe ser afectable. Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, date (AAAA-MM-DD), concept y lines (≥2; cada una con ledgerAccountId y UNO de debitCents/creditCents > 0).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha del asiento AAAA-MM-DD'),
      concept: z.string().describe('Concepto / descripción de la póliza'),
      lines: z
        .array(
          z.object({
            ledgerAccountId: z.string(),
            debitCents: z.number().int().min(0).describe('Cargo en centavos enteros (0 si es abono)'),
            creditCents: z.number().int().min(0).describe('Abono en centavos enteros (0 si es cargo)'),
            description: z.string().optional(),
          }),
        )
        .min(2)
        .describe('Líneas de la póliza (mínimo 2; Σcargo = Σabono)'),
    },
    async ({ venueId, date, concept, lines }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'El libro diario')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const e = await createManualEntry(venueId, { date, concept, lines }, { staffId: scope.staffId })
      return text({
        ok: true,
        poliza: { folio: e.folio, fecha: e.date, concepto: e.concept, total: pesos(e.totalDebitCents), lineas: e.lines.length },
      })
    },
  )

  server.tool(
    'trial_balance',
    'Balanza de comprobación de un local para un periodo (Capa B fiscal, PREMIUM). Sale de las pólizas: por cuenta da saldo inicial, cargos, abonos y saldo final, y verifica el CUADRE (Σcargos=Σabonos y saldo deudor=saldo acreedor). Responde "¿cuadra mi contabilidad este mes?". Pasa venueId y opcionalmente period (YYYY-MM; default = mes actual).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
    },
    async ({ venueId, period }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La balanza de comprobación')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const b = await getTrialBalance(venueId, period || currentPeriod())
      if (b.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: b.rfc,
        periodo: b.period,
        cuadra: b.balanced.movements && b.balanced.balances,
        totales: {
          cargos: pesos(b.totals.debeCents),
          abonos: pesos(b.totals.haberCents),
          saldoFinalDeudor: pesos(b.totals.saldoFinalDeudorCents),
          saldoFinalAcreedor: pesos(b.totals.saldoFinalAcreedorCents),
        },
        cuentas: b.rows.map(r => ({
          cuenta: `${r.code} ${r.name}`,
          saldoInicial: pesos(r.saldoInicialCents),
          cargos: pesos(r.debeCents),
          abonos: pesos(r.haberCents),
          saldoFinal: pesos(r.saldoFinalCents),
        })),
      })
    },
  )

  server.tool(
    'accounting_reports',
    'Reportes contables fiscales de un local (Capa B, PREMIUM): Estado de resultados del ejercicio (ingresos − costos − gastos = utilidad/pérdida) + Balance general al cierre (activo = pasivo + capital). Salen de las pólizas. Responde "¿cuánto gané según mis libros?" y "¿cómo está mi balance?". Pasa venueId y opcionalmente period (YYYY-MM; default = mes actual).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
    },
    async ({ venueId, period }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'Los reportes contables')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getAccountingReports(venueId, period || currentPeriod())
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      const is = r.incomeStatement
      const bs = r.balanceSheet
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        estadoDeResultados: {
          ingresos: pesos(is.ingresos.totalCents),
          costos: pesos(is.costos.totalCents),
          utilidadBruta: pesos(is.utilidadBrutaCents),
          gastos: pesos(is.gastos.totalCents),
          resultado: pesos(is.resultadoCents),
        },
        balanceGeneral: {
          activo: pesos(bs.activo.totalCents),
          pasivo: pesos(bs.pasivo.totalCents),
          capital: pesos(bs.capital.totalCents),
          resultadoDelEjercicio: pesos(bs.resultadoEjercicioCents),
          cuadra: bs.balanced,
        },
      })
    },
  )

  server.tool(
    'accounting_iva_cashflow',
    'IVA en flujo de efectivo de un contribuyente (Capa B, PREMIUM): el IVA TRASLADADO COBRADO del mes (lado ventas), calculado sobre lo efectivamente cobrado (LIVA art 1-B), sumando TODOS los locales del mismo RFC. Responde "¿cuánto IVA causé este mes por lo que cobré?". ⚠️ Es PRELIMINAR y solo lado ventas: NO incluye tu IVA acreditable de gastos (Fase 2), así que el "a pagar" mostrado es un TECHO; el real será MENOR. Asume tasa 16% (locales con 0%/8%/exento quedan sobreestimados). La DIOT no se genera (lado proveedores, Fase 2). Pasa venueId y opcionalmente period (YYYY-MM; default = mes actual).',
    {
      venueId: z.string().describe('Local del contribuyente (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
    },
    async ({ venueId, period }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El resumen de IVA en flujo de efectivo')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getIvaCashflow(venueId, period || currentPeriod())
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        localesIncluidos: r.venueIds.length,
        ivaTrasladadoCobrado: pesos(r.ivaTrasladadoCobradoCents),
        baseGravable: pesos(r.baseGravableCents),
        ivaAmparadoPorCfdiContraste: pesos(r.ivaAmparadoPorCfdiCents),
        ivaAcreditablePagado: r.acreditablePagadoCents === null ? null : pesos(r.acreditablePagadoCents),
        ivaAPagarPreliminarTecho: pesos(r.ivaAPagarPreliminarCents),
        saldoAFavorDelPeriodo: pesos(r.saldoAFavorDelPeriodoCents),
        // Banderas de honestidad fiscal
        estimadoAl16Pct: r.computedAt16Percent,
        incompletoPorFaltaDeGastos: r.incompletoPorFaltaDeGastos,
        sinVentasRecuerdaDeclararEnCeros: r.zeroActivity,
        diotDisponible: r.diotDisponible,
        nota: 'PRELIMINAR — solo lado ventas (IVA cobrado). Falta tu IVA de gastos (acreditable, Fase 2); el real a enterar será MENOR. Es flujo de efectivo (cobrado), no facturado; no cuadra 1:1 con tus CFDIs. No lo uses como pago final sin tu contador.',
      })
    },
  )

  server.tool(
    'generate_journal_entries',
    'Posteo AUTOMÁTICO de pólizas (Capa B, PREMIUM, escritura): genera los asientos de doble partida del periodo desde los pagos COMPLETED del local (venta → banco/caja + ventas + IVA + propinas; devolución → contracuenta). Hace que el libro diario / balanza / reportes se llenen solos, sin captura manual. Es idempotente: re-correr no duplica. Responde "generá mis pólizas del mes". Pasa venueId y opcionalmente period (YYYY-MM; default mes actual). Requiere el catálogo + la configuración contable sembrados.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
    },
    async ({ venueId, period }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El posteo automático de pólizas')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await generatePoliciesForVenue(venueId, { period: period || currentPeriod(), actorStaffId: scope.staffId })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.missingMappings.length > 0)
        return text({ ok: false, needsMapping: true, faltanMapeos: r.missingMappings, error: 'Faltan cuentas por asignar en Configuración contable antes de postear.' })
      return text({
        ok: true,
        periodo: r.period,
        pagosElegibles: r.candidates,
        polizasGeneradas: r.posted,
        yaEstaban: r.alreadyPosted,
        omitidos: r.skipped,
        nota: 'Idempotente: re-correr no duplica. Devoluciones y voids se postean como contracuenta (402.01).',
      })
    },
  )

  server.tool(
    'bank_reconciliation_summary',
    'Conciliación bancaria (PRO): lista los estados de cuenta subidos de un local y cuántos depósitos del banco ya cuadraron contra lo que Avoqado depositó (conciliados/movimientos). Responde "¿ya cuadró mi banco?". Pasa venueId.',
    {
      venueId: z.string().describe('Local a reportar (debe estar en tu alcance)'),
    },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'BANK_RECONCILIATION', 'La conciliación bancaria')
      if (gate) return text({ ok: false, planRequired: true, error: gate })

      const statements = await listStatements(venueId)
      return text({
        ok: true,
        estadosDeCuenta: statements.map(s => ({
          id: s.id,
          archivo: s.fileName,
          periodo: { desde: s.periodStart, hasta: s.periodEnd },
          movimientos: s.lineCount,
          conciliados: s.matchedCount,
          estatus: s.status,
          subido: s.createdAt,
        })),
      })
    },
  )
}
