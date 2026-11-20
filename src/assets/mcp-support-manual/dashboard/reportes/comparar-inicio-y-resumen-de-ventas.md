---
title: Entender por qué Inicio y el Resumen de Ventas no dan lo mismo en el panel
description: Sin filtros, Inicio suma lo cobrado y Reportes › Resumen de Ventas las cuentas del periodo: qué cuenta cada número para hallar la diferencia.
product: dashboard
category: reportes
task: comparar-inicio-y-resumen-de-ventas
requiredPermissions: []
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - no me cuadra
  - el panel y la app no cuadran
  - las ventas no coinciden
  - ventas netas
  - ventas diferidas
  - cuenta abierta
---

## Antes de empezar

Para *Inicio* necesitas permiso para ver el inicio y las analíticas; para *Reportes* › *Resumen de Ventas*, permiso para ver reportes. Con el plan Gratis, el *Resumen de Ventas* sólo muestra el día de hoy y no trae *Métricas*. Los pasos 2 a 4 son sin filtros: con un *Comercio* elegido sólo cuentan las cuentas con un pago de ese comercio, y con un método de pago elegido en *Filtrar por*, *Ventas brutas*, *Ventas netas* y *Ventas diferidas* no salen y *Neto cobrado* sale de los pagos de ese método.

## Pasos

1. En *Inicio*, *Ventas netas* suma lo que se cobró en el periodo, sin propinas, en el día del cobro. Los reembolsos no se restan ahí.
2. En *Reportes* › *Resumen de Ventas*, *Ventas brutas* suma las cuentas abiertas en el periodo, el día en que se abrieron, y puede contar cuentas sin cobrar. *Ventas netas* les resta *Descuentos* y *Devoluciones*.
3. Para ver lo que todavía falta por cobrar de esas cuentas, toca *Métricas*, marca *Ventas diferidas* y toca *Aplicar*.
4. El número grande de arriba, *Neto cobrado*, es otra cuenta: *Ventas netas* más propinas, menos las comisiones de plataforma.

## Problemas frecuentes

- Sin filtros, una cuenta abierta ayer y cobrada hoy sale ayer en *Resumen de Ventas* y hoy en *Inicio*.
- En *Métricas*, la descripción de *Ventas diferidas* dice «Suma total cobrada…», pero el número es lo que esas cuentas todavía deben.
- *Liquidación de hoy*, en *Inicio*, no es lo que vendiste hoy: es lo que se estima que cae hoy en tu banco por cobros con tarjeta, sin el efectivo.
