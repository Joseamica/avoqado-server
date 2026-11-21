---
title: Cuando la comanda no sale en el POS Windows
description: Qué hacer cuando el POS Windows avisa que no salió la comanda de cocina, y cómo volver a imprimirla.
product: windows
category: impresoras
task: la-comanda-no-sale
requiredPermissions: []
sourceRepo: avoqado-android
sourceRef: 9ffba05b58cda839dd74906ede1cca3847653a42
keywords:
  - la comanda no sale
  - no salió la comanda
  - impresora de cocina
  - reimprimir comanda
  - volver a imprimir
  - ya la canté
  - esa estación no tiene impresora
  - no tiene impresora pero tengo pantalla de cocina
  - liberar tiempo sale no tiene impresora
  - pantalla de cocina minimizada
  - la pantalla de cocina no está conectada
---

## Antes de empezar

El aviso «No salió la comanda de: …» dice qué no salió. Ese aviso no cancela la venta.

## Pasos

1. Revisa que la impresora de esa estación esté encendida, con papel y conectada: por su cable a esta computadora o a la misma red del local.
2. Si el aviso trae *Volver a imprimir*, tócalo cuando la impresora esté lista. Puede repetir comandas que ya salieron: antes de tocarlo otra vez, pregunta en cocina qué les llegó.
3. Si ya le dijiste el pedido a la cocina, toca *Ya la canté*: esa comanda ya no se vuelve a intentar.
4. Si el aviso no trae *Volver a imprimir*, o para otra venta ya cobrada, en *Más* toca *Pedidos*, abre el pedido y toca *Reimprimir comanda* (va marcada como reimpresión).
5. En una mesa, ábrela, ve a *Acciones* y toca *Volver a imprimir pedido* (va marcada como reimpresión).

## Problemas frecuentes

- Si aparece «Reintentando la comanda», el POS la está volviendo a intentar solo: no la reimprimas mientras tanto.
- *Pedidos* pide el permiso de ver pedidos: sin él, que reimprima la comanda alguien que lo tenga.
- Si aparece «Esa estación no tiene impresora: revisa la configuración de impresoras.», no sale *Volver a imprimir*: esa estación necesita una impresora.
- Con una estación que sólo tiene pantalla de cocina, desde la 2.25.55 ya no sale «Esa estación no tiene impresora…» al mandar una ronda ni al liberar un tiempo si hay internet: la cocina lo ve en su pantalla. Si la caja no tiene internet y la pantalla de cocina tampoco le contesta por el WiFi del local, sí sale: en la cuenta como «No salió la comanda de: …» (se queda cerca de un minuto) y al liberar, en *Servicio y entregas*, a los pocos segundos. Avisa a cocina; al volver la red se manda una sola vez.
- Si la pantalla de cocina es una computadora con WINDOWS y su ventana de Avoqado está minimizada, cuenta como apagada: no recibe comandas ni avances, en un par de minutos las cajas dicen «La pantalla de cocina de … no está conectada a internet» y las comandas salen en papel (o, si esa estación no tiene impresora, la caja avisa). Ábrela: se pone al día en cuanto se ve. Taparla con otra ventana no la apaga.
- Tocar fuera del aviso sólo lo esconde: no la da por resuelta.
- Si el aviso trae *Volver a imprimir* y la app sigue abierta, esa comanda se vuelve a intentar sola, y puede repetir lo que ya salió: si la cocina ya tiene todo, toca *Ya la canté*. Se guardan todas las que no salieron, de la más vieja a la más nueva, durante 8 horas; después, reimprímela desde *Pedidos* o desde la mesa.
