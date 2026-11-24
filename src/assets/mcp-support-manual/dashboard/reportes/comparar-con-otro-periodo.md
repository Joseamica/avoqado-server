---
title: Comparar tus ventas con otro periodo en el panel
description: En el Resumen de Ventas, cuánto vendiste contra el periodo anterior o el mismo periodo del año pasado, con la diferencia en pesos y en %.
product: dashboard
category: reportes
task: comparar-con-otro-periodo
requiredPermissions:
  - reports:read
sourceRepo: avoqado-web-dashboard
sourceRef: 6481f012bc27ce3eb062de86ec51d26742ec591f
keywords:
  - vendí más que la semana pasada
  - comparar con la semana pasada
  - comparar con el año pasado
  - comparar periodos
  - contra el mes pasado
  - por qué sale en rojo
  - qué significa nuevo
  - no me deja comparar
---

## Antes de empezar

Necesitas permiso para ver reportes. Comparar es del plan Pro: con el plan Gratis el botón *Comparar con* sale con candado. Se compara un periodo de un año o menos que ya empezó.

## Pasos

1. En *Reportes* › *Resumen de Ventas*, elige las fechas y toca *Comparar con*.
2. Elige *Periodo anterior* (los mismos días justo antes; un mes completo contra el mes anterior) o *Mismo periodo del año pasado*.
3. Junto al número grande salen las fechas exactas de cada lado. Si el periodo todavía no termina (hoy, esta semana), los dos se cuentan hasta la misma hora.
4. Debajo de cada cifra sale *antes* con lo del otro periodo y cuánto cambió en pesos y en %. Verde es mejor (más ventas); rojo, peor (más devoluciones o comisiones).
5. *nuevo* quiere decir que antes era $0. Junto al número grande, *Antes* dice cuánto fue el otro periodo y cuánto cambió.
6. En *Por días* o *Por horas*, la columna *Total* trae el total del otro periodo y su cambio.

## Problemas frecuentes

- *Mismo periodo del año pasado* de un día o de semanas completas usa el mismo día de la semana de hace 52 semanas; un mes o un rango suelto, las mismas fechas.
- Un mes más corto se queda en su último día: *Este mes* el 31 de marzo se compara con febrero hasta el 28.
- Una cuenta abierta antes de la hora y cobrada después cuenta como venta del periodo comparado; la de hoy sale en *Sin cobrar* hasta que se cobre.
- Sin % es porque antes era $0 (*nuevo*) o negativo. Gris es informativo (impuestos, *Sin cobrar*).
- *Todo el tiempo* no se compara: elige un periodo de un año o menos.
- Si tu negocio tiene cobros del QR anterior, el otro periodo no los trae: se ven las dos cifras sin cambio (con un comercio elegido sí se calcula).
- Un cobro que entra mientras se carga el reporte puede faltar hasta que recargues.
