---
title: Entender por qué Inicio y el Resumen de Ventas no dan lo mismo en el panel
description: Inicio suma lo cobrado el día del cobro; Resumen de Ventas, las cuentas ya cobradas el día en que se abrieron. Qué cuenta cada número.
product: dashboard
category: reportes
task: comparar-inicio-y-resumen-de-ventas
requiredPermissions: []
sourceRepo: avoqado-web-dashboard
sourceRef: aa8a35a4edcec79df6fb8746d4b1e11d0be803e0
keywords:
  - no me cuadra
  - el panel y la app no cuadran
  - las ventas no coinciden
  - ventas netas
  - sin cobrar
  - ventas diferidas
  - cuenta abierta
  - cargos por servicio
  - comisión de uber
  - comisiones de terceros
---

## Antes de empezar

Para *Inicio* necesitas permiso para ver el inicio y las analíticas; para *Reportes* › *Resumen de Ventas*, permiso para ver reportes. Con el plan Gratis, el *Resumen de Ventas* sólo muestra el día de hoy y no trae *Métricas*. Los pasos 2 a 4 son sin filtros: con un *Comercio* elegido o un método en *Filtrar por*, sólo cuentan los pagos de ese comercio o método, *Ventas brutas*, *Ventas netas* y *Sin cobrar* no salen y *Neto cobrado* sale de esos pagos.

## Pasos

1. En *Inicio*, *Ventas netas* suma lo que se cobró en el periodo, sin propinas, en el día del cobro. Los reembolsos no se restan ahí.
2. En *Reportes* › *Resumen de Ventas*, *Ventas brutas* suma las cuentas ya cobradas (artículos y *Cargos por servicio*) el día en que se abrieron. *Ventas netas* les resta *Descuentos* y *Devoluciones*.
3. Las cuentas abiertas o pagadas a medias no son venta: salen en *Sin cobrar* (en *Resumen*, abajo, en *Aparte*), con cuántas son y lo que deben sin propina. Si no sale, toca *Métricas*, marca *Sin cobrar* y *Aplicar*.
4. El número grande, *Neto cobrado*, es *Ventas netas* más propinas, menos *Comisiones de plataforma* y *Comisiones de terceros* (Rappi, Uber Eats, DiDi o un tipo de pago con comisión).

## Problemas frecuentes

- Sin filtros, una cuenta abierta ayer y cobrada hoy sale ayer en *Resumen de Ventas* y hoy en *Inicio*.
- Una cuenta pagada a medias no cuenta como venta, ni en *Neto cobrado*, hasta que se termina de pagar; su abono tampoco entra en *Propinas* ni en los cobros que cuenta el reporte hasta entonces.
- *Inicio* no resta las devoluciones y el *Resumen de Ventas* sí. El número de *cobros* del *Resumen de Ventas* no cuenta las devoluciones: van en su renglón, con su número. Una cuenta pagada en tres pagos cuenta tres cobros.
- *Liquidación de hoy*, en *Inicio*, no es lo que vendiste hoy: es lo que se estima que cae hoy en tu banco por cobros con tarjeta, sin el efectivo.
