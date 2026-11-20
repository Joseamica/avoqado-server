---
title: Abrir y cerrar la caja en la terminal
description: Abre la caja con el efectivo inicial y ciérrala con el conteo de efectivo en la terminal, cuando el negocio usa turnos de caja.
product: tpv
category: caja
task: abrir-y-cerrar-caja
requiredPermissions:
  - tpv-shifts:create
  - tpv-shifts:close
money: true
versionMin: 2.16.0
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-18
keywords:
  - abrir caja
  - cerrar caja
  - turno de caja
  - corte de caja
  - arqueo
  - fondo de caja
---

## Antes de empezar

El botón *Turnos de caja* sale en el inicio sólo si el negocio usa turnos de caja.

## Pasos

1. En el inicio, toca *Turnos de caja*.
2. Para abrir, toca *Abrir caja* (o *Abrir nueva caja*), escribe el *Efectivo Inicial* o toca un monto sugerido, y toca *Abrir caja*.
3. Para cerrar, toca *Cerrar caja*.
4. Si sale *Arqueo de caja*, cuenta el efectivo, escribe el *Efectivo total contado* (incluye el fondo inicial) y toca *Cerrar y conciliar*.
5. Si no vas a contar, toca *Cerrar sin conteo* y luego *Sí, cerrar sin conteo*. Si no sale el arqueo, confirma con *Cerrar caja*.
6. Al cerrar, la pantalla dice «Cierre pendiente» hasta que Avoqado confirma el cierre, y después «Caja cerrada». Si sale *Listo*, tócalo.

## Problemas frecuentes

- «Caja pendiente de revisión»: toca *Revisar registros pendientes*.
- «Cierre guardado en este aparato» con «Pendiente de confirmación. No es un corte definitivo.»: el cierre todavía no se confirma; toca *Listo*.

## Sin internet

Si arriba dice «Sin conexión · guardado en este aparato», la apertura o el cierre quedaron guardados en la terminal y se envían después.
