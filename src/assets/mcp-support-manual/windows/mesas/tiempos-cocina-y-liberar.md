---
title: Liberar tiempos y la comanda que sale de la pantalla de cocina en el POS Windows
description: Liberar el siguiente tiempo desde la caja o la cocina, cuándo sale la comanda de la pantalla de cocina y cómo regresarla.
product: windows
category: mesas
task: tiempos-cocina-y-liberar
requiredPermissions:
  - orders:read
  - orders:update
featureCode: TABLE_SERVICE
gateKind: FEATURE
versionMin: 2.25.55
sourceRepo: avoqado-android
sourceRef: 9ffba05b58cda839dd74906ede1cca3847653a42
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
  - ver preparación y liberar
  - esa estación no tiene impresora al liberar
  - la caja y la cocina liberaron al mismo tiempo
---

## Antes de empezar

En una mesa con tiempos (Primer, Segundo, Tercer tiempo…), lo *Inmediato* llega a la cocina como «Pendiente» y los demás tiempos llegan como «En espera de liberar»: la cocina los ve, pero no los prepara hasta que alguien los libera. Los tiempos son del plan Pro.

## Pasos

1. Desde la caja: en *Más › Servicio y entregas* (o en la cuenta, *⋯* del tiempo › *Ver preparación y liberar*) toca *Liberar*, elige cuántos y confirma. Con impresora sale el ticket «LIBERAR»; con sólo pantalla, no.
2. Para que la cocina libere: en el panel, *Configuración › Tiempos de servicio*, prende *La cocina puede liberar tiempos desde su pantalla* (viene apagado). La pantalla de cocina lo nota en un minuto.
3. En *Más › Pantalla de cocina*, cada producto avanza con *Preparar* y *Marcar listo* (eliges cuántos); con el interruptor prendido también sale *Liberar*, sin ticket. Sin tiempos, un solo botón *Listo*.
4. Cuando todos los productos quedan en «Listo» (o entregados o cancelados), la comanda sale sola de la pantalla y pasa a *Recientes* una hora. Si le queda algo retenido, se queda.
5. Para regresarla si se marcó por error: en la pantalla de cocina toca *Recientes* y luego *Deshacer*. Lo que estaba «Listo» vuelve a «Preparando».
6. La entrega a la mesa se sigue marcando con *Entregar* en *Servicio y entregas*.

## Problemas frecuentes

- «No me deja marcar el segundo tiempo»: está «En espera de liberar». Libéralo desde *Servicio y entregas* o prende el interruptor de arriba para que la cocina lo libere.
- La cocina no ve *Liberar*: el interruptor está apagado, o la persona no tiene permiso para actualizar cuentas.
- Si la caja y la cocina liberan el mismo tiempo casi a la vez, se libera una sola vez y ninguna de las dos avisa error; si la otra tenía la ventana abierta, cambia sola a «0 disponibles».
- Con internet, liberar a una estación que sólo tiene pantalla ya no avisa «Esa estación no tiene impresora…»: la cocina lo ve en su pantalla.
- En *Servicio y entregas* un producto que se anuló aparece en unos segundos como «ANULADO · …» con «Anulado en la caja: ya no se prepara ni se entrega.», sin cerrar la hoja.
- Si un producto va a dos estaciones (cocina y barra), la pantalla de cocina no ofrece *Liberar*: lo libera la caja desde *Servicio y entregas*, para las dos a la vez.
- Comandas de días pasados que no se quitaban: las de una cuenta ya cobrada o anulada se archivan solas al terminar el día del negocio (a las 4:00 a. m., y al menos una hora después de su último cambio). Las de una cuenta todavía abierta se quedan.
- *Deshacer* dice «Actualiza la app de la pantalla de cocina…»: esa tablet tiene una versión anterior; actualízala.
- *Deshacer* dice «Esta comanda cambió desde que abriste Recientes»: ciérralo y vuelve a abrir *Recientes*.
- *Deshacer* dice «Pasó más de una hora…»: después de una hora ya no se regresa desde *Recientes*; la caja puede corregir el producto desde *Servicio y entregas*.

## Sin internet

- *Preparar*, *Marcar listo* y *Liberar* (con el interruptor prendido) funcionan igual sin internet: se guardan en la tablet y suben solos. La comanda también sale de la pantalla al quedar todo listo.
- *Recientes* y *Deshacer* necesitan internet.
- Si la caja libera sin internet y la pantalla de cocina tampoco le contesta por el WiFi del local, la hoja dice «Pendiente de sincronizar» y, si esa estación no tiene impresora, a los pocos segundos (menos de un minuto) dice «Esa estación no tiene impresora: revisa la configuración de impresoras.»: avisa a cocina. Al volver la red se libera una sola vez.
- Si el negocio apaga el interruptor mientras la tablet de cocina está sin internet, lo que esa tablet libere ya no se acepta al volver la red: queda marcado para revisión y lo libera la caja.
