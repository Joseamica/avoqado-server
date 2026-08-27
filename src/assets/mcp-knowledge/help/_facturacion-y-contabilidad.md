---
title: Cómo funciona la facturación CFDI y la contabilidad
description:
  Qué hace el módulo de facturación (CFDI 4.0, factura global, nómina) y el de contabilidad (pólizas, conciliación bancaria con IA, IVA,
  DIOT, ISR), y cómo empezar a usarlos.
category: general
featureCode: CFDI
keywords:
  - factura
  - facturar
  - facturacion
  - cfdi
  - sat
  - timbrar
  - timbrado
  - csd
  - rfc
  - global
  - nomina
  - contabilidad
  - contador
  - poliza
  - polizas
  - balanza
  - conciliacion
  - bancaria
  - banco
  - iva
  - diot
  - isr
  - deducir
  - gastos
  - fiscal
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-08-25
---

## Facturación CFDI 4.0 (plan Premium)

**Tu cliente se factura solo.** La liga del ticket que recibe al pagar lo lleva directo a facturarse: captura su RFC y uso de CFDI, y recibe
PDF + XML por email, WhatsApp o descarga. Solo puede facturar su propia venta y dentro del mismo mes fiscal. Sus datos fiscales quedan
guardados para la próxima vez.

**También desde el Dashboard.** Si el cliente prefiere que lo hagas tú, timbras su cuenta cerrada al momento con sus datos capturados.

**Factura global automática.** Las ventas que nadie facturó individualmente se agrupan en una factura global a "Público en general" que se
emite sola (periodicidad diaria, semanal, quincenal, mensual o bimestral). No duplica ingresos: solo entra lo que no se facturó aparte. Tú
decides si incluye ventas en efectivo, y puedes dispararla manualmente cuando quieras.

**Cancelaciones y reembolsos.** Cancelas con el motivo SAT correcto (01–04) y factura de sustitución cuando aplica; el estado queda
rastreado hasta que el SAT acepta. Un reembolso se ampara con una **nota de crédito** (CFDI de egreso) relacionada a la factura original,
sin cancelarla.

**Nómina.** Los recibos de tu equipo se timbran como CFDI de nómina con complemento 1.2, directo desde el módulo de personal, a partir de
una corrida de nómina ya posteada.

### Para empezar a facturar necesitas

1. RFC y régimen fiscal del emisor, y código postal del lugar de expedición.
2. Tu **CSD** (certificado de sello digital) vigente, cargado en Configuración.
3. Plan Premium activo en el local.

Puedes pedirle a tu asistente un **diagnóstico de preparación fiscal** ("¿qué me falta para facturar?") y te dice exactamente qué falta.

## Contabilidad

Hay dos capas:

- **Capa gerencial (todos los planes):** ingresos, resumen del negocio y estado de resultados gerencial — ventas brutas, devoluciones,
  ingreso neto, IVA trasladado, propinas (informativas, no son ingreso).
- **Capa fiscal (Premium):** contabilidad de doble partida lista para tu contador.

### Qué hace la capa fiscal

- **Pólizas automáticas.** Cada venta, cobro, comisión y gasto genera su asiento; cada póliza cuadra debe = haber.
- **Catálogo de cuentas.** Se siembra según tu tipo de negocio con el código agrupador del SAT, y decides a qué cuenta va cada tipo de
  movimiento (se configura una vez).
- **Reportes.** Balanza de comprobación, estado de resultados y balance general por periodo, siempre cuadrados.
- **Gastos y buzón de CFDIs.** Registras gastos o importas el XML del CFDI que te mandó el proveedor — sin captura manual — y quedan listos
  para deducir. Cuentas por pagar y activos fijos con depreciación.
- **Conciliación bancaria con IA.** Subes tu estado de cuenta y la IA empata los depósitos del banco contra lo que Avoqado te depositó.
  Responde "¿ya cuadró mi banco?".
- **Impuestos.** IVA en flujo de efectivo del mes (trasladado cobrado menos acreditable pagado), DIOT por proveedor, estimación del pago
  provisional de ISR (RESICO o régimen general) y contabilidad electrónica del SAT (Anexo 24: catálogo, balanza y pólizas en XML).
- **Cierre de periodos.** Bloqueas un mes para que nada se mueva después de entregarlo al contador.

### Qué NO ve Avoqado

Avoqado solo registra el dinero que pasa **por Avoqado** (terminal, efectivo capturado en el POS, ligas de pago, cobros y CFDI procesados
por Avoqado). No ve otros sistemas del negocio (tu propia página con Stripe, otras apps de cobro), así que un reporte combinado externo
normalmente será mayor que el de Avoqado — eso es esperado, no un error.

## Dónde está en el Dashboard

- Facturación: **Facturación** en el menú lateral (facturas emitidas, factura global, configuración fiscal y CSD).
- Contabilidad: **Contabilidad** → reportes, libro diario, catálogo, conciliación, gastos y buzón.
