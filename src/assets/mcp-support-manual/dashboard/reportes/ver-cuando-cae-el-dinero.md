---
title: Ver cuándo se estima que te depositan los cobros con tarjeta en el panel
description: En Reportes › Saldo Disponible ves una estimación, no un depósito confirmado, de cuánto y qué día te caen tus cobros con tarjeta.
product: dashboard
category: reportes
task: ver-cuando-cae-el-dinero
requiredPermissions:
  - settlements:read
featureCode: ADVANCED_REPORTS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - cuándo me cae el dinero
  - cuándo me depositan
  - en cuántos días me pagan
  - depósito
  - liquidación
  - saldo disponible
---

## Antes de empezar

*Saldo Disponible* sale en *Reportes* si tienes permiso para ver liquidaciones, y se abre cuando tu negocio ya tiene aprobada su verificación. Si tu plan no lo incluye, la pantalla sale borrosa con «Esta función es parte del plan …». Todo lo que muestra es estimado: ninguna fecha es un depósito confirmado por el banco.

## Pasos

1. En *Reportes* › *Saldo Disponible*, mira *Tu próximo depósito*: cuánto se estima que te cae y qué día. Si sale *En camino*, es lo que todavía falta por depositarte.
2. En *Cuándo cae (semana)* cada día dice cuánto cae en tu banco. Cambia de semana con las flechas y toca un día para ver la comisión y lo que recibes.
3. En *Desglose por Tipo de Tarjeta*, la columna *Liquidación* dice cuántos días tarda cada tipo de tarjeta; el efectivo dice *Inmediato*.
4. Para un cobro en particular, toca *Simular Transacción*, llena *Monto de Transacción*, *Tipo de Tarjeta* y *Fecha de Transacción*, y toca *Calcular Liquidación*.
5. Para bajar el detalle, toca *Descargar reporte*, elige *Transacciones* o *Dispersiones* (un renglón por día de depósito), las fechas y el formato, y toca *Descargar*.

## Problemas frecuentes

- El efectivo no sale en *Cuándo cae (semana)*: ya está en tu mano. Lo ves en la pestaña *Efectivo*.
- *Tu próximo depósito* sólo cuenta cobros con tarjeta que procesó Avoqado: una venta con la terminal de otro banco o por transferencia no sale ahí.
- Las *Comisiones Estimadas* del simulador son un porcentaje aproximado, no tu tarifa; la comisión de tus cobros sale en la columna *Comisiones* de *Desglose por Tipo de Tarjeta*, en pantalla ancha.
- Si el simulador dice «No se encontró configuración de liquidación para este tipo de tarjeta…», no hay reglas de depósito cargadas para ese tipo de tarjeta o para el negocio.
