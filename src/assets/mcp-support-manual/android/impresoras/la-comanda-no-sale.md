---
title: Cuando la comanda no sale en el POS Android
description: Qué hacer cuando el POS Android avisa que no salió la comanda de cocina, y cómo volver a imprimirla.
product: android
category: impresoras
task: la-comanda-no-sale
requiredPermissions: []
sourceRepo: avoqado-android
sourceRef: f342ea4ea9da7f24eb576f8efa038e4861408cc0
keywords:
  - la comanda no sale
  - no salió la comanda
  - impresora de cocina
  - reimprimir comanda
  - volver a imprimir
  - ya la canté
  - pantalla de cocina no está conectada
  - no se alcanza por el wifi
  - avisa no salió la comanda con pantalla de cocina
---

## Antes de empezar

El aviso «No salió la comanda de: …» dice qué no salió. Ese aviso no cancela la venta.

## Pasos

1. Revisa que la impresora de esa estación esté encendida, con papel y en la misma red del local.
2. Si el aviso trae *Volver a imprimir*, tócalo cuando la impresora esté lista. Puede repetir comandas que ya salieron: antes de tocarlo otra vez, pregunta en cocina qué les llegó.
3. Si ya le dijiste el pedido a la cocina, toca *Ya la canté*: esa comanda ya no se vuelve a intentar.
4. Si el aviso no trae *Volver a imprimir*, o para otra venta ya cobrada, en *Más* toca *Pedidos*, abre el pedido y toca *Reimprimir comanda* (va marcada como reimpresión).
5. En una mesa, ábrela, ve a *Acciones* y toca *Volver a imprimir pedido* (va marcada como reimpresión).

## Problemas frecuentes

- Si aparece «Reintentando la comanda», el POS la está volviendo a intentar solo: no la reimprimas mientras tanto.
- *Pedidos* pide el permiso de ver pedidos: sin él, que reimprima la comanda alguien que lo tenga.
- Si aparece «Esa estación no tiene impresora: revisa la configuración de impresoras.», no sale *Volver a imprimir*: esa estación necesita una impresora.
- Tocar fuera del aviso sólo lo esconde: no la da por resuelta.
- Si el aviso trae *Volver a imprimir* y la app sigue abierta, esa comanda se vuelve a intentar sola, y puede repetir lo que ya salió: si la cocina ya tiene todo, toca *Ya la canté*. Sólo se guarda la última: una anterior, reimprímela desde *Pedidos* o desde la mesa.
- Si en una reimpresión salen productos que normalmente no van a cocina, no es falla de la impresora.
- Si aparece «Estos productos no llevan comanda», esos productos no se imprimen en cocina: no es una falla.
- Si la estación sólo tiene **pantalla de cocina** (sin impresora) y hay internet, ya no sale «No salió la comanda» en cada orden: la pantalla la toma de internet. Con un abono, sin internet o con una impresora que falla, el aviso sigue.
- Si arriba sale «La pantalla de cocina de … no está conectada», esa pantalla está cerrada, apagada o sin internet: ábrela; sus comandas le llegan cuando se conecte.
- Si arriba sale «La pantalla de … no se alcanza por el WiFi», la caja y la pantalla no se encuentran en la red del local: ponlas en el mismo WiFi (no el de invitados). Sin internet, a esa pantalla sólo le llega lo que va por el WiFi.
