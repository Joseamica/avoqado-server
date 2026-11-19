---
title: Ver saldo disponible
description: Consulta liquidaciones, depósitos y calendario de saldo.
product: dashboard
category: reportes
featureCode: AVOQADO_BALANCE
dashboardRoutes:
  - available-balance
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-05-20
sourceRepo: avoqado-web-dashboard
popular: true
keywords:
  - saldo disponible
  - depósitos
  - liquidaciones
  - calendario de depósitos
  - falta un depósito
  - el saldo no coincide con las ventas
---

## Antes de empezar

Saldo disponible ayuda a entender cuánto dinero está listo para depositarse o ya fue liquidado. No debe compararse directamente contra ventas brutas sin revisar comisiones, tiempos de liquidación, método de pago, devoluciones o ajustes.

Antes de revisar una diferencia, ten claro el periodo, la sucursal y el tipo de movimiento que buscas: venta, depósito, liquidación pendiente o ajuste.

## Pasos

1. Abre **Reportes > Saldo Disponible**.
2. Confirma la sucursal activa.
3. Revisa saldo disponible, saldo pendiente y calendario de depósitos.
4. Ajusta el periodo si estás investigando un día específico.
5. Compara contra **Ventas > Transacciones** para validar pagos cobrados.
6. Si necesitas explicar diferencias, revisa método de pago, fecha de cobro y fecha estimada de depósito.

## Problemas frecuentes

Si el saldo no coincide con ventas del día, revisa liquidaciones pendientes. Si falta un depósito, confirma el calendario y el periodo. Si aparece un ajuste, revisa si hubo devolución, contracargo o corrección. Si no puedes ver la sección, tu rol puede no tener permiso de liquidaciones.

Para seguimiento financiero, conserva captura o exportación del periodo revisado junto con el día de depósito esperado.

## Diferencia entre venta y depósito

Una venta puede estar aprobada aunque todavía no esté disponible para depósito. El saldo disponible depende de tiempos de liquidación, método de pago, comisiones, devoluciones, contracargos y ajustes. Por eso una diferencia entre ventas del día y saldo no necesariamente indica error.

Para explicar un depósito, revisa primero el calendario. Después compara transacciones del periodo contra movimientos de liquidación. Si el negocio maneja cierres contables, guarda el reporte usado y la fecha exacta de consulta.

## Cuándo pedir ayuda

Escala el caso si un depósito vencido no aparece, si hay un ajuste sin contexto claro o si una transacción aprobada no entra al calendario después del tiempo esperado. Incluye monto, fecha de venta, fecha esperada de depósito, sucursal y referencia disponible.
