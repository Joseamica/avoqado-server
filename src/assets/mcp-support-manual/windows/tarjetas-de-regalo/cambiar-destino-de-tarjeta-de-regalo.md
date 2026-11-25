---
title: Mandar una tarjeta de regalo vendida a otro teléfono o correo en el POS Windows
description: Con Cambiar destino, repón el código de una tarjeta de regalo vendida y mándala a otro WhatsApp o correo; el código de antes deja de servir.
product: windows
category: tarjetas-de-regalo
task: cambiar-destino-de-tarjeta-de-regalo
requiredPermissions:
  - giftCards:read
  - giftCards:manage
money: true
versionMin: 2.25.53
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - cambiar destino de la tarjeta
  - mandar la tarjeta a otro número
  - la tarjeta llegó a otro teléfono
  - correo equivocado en la tarjeta de regalo
---

## Antes de empezar

Es en la pantalla *Tarjetas de regalo* de la venta (se abre al terminar de cobrarla, o en *Más* › *Pedidos* al abrir la venta pagada que dice *Tarjetas de regalo*). *Cambiar destino* pide el permiso de administrar tarjetas de regalo (de fábrica, gerente, administrador y dueño). Repone el código: el de antes deja de servir.

## Pasos

1. En la tarjeta («•••• …»), toca *Cambiar destino*.
2. Elige *WhatsApp* o *Correo*.
3. Escribe el celular a 10 dígitos o el correo de quien la recibe.
4. Toca *Cambiar destino*: sale «Destino actualizado».

## Problemas frecuentes

- Si sale «Escribe el celular a 10 dígitos, con o sin +52» o «Revisa el correo», corrige el dato.
- Si sale «Para corregir el destino, cierra esta ventana y vuelve a abrirla.», cierra el aviso y ábrelo otra vez para escribir el dato correcto.
- Si el botón no sale, esa tarjeta ya no se repone (por ejemplo, si ya se usó) o te falta el permiso.

## Sin internet

- Si aparece «Sin conexión: las tarjetas de regalo necesitan internet», no se puede cambiar hasta que vuelva la conexión.
