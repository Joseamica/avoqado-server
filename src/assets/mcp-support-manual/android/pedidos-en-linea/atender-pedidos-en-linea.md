---
title: Atender los pedidos en línea en el POS Android
description: Acepta o rechaza los pedidos de la tienda en línea, márcalos listos o entregados, reimprime su comanda o pausa los pedidos, en el POS Android.
product: android
category: pedidos-en-linea
task: atender-pedidos-en-linea
requiredPermissions:
  - orders:read
money: true
versionMin: 2.25.13
sourceRepo: avoqado-android
sourceRef: 212f9cf4f150b7770cf6e753e5e2dbd78451948f
keywords:
  - pedidos en línea
  - tienda en línea
  - aceptar pedido
  - rechazar pedido
  - pedido listo
  - pausar pedidos
  - alarma de pedido nuevo
  - la tienda dice fuera de línea
  - no me llegan pedidos
  - se cierra sola la tienda
  - no llegan pedidos en línea
  - se pausó sola
  - la tienda se pausó
  - pedidos en línea en pausa
  - pedidos sin aceptar
---

## Antes de empezar

En *Más*, toca *Pedidos en línea*. Aceptar, rechazar, *Listo*, *Entregado* y *Reimprimir* sólo aparecen con el permiso de actualizar pedidos. Con la app abierta en pantalla, un pedido nuevo sale arriba en «Nuevo pedido en línea #…»: toca *Ver* para abrir la bandeja. Con la app en segundo plano no avisa.

Si en el panel el negocio eligió «Sí, alguien del personal lo acepta», la tienda recibe pedidos mientras el POS esté al frente en cualquier pantalla, con la sesión de alguien con el permiso de actualizar pedidos: no hace falta dejar abierta la bandeja (desde la versión 2.25.52; en versiones anteriores, sólo con la bandeja abierta). Con la app en segundo plano, la pantalla apagada o sin internet, a los 2 min la tienda queda fuera de línea (la clienta ve «El negocio no está conectado. Intenta en unos minutos.»); al volver a la app se abre sola.

## Pasos

1. En «Por aceptar», toca *Aceptar* y elige en cuántos minutos estará listo (10, 15, 20 o 30 min).
2. Para no tomarlo, toca *Rechazar* y elige el motivo: *Sin ingredientes*, *Cerrado*, *Muy ocupados* u *Otro*.
3. Cuando esté preparado, en «En preparación» toca *Listo*.
4. Cuando el cliente se lo lleve, toca *Entregado*.
5. Para volver a imprimir su comanda en este aparato, toca *Reimprimir*.
6. Para dejar de recibir pedidos nuevos un rato, toca *Pausar pedidos* arriba y elige 15, 30 o 60 min; para abrir otra vez, toca *Pausar pedidos* y luego *Reanudar*.

## Problemas frecuentes

- Si la tienda dice fuera de línea, no llegan pedidos o se cierra sola, revisa que el POS esté al frente con la pantalla encendida, con internet y con la sesión de alguien que acepta pedidos. Basta un aparato a la vista: este POS, otra caja o la Bandeja del panel.
- Si aparece «La tienda en línea se pausó sola: 2 pedidos seguidos no se aceptaron a tiempo. No llegan pedidos nuevos.» (o arriba «Pedidos en línea en pausa: 2 pedidos seguidos sin aceptar»), dos pedidos seguidos llegaron a su hora límite sin que nadie los aceptara ni rechazara a tiempo, y la tienda dejó de recibir pedidos. Toca *Reanudar* en esa misma pantalla para volver a recibirlos. Apagar y encender la tienda no la quita. En el panel se quita igual, con *Reanudar* en Pedidos en línea. En versiones anteriores del POS sólo dice que los pedidos están en pausa: toca *Pausar pedidos* y luego *Reanudar*.
- Si aparece «Los pedidos siguen en pausa: la pausa de Configuración se quita en el panel (Pedidos en línea › Configuración).», la pausa la puso un gerente en el panel: se quita ahí.
- Si aparece en el pedido «Con tarjeta: se cobra al aceptar», no lo cobres en la caja: ese pedido no muestra *Cobrar*.
- Si aparece «Cobra el pedido antes de entregarlo.», ese pedido todavía no está pagado.
- Si aparece «No se pudo cobrar la tarjeta» en un pedido, quedó rechazado porque su tarjeta no se pudo cobrar.
- Si aparece «Tarjeta cobrada: devuélvela desde el panel», ese pedido no se completó (se rechazó, se canceló o venció) y su tarjeta sí se cobró: la devolución se hace desde el panel.
- Si el cliente ya no quiere un pedido aceptado y sin ningún pago, toca *Cancelar pedido* y confirma con *Cancelar pedido*. Ese botón sólo sale con el permiso de cancelar ventas sin cobrar.
- Si aparece «Ese pedido ya no está disponible», el pedido ya cambió (por ejemplo, otro aparato lo atendió o el cliente lo canceló).
- Pausar pide el permiso de pausar pedidos en línea (de fábrica: gerente, administrador y dueño). Sin él, si el negocio tiene prendido el PIN de gerente, un gerente lo autoriza con su PIN.
- Si aparece en *Más*, junto a *Pedidos en línea*, «Incluido en el Plan …», el plan del negocio no incluye los pedidos en línea.
- Si la clienta ve «Este negocio no recibe pedidos en línea por el momento.» al pedir, la tienda está apagada en el panel o el plan del negocio no incluye los pedidos en línea.

## Sin internet

- Si aparece «Sin conexión: no llegan pedidos nuevos», aceptar, rechazar, *Listo*, *Entregado*, *Cancelar pedido* y *Pausar pedidos* quedan apagados hasta que vuelva la conexión.
