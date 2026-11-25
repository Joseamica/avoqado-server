---
title: Qué ve el cliente en su pantalla y cómo se configura en el POS Windows
description: La segunda pantalla enseña al cliente su compra y el total; puede ofrecerle algo más, pedirle calificación y propina, y se configura en Más.
product: windows
category: clientes
task: pantalla-del-cliente
requiredPermissions: []
versionMin: 2.22.2
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - pantalla del cliente
  - segunda pantalla
  - el cliente no ve su total
  - el cliente elige la propina
  - calificación en la pantalla del cliente
  - algo más en la pantalla
  - pantalla del cliente no detectada
---

## Antes de empezar

Sirve cuando la computadora tiene un segundo monitor para el cliente. En reposo dice «Bienvenido». Mientras cobras, el cliente ve *Tu compra* con su carrito y el *Total*, y al final «¡Gracias por tu compra!» (con un QR para su recibo cuando el cobro ofrece recibo).

## Pasos

1. En *Más*, en *Hardware y aparatos*, toca *Pantalla del cliente*: dice «Detectada» o «No detectada».
2. Prende «El cliente elige propina y calificación» sólo si el cliente alcanza a tocar la segunda pantalla: el cajero ve una espera mientras el cliente decide.
3. Si ese cobro pide calificación o propina (según los ajustes del negocio), el cliente ve «¿Cómo estuvo tu experiencia?» (1 a 5 estrellas) y «¿Deseas dejar propina?», con porcentajes y *Sin propina*.
4. Si el negocio tiene sugerencias al cobrar, el cliente ve «¿Algo más?»: toca *Agregar* para sumar el producto o *No, gracias*.
5. Con «Invertir pantallas», el cliente ve la pantalla grande y el cajero trabaja en la chica, si el equipo lo permite.

## Problemas frecuentes

- Si dice «No se detecta una segunda pantalla en este equipo.», los interruptores salen apagados: conecta el segundo monitor y vuelve a abrir *Pantalla del cliente*.
- Si «Invertir pantallas» dice «Termina la venta en curso para poder cambiar de pantalla.», cobra o guarda la venta y vuelve a intentar.
- Las sugerencias de «¿Algo más?» se configuran en el panel, en *Promociones* › *Sugerencias al cobrar*.
- Prender la segunda pantalla no prende la propina ni la calificación: si el negocio no las pide en ese cobro, no salen.
- «Kiosco de check-in» cambia la pantalla del cliente para que cada quien registre su llegada a su clase: desde la 2.25.47 con un QR; en versiones anteriores, tocando su nombre en una lista.
