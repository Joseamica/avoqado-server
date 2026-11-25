---
title: Quitar o cambiar el descuento que ya no aplica de una liga de pago en el panel
description: Cuando el descuento de una liga de pago se venció o ya no está disponible, quítalo, pon otro o archiva la liga desde Ligas de pago.
product: dashboard
category: ligas-de-pago
task: quitar-descuento-de-liga-de-pago
requiredPermissions:
  - payment-link:read
  - payment-link:update
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
keywords:
  - descuento vencido en la liga
  - quitar descuento de la liga de pago
  - cambiar el descuento de la liga
  - el cliente no ve el descuento
  - descuento no disponible
---

## Antes de empezar

En *Ligas de pago*, debajo del importe, una liga con un descuento que ya no aplica lo marca con ⚠ y el motivo, por ejemplo «Descuento vencido» o «Descuento no disponible». Las opciones para arreglarlo piden el permiso de editar ligas de pago (de fábrica, gerente, administrador y dueño).

## Pasos

1. En *Ligas de pago*, busca la liga con el aviso ⚠ debajo del importe.
2. Para que se cobre sin descuento, toca *Quitar descuento* y confirma con *Quitar descuento*: sale «Descuento quitado».
3. Para ponerle otro, toca *Poner otro*: se abre la liga para editarla; elige el descuento nuevo y guárdala.
4. Si ya no la vas a usar, toca *Archivar* y confírmalo.

## Problemas frecuentes

- Al quitar el descuento, quien abra la liga paga el precio completo, también quien ya la recibió.
- Un descuento del catálogo con límite de usos (o por cliente) no se puede usar en una liga de pago: sale «Descuento no disponible». Quítalo o pon otro sin límite.
- «Descuento vencido», «El descuento aún no empieza» o «Descuento fuera de horario» salen por sus fechas y horarios; revísalos en *Promociones* › *Descuentos* o pon otro.
- «El descuento no cabe en el importe»: el importe no llega a la compra mínima del descuento, o el descuento lo dejaría en $0.
