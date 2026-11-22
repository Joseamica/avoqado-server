---
title: Ver cuánto vendiste por canal y por tipo de pedido en el panel
description: En el Resumen de Ventas, cuánto entró por mostrador, mesas, tienda en línea, ligas, Rappi o Uber, y lo cobrado por adelantado que no es venta.
product: dashboard
category: reportes
task: ver-ventas-por-canal
requiredPermissions:
  - reports:read
featureCode: ADVANCED_REPORTS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 621e5b1e66204e026df61416f7d93df2e7415540
keywords:
  - cuánto vendí por rappi
  - cuánto vendí en línea
  - ventas por canal
  - ventas de la tienda en línea
  - ventas de uber eats
  - para llevar
  - a domicilio
  - paquetes vendidos en línea
  - depósitos de reservas
  - no aparecen los paquetes
---

## Antes de empezar

Necesitas permiso para ver reportes. *Ventas por canal* es del plan Pro: con el plan Gratis ves la sección con candado. Sólo sale sin filtros: con un *Comercio* elegido o un método en *Filtrar por*, el reporte cuenta cobros y no cuentas.

## Pasos

1. En *Reportes* › *Resumen de Ventas*, baja a *Ventas por canal*.
2. En *Por canal* ves cuánto entró por *Mostrador*, *Mesas*, *Tienda en línea*, *Ligas de pago*, *Rappi*, *Uber Eats* y los demás, con ventas netas, propinas, comisiones y *Neto cobrado*.
3. Toca *Por tipo de pedido* para verlo como *En el local*, *Para llevar*, *A domicilio*, *Para recoger*, *Registro directo* o *Cobro de un monto*.
4. La fila *Total* da lo mismo que el resumen de arriba.
5. Debajo de *Ganancia neta*, *Paquetes vendidos en línea* y *Depósitos de reservas* dicen lo que cobraste por adelantado en línea. No son venta ni entran a *Neto cobrado*.

## Problemas frecuentes

- *Mesas* son las cuentas que tenían mesa; las demás de la caja, la terminal o la tablet salen en *Mostrador*.
- Un cobro rápido (un monto tecleado en la terminal) sale en *Cobro de un monto*, no en *Para llevar*.
- Un paquete que vendiste en la caja ya está en tus ventas; *Paquetes vendidos en línea* sólo cuenta los que se compraron en línea.
- *Depósitos de reservas* resta los depósitos que devolviste en el periodo y dice cuántos se cobraron.
