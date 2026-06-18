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
import { createExpense, importExpenseFromXml, listExpenses } from '@/services/fiscal/expense.service'
import { generateExpensePoliciesForVenue, markExpensePaid } from '@/services/fiscal/expensePosting.service'
import { getDiot } from '@/services/fiscal/diot.service'
import { getCatalogoXml, getBalanzaXml } from '@/services/fiscal/contabilidadElectronica.service'
import { getIsrProvisional } from '@/services/fiscal/isr.service'
import { computePayrollPreview, createEmployee, listEmployees, runPayroll } from '@/services/fiscal/nomina.service'
import { stampPayrollReceipts } from '@/services/fiscal/nominaCfdi.service'
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
    'Configuración contable (Capa B fiscal, PREMIUM): el mapa "tipo de movimiento → cuenta del catálogo" que hace que el sistema postee los asientos solo (ventas, costo de venta, comisiones, propinas por pagar, IVA, gastos, retenciones, etc.). Devuelve los 24 movimientos con la cuenta que tienen asignada (o sin asignar). Responde "¿a qué cuenta cae cada cosa?". Pasa venueId.',
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
    'IVA en flujo de efectivo de un contribuyente (Capa B, PREMIUM): el IVA del mes calculado sobre flujo (LIVA art 1-B), sumando TODOS los locales del mismo RFC. Da el IVA TRASLADADO COBRADO (ventas) MENOS el IVA ACREDITABLE PAGADO (gastos del Buzón de CFDIs) = IVA a pagar (o saldo a favor). Responde "¿cuánto IVA debo este mes?". Reporta APARTE el IVA que retuviste a proveedores (obligación a enterar). ⚠️ Sigue siendo preliminar: asume tasa 16% (locales con 0%/8%/exento sobreestimados) y NO incluye retenciones de IVA que clientes te hayan hecho en ventas. Pasa venueId y opcionalmente period (YYYY-MM; default = mes actual).',
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
        ivaRetenidoAProveedores: r.ivaRetenidoTercerosCents === null ? null : pesos(r.ivaRetenidoTercerosCents),
        ivaAPagarPreliminar: pesos(r.ivaAPagarPreliminarCents),
        saldoAFavorDelPeriodo: pesos(r.saldoAFavorDelPeriodoCents),
        // Banderas de honestidad fiscal
        estimadoAl16Pct: r.computedAt16Percent,
        acreditableDisponible: r.acreditableDisponible,
        sinVentasRecuerdaDeclararEnCeros: r.zeroActivity,
        diotDisponible: r.diotDisponible,
        nota: 'Ya descuenta tu IVA acreditable de gastos pagados (Buzón de CFDIs). El IVA retenido a proveedores se entera APARTE (no resta aquí). Sigue siendo flujo de efectivo (cobrado/pagado), no facturado; asume 16% y no incluye IVA que clientes te hayan retenido en ventas. No lo uses como pago final sin tu contador.',
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
        return text({
          ok: false,
          needsMapping: true,
          faltanMapeos: r.missingMappings,
          error: 'Faltan cuentas por asignar en Configuración contable antes de postear.',
        })
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
    'register_expense',
    'Registra un GASTO / CFDI recibido de un proveedor en el Buzón (Capa B fiscal, PREMIUM, escritura). Habilita tu IVA acreditable (cuando lo pagas), la DIOT y tus costos/gastos reales. Valida que el comprobante cuadre (subtotal − descuento + IVA + IEPS − retenciones = total) y deduplica por folio fiscal (UUID). Montos en CENTAVOS enteros. Por defecto un PUE se marca pagado (IVA acreditable este periodo); pasa paid=false si aún no lo desembolsas, o metodoPago=PPD (se acredita al pagarlo). Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, proveedorRfc, proveedorNombre, fechaEmision (AAAA-MM-DD), subtotalCents, ivaCents y totalCents; opcional el resto.',
    {
      venueId: z.string().describe('Local que registra el gasto (debe estar en tu alcance)'),
      proveedorRfc: z.string().describe('RFC del proveedor (emisor del CFDI)'),
      proveedorNombre: z.string().describe('Razón social / nombre del proveedor'),
      fechaEmision: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha de emisión del CFDI AAAA-MM-DD'),
      subtotalCents: z.number().int().min(0).describe('Subtotal (base, sin IVA) en centavos enteros'),
      ivaCents: z.number().int().min(0).default(0).describe('IVA trasladado en centavos enteros'),
      totalCents: z.number().int().min(0).describe('Total del comprobante en centavos enteros'),
      descuentoCents: z.number().int().min(0).optional().describe('Descuento en centavos'),
      iepsCents: z.number().int().min(0).optional().describe('IEPS en centavos'),
      ivaRetenidoCents: z.number().int().min(0).optional().describe('IVA retenido al proveedor en centavos'),
      isrRetenidoCents: z.number().int().min(0).optional().describe('ISR retenido al proveedor en centavos'),
      metodoPago: z.enum(['PUE', 'PPD']).optional().describe('PUE (pago en una exhibición) o PPD (parcialidades/diferido)'),
      categoria: z
        .enum(['COSTO_MERCANCIA', 'GASTO_GENERAL', 'ARRENDAMIENTO', 'COMBUSTIBLE', 'HONORARIOS', 'SERVICIOS', 'OTRO'])
        .optional()
        .describe('Categoría del gasto (rutea a su cuenta contable)'),
      fechaPago: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Fecha de pago AAAA-MM-DD (opcional; default = emisión para PUE)'),
      paid: z.boolean().optional().describe('¿Ya lo pagaste? default: PUE=sí, PPD=no'),
      deducible: z.boolean().optional().describe('¿Es deducible? (default sí)'),
      ivaAcreditable: z.boolean().optional().describe('¿El IVA es acreditable? (default sí; si no, va al costo)'),
      uuid: z.string().optional().describe('Folio fiscal (UUID) del CFDI, para deduplicar'),
      folio: z.string().optional().describe('Folio interno del comprobante'),
    },
    async args => {
      const { venueId } = args
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'El registro de gastos (Buzón de CFDIs)')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const e = await createExpense(venueId, args, { staffId: scope.staffId })
      return text({
        ok: true,
        gasto: {
          id: e.id,
          proveedor: `${e.proveedorRfc} ${e.proveedorNombre}`,
          fechaEmision: e.fechaEmision,
          subtotal: pesos(e.subtotalCents),
          iva: pesos(e.ivaCents),
          total: pesos(e.totalCents),
          metodoPago: e.metodoPago,
          estatusPago: e.paymentStatus,
          periodoPago: e.paidPeriod,
          deducible: e.deducible,
          ivaAcreditable: e.ivaAcreditable,
        },
        nota: 'El IVA se vuelve acreditable cuando el gasto está PAGADO (cash-basis). Corre generate_expense_policies para postear su póliza.',
      })
    },
  )

  server.tool(
    'import_expense_xml',
    'Importa un GASTO desde el XML de un CFDI 4.0 recibido de un proveedor (Buzón, Capa B fiscal, PREMIUM, escritura). Parsea el XML timbrado, valida que el RECEPTOR seas tú, y crea el gasto con su desglose de impuestos y folio fiscal — sin captura manual. Escritura: requiere accounting:manage + feature CFDI. Pasa venueId y el contenido del XML como texto.',
    {
      venueId: z.string().describe('Local que registra el gasto (debe estar en tu alcance)'),
      xml: z.string().describe('Contenido completo del XML del CFDI recibido'),
    },
    async ({ venueId, xml }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'La importación de gastos por XML')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const e = await importExpenseFromXml(venueId, xml, { staffId: scope.staffId })
      return text({
        ok: true,
        gasto: {
          id: e.id,
          proveedor: `${e.proveedorRfc} ${e.proveedorNombre}`,
          fechaEmision: e.fechaEmision,
          subtotal: pesos(e.subtotalCents),
          iva: pesos(e.ivaCents),
          total: pesos(e.totalCents),
          metodoPago: e.metodoPago,
          estatusPago: e.paymentStatus,
          uuid: e.uuid,
        },
        nota: 'Importado del CFDI. Corre generate_expense_policies para postear su póliza.',
      })
    },
  )

  server.tool(
    'expenses',
    'Lista los GASTOS / CFDIs recibidos del contribuyente (Buzón, Capa B fiscal, PREMIUM) de TODOS los locales del mismo RFC. Devuelve cada gasto (proveedor, fechas, montos, estatus de pago) y un resumen (conteo, total, IVA, base deducible). Responde "¿qué gastos registré este mes?". Pasa venueId y opcionalmente period (YYYY-MM, por fecha de emisión), paymentStatus o proveedorRfc.',
    {
      venueId: z.string().describe('Local del contribuyente (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM por fecha de emisión (opcional)'),
      paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']).optional().describe('Filtra por estatus de pago'),
      proveedorRfc: z.string().optional().describe('Filtra por RFC de proveedor'),
    },
    async ({ venueId, period, paymentStatus, proveedorRfc }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El Buzón de gastos')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await listExpenses(venueId, { period, paymentStatus, proveedorRfc })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        resumen: {
          gastos: r.summary.count,
          total: pesos(r.summary.totalCents),
          iva: pesos(r.summary.ivaCents),
          baseDeducible: pesos(r.summary.deducibleCents),
        },
        gastos: r.expenses.map(e => ({
          id: e.id,
          proveedor: `${e.proveedorRfc} ${e.proveedorNombre}`,
          fechaEmision: e.fechaEmision,
          total: pesos(e.totalCents),
          iva: pesos(e.ivaCents),
          metodoPago: e.metodoPago,
          estatusPago: e.paymentStatus,
          posteado: e.posted,
        })),
      })
    },
  )

  server.tool(
    'generate_expense_policies',
    'Posteo AUTOMÁTICO de las pólizas de GASTOS del periodo (Capa B, PREMIUM, escritura): genera el asiento de doble partida de cada CFDI recibido sin postear (gasto/costo + IVA acreditable o pendiente + retenciones + banco/caja o Proveedores). Idempotente: re-correr no duplica. Sólo procesa comprobantes tipo INGRESO. Responde "postea mis gastos del mes". Pasa venueId y opcionalmente period (YYYY-MM; default mes actual). Requiere catálogo + configuración contable sembrados.',
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
      const gate = await planGateMessage(venueId, 'CFDI', 'El posteo de pólizas de gastos')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await generateExpensePoliciesForVenue(venueId, { period: period || currentPeriod(), actorStaffId: scope.staffId })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: r.missingMappings.length === 0,
        periodo: r.period,
        gastosCandidatos: r.candidates,
        polizasGeneradas: r.posted,
        yaEstaban: r.alreadyPosted,
        omitidos: r.skipped,
        faltanMapeos: r.missingMappings.length > 0 ? r.missingMappings : undefined,
        nota: 'Idempotente: re-correr no duplica. Sólo postea CFDIs INGRESO; notas de crédito y REP se omiten. Un gasto se omite si le falta una cuenta en Configuración contable.',
      })
    },
  )

  server.tool(
    'mark_expense_paid',
    'Marca un GASTO / CFDI recibido como PAGADO (Capa B fiscal, PREMIUM, escritura). El IVA se vuelve acreditable en el mes del pago (cash-basis) y entra a la DIOT; si el gasto ya estaba posteado en devengo (PPD), genera la póliza de pago (Proveedores→banco, IVA pendiente→acreditable). Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, expenseId y fechaPago (AAAA-MM-DD); opcional formaPago (catálogo SAT, "01"=efectivo).',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      expenseId: z.string().describe('Id del gasto a marcar pagado'),
      fechaPago: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha de pago AAAA-MM-DD'),
      formaPago: z.string().optional().describe('Forma de pago SAT (opcional; "01"=efectivo → caja, si no → banco)'),
    },
    async ({ venueId, expenseId, fechaPago, formaPago }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId) // write gate
      const gate = await planGateMessage(venueId, 'CFDI', 'El registro de pago de gastos')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await markExpensePaid(venueId, expenseId, { fechaPago, formaPago }, { staffId: scope.staffId })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.notFound) return text({ ok: false, notFound: true, error: 'No se encontró el gasto (o ya está cancelado).' })
      if (r.alreadyPaid) return text({ ok: true, alreadyPaid: true, nota: 'El gasto ya estaba marcado como pagado.' })
      return text({
        ok: true,
        marcadoPagado: r.marked,
        polizaDePagoGenerada: r.paymentPosted,
        faltanMapeos: r.missingMappings.length > 0 ? r.missingMappings : undefined,
        nota: 'El IVA de este gasto ya es acreditable en el mes del pago y entra a la DIOT.',
      })
    },
  )

  server.tool(
    'diot',
    'DIOT (Declaración Informativa de Operaciones con Terceros) de un contribuyente (Capa B, PREMIUM): lista, por proveedor, el IVA que PAGASTE en el mes (cash-basis), separado por tipo de tercero (04 nacional / 05 extranjero / 15 global) y por tasa, más las retenciones. Sale de los CFDIs recibidos pagados (Buzón). Responde "¿qué le declaro al SAT de mis proveedores este mes?". Pasa venueId y opcionalmente period (YYYY-MM; default mes actual).',
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
      const gate = await planGateMessage(venueId, 'CFDI', 'La DIOT')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getDiot(venueId, period || currentPeriod())
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        totales: {
          proveedores: r.totals.proveedores,
          comprobantes: r.totals.comprobantes,
          ivaAcreditable: pesos(r.totals.ivaAcreditableCents),
          ivaRetenido: pesos(r.totals.ivaRetenidoCents),
        },
        cuadraConIvaFlujo: r.cuadraConIvaFlujo,
        proveedores: r.rows.map(row => ({
          proveedor: `${row.proveedorRfc} ${row.proveedorNombre}`,
          tipoTercero: `${row.tipoTerceroCodigo} ${row.tipoTercero}`,
          base16: pesos(row.base16Cents),
          iva16: pesos(row.iva16Cents),
          base8: pesos(row.base8Cents),
          iva8: pesos(row.iva8Cents),
          base0: pesos(row.base0Cents),
          exento: pesos(row.exentoCents),
          ivaRetenido: pesos(row.ivaRetenidoCents),
          ivaAcreditable: pesos(row.ivaAcreditableCents),
          comprobantes: row.comprobantes,
        })),
      })
    },
  )

  server.tool(
    'isr_provisional',
    'Estimación del PAGO PROVISIONAL de ISR del periodo (persona física, Capa B, PREMIUM). regime="RESICO" (default): ingresos cobrados del mes × tasa fija por tramo (1%–2.5%), sin deducciones. regime="GENERAL": (ingresos − deducciones autorizadas) acumulado del ejercicio × tarifa art-96 acumulada − pagos provisionales previos. Responde "¿cuánto ISR debo este mes?". ⚠️ Es ESTIMACIÓN (asume 16% de IVA en el ingreso, no resta pérdidas ni retenciones de ventas; tarifa art-96 = 2024/2025 mientras el SAT no publique 2026). Lo valida el contador. Pasa venueId, opcionalmente period (YYYY-MM) y regime.',
    {
      venueId: z.string().describe('Local del contribuyente (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
      regime: z.enum(['RESICO', 'GENERAL']).optional().describe('RESICO (default) o GENERAL (actividad empresarial)'),
    },
    async ({ venueId, period, regime }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La estimación de ISR')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getIsrProvisional(venueId, period || currentPeriod(), regime === 'GENERAL' ? 'GENERAL' : 'RESICO')
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        regimen: r.regime,
        ingresosDelMes: pesos(r.ingresosMesCents),
        ingresosAcumulados: pesos(r.ingresosAcumCents),
        ...(r.regime === 'RESICO'
          ? { tasaResico: r.tasaResico, excedeTopeResico: r.excedeTopeResico }
          : {
              deduccionesAcumuladas: pesos(r.deduccionesAcumCents),
              utilidadFiscal: pesos(r.utilidadFiscalCents),
              pagosProvisionalesPrevios: pesos(r.pagosProvisionalesPreviosCents),
            }),
        isrCausado: pesos(r.isrCausadoCents),
        isrAPagarEstimado: pesos(r.isrAPagarCents),
        sinVentas: r.zeroActivity,
        nota: 'ESTIMACIÓN — no incluye retenciones de ISR en ventas, pérdidas de ejercicios anteriores ni PTU; asume 16% de IVA en el ingreso. La tarifa art-96 es la 2024/2025 (vigente en 2026 salvo publicación nueva). Confírmalo con tu contador.',
      })
    },
  )

  server.tool(
    'electronic_accounting_catalog',
    'Contabilidad electrónica del SAT (Anexo 24, Capa B, PREMIUM): genera el XML del CATÁLOGO DE CUENTAS (esquema CatalogoCuentas 1.3) de un contribuyente, listo para que su contador lo selle con la e.firma y lo suba al SAT. Devuelve el XML y el nombre de archivo oficial (RFC+Año+Mes+CT.xml). Responde "dame mi catálogo para contabilidad electrónica". Pasa venueId y opcionalmente period (YYYY-MM; default mes actual).',
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
      const gate = await planGateMessage(venueId, 'CFDI', 'La contabilidad electrónica')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getCatalogoXml(venueId, period || currentPeriod())
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.empty) return text({ ok: true, vacio: true, nota: 'El catálogo de cuentas aún no está sembrado.' })
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        archivo: r.filename,
        xml: r.xml,
        nota: 'XML sin sellar — tu contador lo sella con la e.firma y lo envía al SAT.',
      })
    },
  )

  server.tool(
    'electronic_accounting_balance',
    'Contabilidad electrónica del SAT (Anexo 24, Capa B, PREMIUM): genera el XML de la BALANZA DE COMPROBACIÓN (esquema BalanzaComprobacion 1.3) del periodo, listo para sellar y enviar al SAT. Sale de las pólizas (mismo cálculo que la balanza de pantalla). Devuelve el XML y el nombre de archivo oficial (RFC+Año+Mes+BN.xml). Responde "dame mi balanza para el SAT". Pasa venueId, opcionalmente period (YYYY-MM) y tipoEnvio (N=normal, C=complementaria).',
    {
      venueId: z.string().describe('Local del contribuyente (debe estar en tu alcance)'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
      tipoEnvio: z.enum(['N', 'C']).optional().describe('N=normal (default), C=complementaria'),
    },
    async ({ venueId, period, tipoEnvio }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La contabilidad electrónica')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })

      const r = await getBalanzaXml(venueId, period || currentPeriod(), tipoEnvio === 'C' ? 'C' : 'N')
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.empty) return text({ ok: true, vacio: true, nota: 'No hay pólizas en el periodo; genera tus pólizas primero.' })
      return text({
        ok: true,
        rfc: r.rfc,
        periodo: r.period,
        archivo: r.filename,
        xml: r.xml,
        nota: 'XML sin sellar — tu contador lo sella con la e.firma y lo envía al SAT.',
      })
    },
  )

  server.tool(
    'add_employee',
    'Da de alta un EMPLEADO para la nómina (Capa B fiscal, PREMIUM, escritura). Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, nombre, rfcEmpleado y salarioMensualBrutoCents (centavos enteros); opcional curp, nss, puesto, sbcMensualCents (salario base de cotización IMSS), periodicidadPago.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      nombre: z.string().describe('Nombre del empleado'),
      rfcEmpleado: z.string().describe('RFC del empleado'),
      salarioMensualBrutoCents: z.number().int().min(1).describe('Salario mensual bruto en centavos enteros'),
      curp: z.string().optional(),
      nss: z.string().optional().describe('Número de seguridad social'),
      puesto: z.string().optional(),
      sbcMensualCents: z.number().int().min(0).optional().describe('Salario base de cotización (IMSS) mensual en centavos'),
      periodicidadPago: z.enum(['SEMANAL', 'QUINCENAL', 'MENSUAL']).optional(),
    },
    async args => {
      const { venueId } = args
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La nómina')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })
      const e = await createEmployee(venueId, args, { staffId: scope.staffId })
      return text({
        ok: true,
        empleado: { id: e.id, nombre: e.nombre, rfc: e.rfcEmpleado, salarioMensual: pesos(e.salarioMensualBrutoCents) },
      })
    },
  )

  server.tool(
    'employees',
    'Lista los EMPLEADOS del patrón (nómina, Capa B, PREMIUM). Devuelve nombre, RFC, puesto y salario. Responde "¿quiénes están en mi nómina?". Pasa venueId.',
    { venueId: z.string().describe('Local (debe estar en tu alcance)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:read', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La nómina')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })
      const r = await listEmployees(venueId)
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      return text({
        ok: true,
        rfc: r.rfc,
        empleados: r.employees.map(e => ({
          id: e.id,
          nombre: e.nombre,
          rfc: e.rfcEmpleado,
          puesto: e.puesto,
          salarioMensual: pesos(e.salarioMensualBrutoCents),
          activo: e.activo,
        })),
      })
    },
  )

  server.tool(
    'payroll_run',
    'Corre la NÓMINA del periodo (Capa B fiscal, PREMIUM, escritura): por cada empleado activo calcula percepción → ISR a retener (tarifa art-96 − subsidio para el empleo) → cuota IMSS obrera → neto, persiste la corrida y postea su póliza (601.01 sueldos · 216.01 ISR · 216.07 IMSS · 205.06 sueldos por pagar). Idempotente por periodo+periodicidad. ⚠️ ESTIMACIÓN; el cálculo definitivo (prestaciones, IMSS exacto, timbrado del CFDI de nómina) lo hace el nominista. Escritura: requiere accounting:manage + feature CFDI. Pasa venueId, fechaPago (AAAA-MM-DD); opcional period (YYYY-MM) y periodicidad.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      fechaPago: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Fecha de pago AAAA-MM-DD'),
      period: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe('Periodo YYYY-MM (opcional; default mes actual)'),
      periodicidad: z.enum(['SEMANAL', 'QUINCENAL', 'MENSUAL']).optional().describe('Periodicidad (default MENSUAL)'),
    },
    async ({ venueId, fechaPago, period, periodicidad }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'La nómina')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })
      const r = await runPayroll(
        venueId,
        period || currentPeriod(),
        periodicidad === 'SEMANAL' || periodicidad === 'QUINCENAL' ? periodicidad : 'MENSUAL',
        fechaPago,
        { staffId: scope.staffId },
      )
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.missingMappings.length > 0)
        return text({ ok: false, faltanMapeos: r.missingMappings, error: 'Faltan cuentas de nómina en Configuración contable.' })
      return text({
        ok: true,
        yaExistia: r.alreadyExists,
        polizaPosteada: r.posted,
        empleados: r.totals.empleados,
        percepciones: pesos(r.totals.percepcionesCents),
        isrRetenido: pesos(r.totals.isrCents),
        imssObrero: pesos(r.totals.imssCents),
        neto: pesos(r.totals.netoCents),
        nota: 'ESTIMACIÓN — falta el cálculo fino de IMSS por SBC y el timbrado del CFDI de nómina. Confírmalo con tu nominista.',
      })
    },
  )

  server.tool(
    'stamp_payroll_receipts',
    'Timbra los RECIBOS DE NÓMINA (CFDI 4.0 + complemento Nómina 1.2) de una corrida de nómina ya posteada (Capa B, PREMIUM, escritura). Por cada empleado genera y timbra su recibo con el PAC del emisor; guarda el folio fiscal (UUID). Idempotente (salta los ya timbrados). Requiere el CSD del emisor ACTIVO y la clave de entidad federativa del empleado. Escritura: requiere accounting:manage + feature CFDI. Pasa venueId y payrollRunId.',
    {
      venueId: z.string().describe('Local (debe estar en tu alcance)'),
      payrollRunId: z.string().describe('Id de la corrida de nómina (PayrollRun) ya posteada'),
    },
    async ({ venueId, payrollRunId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('accounting:manage', venueId)
      const gate = await planGateMessage(venueId, 'CFDI', 'El timbrado de recibos de nómina')
      if (gate) return text({ ok: false, planRequired: true, feature: 'CFDI', error: gate })
      const r = await stampPayrollReceipts(venueId, payrollRunId, { staffId: scope.staffId })
      if (r.needsFiscalSetup) return text({ ok: true, needsFiscalSetup: true })
      if (r.needsCsd)
        return text({
          ok: false,
          needsCsd: true,
          error: 'El emisor no tiene su CSD (sello digital) activo; súbelo en Facturación para poder timbrar nómina.',
        })
      return text({
        ok: r.errors.length === 0,
        recibosTimbrados: r.stamped,
        yaTimbrados: r.alreadyStamped,
        errores: r.errors.length > 0 ? r.errors : undefined,
        nota: 'Idempotente: re-correr no re-timbra. Requiere el CSD activo y la clave de entidad federativa de cada empleado.',
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
