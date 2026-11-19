---
title: Abrir y cerrar la caja (app 2.13 o anterior) en la terminal
description: Abre la caja con el efectivo inicial y ciérrala con el conteo de efectivo en una terminal con la app 2.13 o anterior.
product: tpv
category: caja
task: abrir-y-cerrar-caja
requiredPermissions:
  - tpv-shifts:create
  - tpv-shifts:close
money: true
versionMin: 2.9.1
versionMax: 2.13.2
sourceRepo: avoqado-tpv
sourceRef: 81cc9983b24beb0bcdb85c907a361d3806383999
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

El botón *Turnos de caja* sale en el inicio sólo si el negocio usa turnos de caja. Sin permiso sale «No tienes permiso para abrir la caja» o «No tienes permiso para cerrar la caja».

## Pasos

1. En el inicio, toca *Turnos de caja*.
2. Para abrir, toca *Abrir caja*, escribe el *Efectivo Inicial* o toca un monto sugerido, y toca *Abrir caja*.
3. Para cerrar, toca *Cerrar caja*.
4. Si sale *Arqueo de caja*, cuenta el efectivo, escribe el *Efectivo total contado* y toca *Cerrar y conciliar*.
5. Si no vas a contar, toca *Cerrar sin conteo* y luego *Sí, cerrar sin conteo*. Si no sale el arqueo, confirma con *Cerrar caja*.
6. Si sale el resultado del conteo (*Turno cuadrado*, *Faltante*, *Sobrante*, *Turno cerrado sin conteo* o *Turno de caja cerrado*), toca *Listo*. Sin arqueo, sale *Turno de caja cerrado*.

## Problemas frecuentes

- Si después de cerrar la pantalla vuelve directo a «Sin turno de caja» sin mostrar el resultado, la caja sí se cerró: el resultado del conteo (*Turno cuadrado*, *Faltante* o *Sobrante*) se ve en *HISTORIAL DE TURNOS DE CAJA*.
- «La conciliación no está disponible. Revisa el turno de caja en el historial.»: la caja se cerró, pero sin el resultado del conteo; revísalo en el historial.
- «No se puede cerrar la caja todavía»: hay devoluciones que SÍ se hicieron y Avoqado todavía no tiene registradas; NO vuelvas a hacer la devolución. Las pendientes se registran solas con conexión. En una que dice «El servidor rechazó el registro», un gerente la concilia a mano con su referencia: toca *Ya lo vi — liberar el cierre* y vuelve a tocar *Cerrar caja*.

## Sin internet

En estas versiones abrir y cerrar la caja necesitan internet: no se guardan en la terminal. Sin conexión sale «No se pudo conectar al servidor.» con «Verifica tu conexión a internet.». Cuando vuelva la conexión, toca *Reintentar*: la pantalla vuelve a mostrar si la caja está abierta o cerrada; revísalo antes de repetir.
