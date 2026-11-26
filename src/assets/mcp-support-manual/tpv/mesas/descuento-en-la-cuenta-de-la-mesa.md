---
title: Poner o quitar un descuento en la cuenta de una mesa en la terminal
description: En el cobro de una mesa, aplica uno de los descuentos del negocio a toda la cuenta, o quita uno que ya tenga.
product: tpv
category: mesas
task: descuento-en-la-cuenta-de-la-mesa
requiredPermissions:
  - discounts:apply
featureCode: TABLE_SERVICE
gateKind: FEATURE
money: true
versionMin: 2.8.1
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
deviceTested: 2026-11-25
keywords:
  - descuento en la mesa
  - descuento a la cuenta
  - quitar descuento de la mesa
  - quitar cargo por servicio
  - requiere autorización de gerente
---

## Antes de empezar

Es en el cobro de la cuenta de una mesa (después de tocar *Pagar*). Se eligen descuentos que ya existen en el negocio. Los que piden autorización de un gerente no se aplican desde la terminal.

## Pasos

1. En la cuenta de la mesa, toca *Pagar*.
2. Toca *+ Agregar descuento*.
3. En *Descuentos disponibles*, toca el descuento: se aplica a la cuenta y baja lo que queda por cobrar.
4. Para quitar un descuento o un cargo por servicio que se puso a mano, toca el botón − junto a él, si sale.
5. Cobra como siempre.

## Problemas frecuentes

- Si dice «No hay descuentos disponibles para esta cuenta.», no hay descuentos activos que apliquen: se crean en el panel.
- Si un descuento dice «Requiere autorización de gerente», sale apagado: desde la terminal no se aplica, ni con un gerente.
- Un cargo por servicio automático (el que se pone solo por los comensales) no trae el botón −: no se quita desde la terminal.
- Si el descuento sale sólo como un total «Descuentos», sin botón −, o el botón sale apagado (por ejemplo, una rebaja fijada al cobrar vales), no se quita desde la terminal: avisa a un encargado.

## Sin internet

- Quitar un descuento o un cargo por servicio necesita conexión: sin ella, espera a que vuelva.
