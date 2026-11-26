---
title: Vender una tarjeta de regalo o cobrar con ella en el POS Windows
description: Vende una tarjeta de regalo, consulta su saldo o paga una venta con su saldo desde Cobrar en el POS Windows, cuando el negocio las tiene prendidas.
product: windows
category: tarjetas-de-regalo
task: vender-y-cobrar-tarjeta-de-regalo
requiredPermissions:
  - giftCards:read
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: c07a2bbebf453598963bf96f3208f66193dd5efb
deviceTested: 2026-11-18
keywords:
  - tarjeta de regalo
  - vender tarjeta de regalo
  - saldo de la tarjeta de regalo
  - pagar con tarjeta de regalo
  - gift card
  - certificado de regalo
---

## Antes de empezar

Si en *Atajos* no sale *Tarjeta de regalo*, esta computadora no tiene las tarjetas de regalo disponibles para el negocio. Vender pide el permiso de vender tarjetas de regalo, consultar el de consultarlas y pagar con saldo el de cobrar con ellas (de fábrica los traen cajero, gerente, administrador y dueño).

## Pasos

1. Para vender una, con el carrito vacío, en la pestaña *Atajos* de *Cobrar* toca *Tarjeta de regalo* y luego *Vender tarjeta*.
2. Elige un monto o escribe *Otro monto*. En «¿Cómo la entregas?» elige *Imprimir*, *Entregar al comprador*, *WhatsApp* o *Correo*; con WhatsApp o correo, llena el teléfono o el correo y *De parte de*.
3. Toca *Cobrar …* y cobra esa cuenta en la pantalla que se abre.
4. Para ver el saldo de una tarjeta, en *Tarjeta de regalo* toca *Consultar saldo*; escribe su código en *Teclear código* y toca *Verificar*, o toca *Escanear* y léelo con un lector USB.
5. Para pagar una venta con saldo, en la pantalla del cobro toca *Tarjeta de regalo* e identifica la tarjeta igual que al consultarla.
6. En *Monto a pagar con saldo*, deja el monto o bájalo, y toca *Pagar con saldo*.

## Problemas frecuentes

- Si aparece «Las tarjetas de regalo están apagadas. Pídele a un administrador o al dueño que las prenda.», todavía no se pueden vender en este negocio.
- Si aparece «La tarjeta se vende en su propia cuenta. Cobra o guarda esta venta primero.», cobra o guarda la venta del carrito y vuelve a *Vender tarjeta*.
- En Windows, *Escanear* no usa la cámara: abre un campo («La cámara no está disponible en Windows todavía…») donde el lector USB escribe el código, o lo escribes tú, y luego tocas *Verificar*.
- Si aparece «Comprobando el cobro con saldo…», no vuelvas a cobrar con la tarjeta: una persona tiene que revisar si ese cobro se hizo.
- Si aparece *Teléfono* al consultar, también puedes buscarla por el teléfono del cliente: toca *Teléfono*, escribe sus 10 dígitos y toca *Pedir código*; luego escribe el *Código de 6 dígitos* que le llega por WhatsApp (sólo si ese teléfono tiene tarjetas de regalo) y toca *Verificar*.
- Si en el cobro la fila *Tarjeta de regalo* sale apagada con «Para pagar con tarjeta de regalo, la venta necesita artículos del catálogo.», la venta sólo trae montos tecleados: con saldo se pagan ventas con productos del catálogo.

## Sin internet

- Si aparece «Sin conexión: las tarjetas de regalo necesitan internet», no se puede vender, consultar ni pagar con saldo hasta que vuelva la conexión.
