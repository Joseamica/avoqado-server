---
title: Declarar que un cobro no se cobró desde el aviso en la terminal
description: Usa el botón No se cobró del aviso de cobros sin confirmar para cerrar en la terminal un cobro que no pasó.
product: tpv
category: cobro
task: declarar-no-se-cobro
requiredPermissions:
  - payments:reconcile-uncharged
money: true
versionMin: 2.16.0
sourceRepo: avoqado-tpv
sourceRef: 031f14db2969606125a4a04c9f8f30bdd402a660
keywords:
  - no se cobró
  - cobro sin confirmar
  - aviso de cobros pendientes
  - pin de gerente
  - quedó un cobro sin confirmar
---

## Antes de empezar

Si arriba sale un aviso de un cobro sin confirmar, revisa antes que de verdad no se cobró: al declararlo queda tu nombre y la hora. Si el aviso no trae *No se cobró*, ese cobro no se puede declarar desde ahí.

## Pasos

1. En el aviso, toca *No se cobró*. Si hay varios cobros, elige el que no pasó en *¿Cuál no se cobró?*.
2. En *¿No se cobró este cobro?*, revisa el importe y toca *Sí, no se cobró*.
3. Si sale *Pide a un gerente que ingrese su PIN*, el gerente escribe su *PIN de gerente* y toca *Confirmar*.

## Problemas frecuentes

- «Avoqado tiene evidencia de este cobro: no lo declares ni lo vuelvas a cobrar.»
- «Para dejar constancia de que no se cobró se necesita el permiso de conciliar cobros; pídeselo a tu gerente.»
- «Esta versión todavía no permite declararlo desde la terminal: contéstalo en el POS.»
- «Ese PIN no tiene permiso para confirmarlo.»: el PIN debe ser de un gerente con permiso.

## Sin internet

Un cobro que mandó el punto de venta no se puede declarar sin conexión: sale «Sin conexión: esto necesita internet. Cuando vuelva, inténtalo otra vez.». Uno empezado en la terminal sólo se puede declarar si Avoqado ya contestó por él; si no, sale «Primero hay que consultar a Avoqado: conéctate a internet.».
