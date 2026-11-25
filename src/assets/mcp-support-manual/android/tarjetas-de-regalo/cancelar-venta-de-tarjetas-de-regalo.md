---
title: Cancelar una venta de tarjetas de regalo o liberarla en el POS Android
description: El mismo día y sin usarse, cancela una venta de tarjetas de regalo y devuelve completo su cobro; o, si la devolución no se hizo, libérala.
product: android
category: tarjetas-de-regalo
task: cancelar-venta-de-tarjetas-de-regalo
requiredPermissions:
  - giftCards:read
  - giftCards:manage
money: true
versionMin: 2.25.44
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - cancelar tarjeta de regalo
  - devolver tarjeta de regalo
  - reembolsar tarjeta de regalo
  - se vendió mal la tarjeta de regalo
  - liberar tarjeta de regalo
---

## Antes de empezar

Cancelar pide el permiso de administrar tarjetas de regalo (de fábrica, gerente, administrador y dueño), y devolver el cobro pide además el de reembolsar. Sólo se puede el mismo día y si ninguna tarjeta de la venta se usó: se cancelan todas juntas.

## Pasos

1. En *Más* › *Pedidos*, abre la venta pagada que dice *Tarjetas de regalo*.
2. Toca *Cancelar venta*, lee cuántas tarjetas y cuánto se cancela, y toca *Cancelar venta* otra vez.
3. Se abre la devolución del cobro: devuélvelo completo. Al terminar sale «¡Reembolso registrado!».
4. Si sale «Ahora devuelve completo cada cobro de esta venta.», toca *Devolver completo · …* en cada cobro que quede y devuélvelo igual.
5. Si comprobaste que la devolución NO se hizo, toca *Liberar*, marca «Comprobé que la devolución NO se hizo» y toca *Liberar*: las tarjetas se pueden usar otra vez.

## Problemas frecuentes

- Si *Cancelar venta* no sale, la venta ya no se puede cancelar (no es del mismo día, una tarjeta ya se usó o ya se canceló) o te falta el permiso. Debajo del total suele decir por qué.
- Si sale «No tienes permiso para reembolsar. Pídeselo a tu gerente.», que un gerente haga la devolución.
- Si no sabes si la devolución se hizo, no toques *Liberar*: las tarjetas se quedan bloqueadas mientras tanto.

## Sin internet

- Si aparece «Sin conexión: las tarjetas de regalo necesitan internet», no se puede cancelar ni liberar hasta que vuelva la conexión.
