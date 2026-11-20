---
title: Liberar tiempos y la comanda que sale de la pantalla de cocina en el POS Android
description: Liberar el siguiente tiempo desde la caja o la cocina, cuándo sale la comanda de la pantalla de cocina y cómo regresarla.
product: android
category: mesas
task: tiempos-cocina-y-liberar
requiredPermissions:
  - orders:read
  - orders:update
featureCode: TABLE_SERVICE
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: ad8bae067cbfa77cb0a5827dbfdcb7b1dcc3867a
keywords:
  - segundo tiempo
  - no me deja marcar el segundo tiempo
  - liberar tiempo
  - en espera de liberar
  - tiempos de servicio
  - no me quita pedidos pasados
  - comandas viejas en la pantalla de cocina
  - la comanda no se quita de la pantalla
  - recientes
  - deshacer comanda
  - servicio y entregas
---

## Antes de empezar

En una mesa con tiempos (Primer, Segundo, Tercer tiempo…), lo *Inmediato* llega a la cocina como «Pendiente» y los demás tiempos llegan como «En espera de liberar»: la cocina los ve, pero no los prepara hasta que alguien los libera. Los tiempos son del plan Pro.

## Pasos

1. Para liberar el siguiente tiempo desde la caja: en *Más* toca *Servicio y entregas* y, en *En servicio*, toca *Liberar* en el producto. Sale el ticket «LIBERAR» en su estación.
2. Para que la cocina libere: en el panel, *Configuración › Tiempos de servicio*, prende *La cocina puede liberar tiempos desde su pantalla* (viene apagado). La pantalla de cocina lo nota en un minuto.
3. En *Más › Pantalla de cocina*, cada producto avanza con *Preparar* y *Marcar listo*; con el interruptor prendido también sale *Liberar*, sin ticket.
4. Cuando todos los productos quedan en «Listo» (o entregados o cancelados), la comanda sale sola de la pantalla y pasa a *Recientes* una hora. Si le queda algo retenido, se queda.
5. Para regresarla si se marcó por error: en la pantalla de cocina toca *Recientes* y luego *Deshacer*. Lo que estaba «Listo» vuelve a «Preparando».
6. La entrega a la mesa se sigue marcando con *Entregar* en *Servicio y entregas*.

## Problemas frecuentes

- «No me deja marcar el segundo tiempo»: está «En espera de liberar». Libéralo desde *Servicio y entregas* o prende el interruptor de arriba para que la cocina lo libere.
- La cocina no ve *Liberar*: el interruptor está apagado, o la persona no tiene permiso para actualizar cuentas.
- «Carga las demás estaciones del producto…»: ese producto va a dos estaciones; se libera desde *Servicio y entregas* en la caja.
- Comandas de días pasados que no se quitaban: las de una cuenta ya cobrada o anulada se archivan solas al terminar el día del negocio (a las 4:00 a. m.). Las de una cuenta todavía abierta se quedan.
- *Deshacer* dice «Actualiza la app de la pantalla de cocina…»: esa tablet tiene una versión anterior; actualízala.
- *Deshacer* dice «Esta comanda cambió desde que abriste Recientes»: ciérralo y vuelve a abrir *Recientes*.

## Sin internet

- *Preparar*, *Marcar listo* y *Liberar* (con el interruptor prendido) funcionan igual sin internet: se guardan en la tablet y suben solos. La comanda también sale de la pantalla al quedar todo listo.
- *Recientes* y *Deshacer* necesitan internet.
- Si el negocio apaga el interruptor mientras la tablet está sin internet, lo que la cocina ya liberó antes se respeta.
