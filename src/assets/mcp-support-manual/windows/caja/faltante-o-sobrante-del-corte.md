---
title: Revisar un faltante o sobrante del corte de caja en el POS Windows
description: Cómo calcula el corte del POS Windows el efectivo esperado, y por qué puede salir un faltante o sobrante que no es real.
product: windows
category: caja
task: faltante-o-sobrante-del-corte
requiredPermissions:
  - payments:read
money: true
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - faltante
  - sobrante
  - descuadre de caja
  - corte de caja
  - efectivo esperado
  - conteo real
  - no cuadra la caja
---

## Antes de empezar

*Caja* en *Más* es para cajero, gerente, administrador y dueño. El *Efectivo esperado* es el *Monto inicial* más las *Ventas en efectivo* y los *Ingresos (pay-in)*, menos los *Egresos (pay-out)* y los *Reembolsos en efectivo*; lo cobrado con tarjeta no entra. El *Sobrante* o *Faltante* es el *Conteo real* menos el *Efectivo esperado*.

## Pasos

1. En *Más*, toca *Caja* y luego *Historial*.
2. Toca el turno para abrir su *Corte de caja*.
3. Revisa el *Conteo real*: es lo que se escribió al cerrar, y debe ser lo que quedó dentro del cajón con el fondo, no el efectivo cobrado ni lo que se retiró.
4. Para tenerlo en papel, toca *Imprimir corte*.

## Problemas frecuentes

- Si aparece «¿Contaste lo que quedó dentro del cajón?» al cerrar, lo escrito es igual a lo que se acaba de retirar o al efectivo cobrado en el turno: con *Volver a contar* se corrige antes de cerrar.

## Sin internet

- Si aparece «Sin conexión: este corte sólo incluye lo registrado en este aparato…», pueden faltar reembolsos o cobros hechos desde el panel o la terminal: vuelve a abrirlo con conexión.
