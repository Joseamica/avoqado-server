# Paridad contable Avoqado ↔ Alegra — gap analysis verificado

**Fecha:** 2026-06-18 · **Método:** auditoría multi-agente contra el código (`src/services/fiscal/`,
`src/services/dashboard/accounting.dashboard.service.ts`, rutas, MCP, `prisma/schema.prisma`) + greps de confirmación. **Caveat:** el
barrido de 12 áreas se topó con rate-limit; 2 áreas se auditaron a fondo (IVA, ISR), el resto se verificó vía el agente crítico (que leyó el
código de las demás) + greps dirigidos + conocimiento de implementación de la sesión. Confiable como backlog, no es "12/12 con cita por
área".

## Veredicto

- **~75%** de lo que necesita el **cliente objetivo** (PF, local pequeño, RESICO, mensual).
- **~55%** del **"Alegra completo"** (incluye Persona Moral, declaración anual, nómina completa, CxC/CxP, activos fijos).
- **El gate no es el código, es la demanda.** No construir los 16 ítems en especulativo. Un contador real elige cuáles 2-3 P0/P1 le bloquean
  antes de migrar. El orden que el contador ya dio (Nómina → ISR → Conciliación → NIF al final) es la guía de priorización.

## Lo que YA está (núcleo)

Facturación CFDI (ingreso, global, cancelación — `cfdi.service.ts`, `cfdiGlobal.service.ts`) · Buzón de gastos + import XML + DIOT + IVA
acreditable cash-basis (`expense.service.ts`, `diot.service.ts`) · doble partida completa (catálogo SAT, mapeo 28 mov, pólizas auto+manual,
balanza, estados financieros — `chartOfAccounts`, `accountMapping`, `autoPosting`, `trialBalance`, `accountingReports`) · contabilidad
electrónica catálogo+balanza XML Anexo 24 (`contabilidadElectronica.service.ts`) · IVA en flujo (`ivaFlujo.service.ts`) · ISR provisional PF
RESICO+GENERAL (`isr.service.ts`) · nómina cálculo + CFDI 1.2 timbrado (`nomina.service.ts`, `nominaCfdi.service.ts`) · conciliación
bancaria con matcher determinista (`bankReconciliation.service.ts` — `matchLines`, score 1/0.9) · preparación fiscal
(`fiscalReadiness.service.ts`).

---

## Backlog priorizado

### 🔴 P0 — un contador no migra de Alegra sin esto

| #   | Gap                                                                                                                                                                                                           | Evidencia                                                                                             | Esfuerzo | Riesgo                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Declaración ANUAL de ISR + ajuste anual** (cierre de abril). Hoy solo pago provisional mensual.                                                                                                             | `isr.service.ts:6-7` (fuera de alcance declarado); sin endpoint/tool anual                            | Alto     | Bajo (módulo nuevo, aislado)                                                                                                                                        |
| 2   | **Tasa de impuesto POR PRODUCTO en el read-model fiscal.** IVA/ISR asumen 16% sobre `Payment.amount`, no unen `Product.taxRate` (que el timbrado SÍ usa). Sin esto el "a pagar" es estimación, no declarable. | `accounting.dashboard.service.ts:27,119` (`DEFAULT_IVA_RATE=0.16`); `ivaFlujo`/`isr` heredan el sesgo | Medio    | **ALTO** — toca `getIncomeStatement`, núcleo del que cuelgan estado de resultados + resumen + IVA + ISR. Validar contra venue real con ventas mixtas antes de tocar |
| 3   | **Persona Moral** (ISR 30% sobre resultado fiscal + coeficiente de utilidad). Solo PF soportado.                                                                                                              | `isr.service.ts:22` (`IsrRegime='RESICO'\|'GENERAL'`); `accounting.routes.ts:492`                     | Alto     | Bajo (régimen nuevo paralelo)                                                                                                                                       |

### 🟡 P1 — paridad que el contador pide para confiar

| Gap                                                                                                                                                                                                                                       | Evidencia                                                                         | Nota                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Retención de IVA/ISR que el CLIENTE te hace en ventas** (hoy `null` → sobreestima lo a pagar)                                                                                                                                           | `ivaFlujo.service.ts:168` (`retencionesCents=null`); `isr.service.ts:198`         | El patrón ya existe del lado gastos (`Expense.ivaRetenidoCents`/`isrRetenidoCents`); falta la dimensión ventas |
| **Saldo a favor de IVA arrastrado entre periodos**                                                                                                                                                                                        | `ivaFlujo.service.ts:169` (`saldoAFavorAplicadoCents=null`, nunca persiste)       | Necesita modelo de persistencia (no existe `IvaPeriod`/`IvaPayment`)                                           |
| **Reporte/papel de trabajo de IVA e ISR** listo para declarar (prellenado SAT)                                                                                                                                                            | solo read-model + DIOT                                                            | Alegra entrega el reporte; aquí el contador arma el papel a mano                                               |
| **Pérdidas fiscales de ejercicios anteriores** (ISR)                                                                                                                                                                                      | cuentas placeholder `chartOfAccounts.catalog.ts:341,368`; no alimentan el cálculo | GENERAL con pérdida acumulada paga ISR de más                                                                  |
| **Nómina completa**: prestaciones (aguinaldo, prima vacacional, horas extra, finiquito/liquidación), percepción exenta, IMSS fino por SBC/SUA, incidencias (faltas/incapacidades/vacaciones), ISR anual de salarios                       | `nomina.service.ts:106` (`percepcionExentaCents:0` hardcoded)                     | Infra de nómina ya existe; falta el detalle de conceptos                                                       |
| ~~**Pólizas XML (PLZ)** de contabilidad electrónica~~ ✅ HECHO 2026-06-18 (`getPolizasXml` + ruta `/electronic/polizas` + MCP `electronic_accounting_polizas`). Falta solo `CompNal` (UUID por transacción) + auxiliares de cuenta/folio. | `contabilidadElectronica.service.ts` (CT + balanza BN + **PLZ**)                  | Trío Anexo 24 completo (CT/BN/PLZ)                                                                             |
| **Persistencia/historial de pagos provisionales** (modelo `IsrPayment`)                                                                                                                                                                   | `isr.service.ts:204-206` (se recalcula por recursión)                             | El acumulado se desvía si lo declarado ≠ lo estimado                                                           |

### ⚪ P2 — cola larga / nice-to-have

- **Descarga masiva automática de CFDIs del SAT** (Buzón se llena solo; hoy manual + XML).
- **CxC/CxP con antigüedad de saldos** — ✅ CxP (proveedores) HECHO 2026-06-18 (ver abajo); falta el lado **CxC (clientes/cobrar)** —
  no hay modelo de cuentas por cobrar (ventas se cobran en POS).
- **Depreciación de activos fijos** (LISR 34-35) — solo cuentas placeholder, sin servicio.
- **Conciliación bancaria "con IA" real** (parseo de PDF + fuzzy match) — hoy matcher exacto/casi (`bankReconciliation.service.ts:209`
  `matchLines`, "slice 2" pendiente por diseño).
- **Estados financieros NIF completos** (flujo de efectivo, cambios en capital, B-10 inflación) — el contador los puso "al final".
- **PTU** (cálculo + resta de base), **IEPS en ventas** (solo en gastos hoy), **complementarias** (IVA/ISR), **CFDI de retenciones
  emitidas**, **export CONTPAQi/COI**, **portal del contador**.

---

## Construido después del análisis (2026-06-18, sin commitear)

- ✅ **Pólizas XML (PLZ)** del Anexo 24 — `getPolizasXml` + ruta `/electronic/polizas` + MCP `electronic_accounting_polizas`. Trío CT/BN/PLZ
  completo. Falta `CompNal` (UUID por transacción).
- ✅ **Auxiliar de cuenta** (libro mayor por cuenta) — drill-down de la balanza: saldo inicial + movimientos con saldo corrido + saldo
  final. `accountLedger.service.ts` (`getAccountLedger`) + ruta `/account-ledger` + MCP `account_ledger`. Read-only, mismo universo que la
  balanza. Pendiente: **auxiliar de FOLIOS** (XML AuxiliarFolios del SAT) — distinto del auxiliar de cuenta.
- ✅ **Cuentas por pagar (CxP) — antigüedad de saldos a proveedores** — agrupa los gastos del Buzón con saldo pendiente (total − pagado) en
  cubetas 0-30 / 31-60 / 61-90 / 90+ por días desde la emisión. `accountsPayable.service.ts` (`getAccountsPayableAging`) + ruta
  `/accounts-payable` + MCP `accounts_payable`. Read-only. Pendiente: el lado **CxC (clientes)** — no hay modelo de receivables.

---

## Hallazgos del crítico (correcciones a la síntesis cruda)

- **Nómina NO es un hueco**: el servicio completo existe (cálculo + póliza + CFDI 1.2). El gap es el detalle de conceptos
  (prestaciones/exento), no el módulo.
- **Retenciones lado GASTOS sí funcionan** (`Expense.ivaRetenidoCents`/`isrRetenidoCents` se capturan, alimentan acreditable + DIOT). El
  hueco es solo lado VENTAS.
- **`Expense.taxBreakdown` SÍ se escribe** (`expense.service.ts:336`, la DIOT-por-tasa depende). Solo `Cfdi.taxBreakdown` (ventas) queda sin
  escribir — y aun así el read-model de ventas no parte del CFDI sino de `Payment.amount` por diseño.
- **Gap omitido**: `getIncomeStatement` cuenta `PaymentType.ADJUSTMENT`/legacy null como venta gravada al 16% sin flag
  (`accounting.dashboard.service.ts:115`) — contamina la base silenciosamente.

## Recomendación de secuencia (si/cuando un contador real lo pida)

1. **P1-nómina** (prestaciones/exento) — el contador lo puso #1 y la infra ya está.
2. **P0 #1 ISR anual** — módulo aislado, bajo riesgo, alto valor (el momento de abril).
3. **P0 #2 tasa-por-producto** — alto valor pero ALTO riesgo: refactor del read-model núcleo; hacerlo SOLO con un venue real de ventas
   mixtas para validar (clase del bug de dinero de prod).
4. Resto, por demanda real.
