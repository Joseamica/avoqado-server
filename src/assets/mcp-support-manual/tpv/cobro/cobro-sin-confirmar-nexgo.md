---
title: Resolver un cobro sin confirmar en la terminal Nexgo
description: Qué hacer en la terminal Nexgo cuando un cobro con tarjeta se queda en Cobro sin confirmar.
product: tpv
category: cobro
task: cobro-sin-confirmar
deviceFamily: NEXGO
requiredPermissions:
  - payments:resolve-no-instrument
money: true
versionMin: 2.12.5
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - cobro sin confirmar
  - no se cobró
  - cobro pendiente
  - código de supervisor
  - cobro doble
---

## Antes de empezar

Si sale *Cobro sin confirmar*, no vuelvas a cobrar esa venta: puede que sí se haya cobrado.

## Pasos

1. Espera mientras dice «Consultando al servidor…» o «Consultando con AngelPay...».
2. Si el cliente no acercó ninguna tarjeta, celular ni reloj, toca *El cliente no presentó tarjeta* si aparece.
3. Si pide *Código de supervisor*, un gerente escribe su código y toca *Confirmar con código*.
4. Si sigue sin respuesta, toca *Consultar de nuevo* si aparece.
5. Para dejar la pantalla sin volver a cobrar, toca *Salir*.
6. Si después sale arriba que el cobro «SÍ pasó: Avoqado ya lo registró», no lo vuelvas a cobrar y toca *Entendido*.

## Problemas frecuentes

- «Ese código no tiene permiso para confirmarlo.»: el código debe ser de un gerente con permiso.
- *Cobro sin confirmar* no tiene *Reintentar* a propósito: volver a cobrar podría cobrar dos veces.

## Sin internet

Si el cobro se empezó en la terminal y Avoqado no contesta, sale «Sin conexión con Avoqado: este cobro queda sin confirmar y se revisa solo al volver la red.»: la terminal queda libre, pero antes de volver a cobrarle a ese cliente revisa el aviso.
