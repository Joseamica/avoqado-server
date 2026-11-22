---
title: Atender los pedidos en línea en el POS Windows
description: Acepta o rechaza pedidos de la tienda en línea, márcalos listos o entregados, reimprime, pausa y abre los ya pagados con tarjeta en línea, en el POS Windows.
product: windows
category: pedidos-en-linea
task: atender-pedidos-en-linea
requiredPermissions:
  - orders:read
money: true
versionMin: 2.25.32
sourceRepo: avoqado-android
sourceRef: a4e7d854341cdef73bf94ff109a9b54e0f029bf9
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
  - pedido pagado en línea
  - abrir y cobrar
  - suena un pedido pagado
  - no deja de sonar
  - me cobraron y no recogí
  - no lo recogió
  - no me deja pagar en línea
  - me salió pendiente en el banco
  - se pausó sola
  - la tienda se pausó
  - pedidos en línea en pausa
  - pedidos sin aceptar
---

## Antes de empezar

En *Más*, toca *Pedidos en línea*. Aceptar, rechazar, *Listo*, *Entregado* y *Reimprimir* sólo aparecen con el permiso de actualizar pedidos. Con el POS abierto, un pedido nuevo sale arriba en «Nuevo pedido en línea #…»: toca *Ver* para abrir la bandeja. Si cierras el POS Windows, no avisa.

Si en el panel el negocio eligió «Sí, alguien del personal lo acepta», la tienda recibe pedidos mientras el POS Windows esté abierto y sin minimizar en cualquier pantalla, con la sesión de alguien con el permiso de actualizar pedidos: no hace falta dejar abierta la bandeja (desde la versión 2.25.52; en versiones anteriores, sólo con la bandeja abierta). Minimizado, cerrado o sin internet, a los 2 min la tienda queda fuera de línea (la clienta ve «El negocio no está conectado. Intenta en unos minutos.»); al volver a abrir o mostrar la ventana se abre sola.

Si el negocio eligió «No, entran solos» y prendió «Pagar en línea», la clienta puede pagar con tarjeta al pedir: su dinero queda apartado y se cobra cuando una caja abre su pedido con *Abrir y cobrar*. No se pasa tarjeta: se cobra la tarjeta con la que pagó. Si nadie lo abre en 10 minutos (o antes, si cierra la tienda), se libera y no se le cobra. *Abrir y cobrar* pide el mismo permiso que *Aceptar*. Sólo un POS actualizado muestra la sección «Pagados en línea · ábrelo para cobrar»: si no la ves, actualiza el POS.

## Pasos

1. En «Por aceptar», toca *Aceptar* y elige en cuántos minutos estará listo (10, 15, 20 o 30 min). Para no tomarlo, toca *Rechazar* y elige el motivo: *Sin ingredientes*, *Cerrado*, *Muy ocupados* u *Otro*.
2. Cuando esté preparado, en «En preparación» toca *Listo*; cuando el cliente se lo lleve, toca *Entregado*. Para volver a imprimir su comanda en esta computadora, toca *Reimprimir*.
3. Para dejar de recibir pedidos nuevos un rato, toca *Pausar pedidos* arriba y elige 15, 30 o 60 min; para abrir otra vez, toca *Pausar pedidos* y luego *Reanudar*.
4. Pedido pagado en línea: mientras haya uno por abrir, la computadora suena cada 4 segundos y arriba sale «Pedido pagado en línea · ábrelo para cobrar» (con varios, «… (2 por abrir)»). Toca *Ver*.
5. En *Pedidos en línea*, en «Pagados en línea · ábrelo para cobrar», toca *Abrir y cobrar* en ese pedido. Sale «El pedido … ya está en «Por entregar».» y deja de sonar.
6. Cuando llegue la clienta, búscala por su nombre o folio en «Por entregar» (manda lo que dice la caja, no la pantalla de su celular) y toca *Listo* y *Entregado* como en cualquier folio.

## Problemas frecuentes

- Si la tienda dice fuera de línea, no llegan pedidos o se cierra sola, revisa que el POS Windows esté abierto y sin minimizar, con internet y con la sesión de alguien que acepta pedidos. Basta un aparato a la vista: esta computadora, otra caja o la Bandeja del panel.
- Si aparece «La tienda en línea se pausó sola: 2 pedidos seguidos no se aceptaron a tiempo. No llegan pedidos nuevos.» (o arriba «Pedidos en línea en pausa: 2 pedidos seguidos sin aceptar»), dos pedidos seguidos llegaron a su hora límite sin que nadie los aceptara ni rechazara a tiempo, y la tienda dejó de recibir pedidos. Sólo pasa con «Sí, alguien del personal lo acepta»: un pagado en línea que nadie abre no pausa la tienda. Toca *Reanudar* en esa misma pantalla para volver a recibirlos. Apagar y encender la tienda no la quita. En el panel se quita igual, con *Reanudar* en Pedidos en línea. En versiones anteriores del POS sólo dice que los pedidos están en pausa: toca *Pausar pedidos* y luego *Reanudar*.
- Si aparece «Los pedidos siguen en pausa: la pausa de Configuración se quita en el panel (Pedidos en línea › Configuración).», la pausa la puso un gerente en el panel: se quita ahí.
- Si aparece en el pedido «Con tarjeta: se cobra al aceptar», no lo cobres en la caja: ese pedido no muestra *Cobrar*.
- Si aparece «Cobra el pedido antes de entregarlo.», ese pedido todavía no está pagado.
- Si aparece «No se pudo cobrar la tarjeta» en un pedido, quedó rechazado porque su tarjeta no se pudo cobrar.
- Si aparece «Tarjeta cobrada: devuélvela desde el panel», ese pedido no se completó (se rechazó, se canceló o venció) y su tarjeta sí se cobró: la devolución se hace desde el panel.
- Si el cliente ya no quiere un pedido aceptado y sin ningún pago, toca *Cancelar pedido* y confirma con *Cancelar pedido*. Ese botón sólo sale con el permiso de cancelar ventas sin cobrar.
- Si aparece «Ese pedido ya no está disponible», el pedido ya cambió (por ejemplo, otro aparato lo atendió, el cliente lo canceló o, si era pagado en línea, se liberó sin cobrarse).
- Pausar pide el permiso de pausar pedidos en línea (de fábrica: gerente, administrador y dueño). Sin él, si el negocio tiene prendido el PIN de gerente, un gerente lo autoriza con su PIN.
- Si aparece en *Más*, junto a *Pedidos en línea*, «Incluido en el Plan …», el plan del negocio no incluye los pedidos en línea.
- Si la clienta ve «Este negocio no recibe pedidos en línea por el momento.» al pedir, la tienda está apagada en el panel o el plan del negocio no incluye los pedidos en línea.
- Al abrir un pagado en línea, su comanda sale sola en un aparato con impresora. Si este POS no tiene impresora no avisa si salió en otra caja: confirma con cocina.
- Si un pagado en línea dice «Pide a quien pueda atender pedidos que lo abra.», tu usuario no tiene el permiso de actualizar pedidos.
- Si su botón dice «Cobrándose en otra caja…», otra caja lo está abriendo: espera. Si al tocarlo sale «El pedido … ya está cerrado: no hay nada que abrir.», ya se entregó, se cerró o se devolvió.
- El aviso de un pagado en línea suena con el sonido de notificaciones de Windows y no se silencia: suena hasta que una caja lo abre o hasta que se libera.
- Si al tocar *Aceptar* en un pedido con tarjeta sale «Este pedido es con tarjeta en línea: se abre desde la caja (TPV o POS actualizados). No se aplicó nada.», tu POS no está actualizado: actualízalo o ábrelo desde otra caja actualizada.
- Si un pedido dice «Devolviendo…», «Devuelto» o «No lo recogió», ya no se entrega: no salen *Listo* ni *Entregado*. «No lo recogió» quiere decir que al terminar el día nadie se lo llevó.
- Si la clienta dice «me cobraron y no recogí» o cambió de opinión: no se le devuelve solo. Lo decide el negocio, y se devuelve desde el panel, a su tarjeta o como saldo a favor; el POS no devuelve estos pedidos.
- Si la clienta dice que no le deja pagar en línea: la tienda sólo ofrece «Pagar ahora con tarjeta» mientras una caja actualizada esté avisando los pedidos pagados y la tienda esté abierta. El POS Windows avisa sólo si está abierto, sin minimizar y con su ventana al frente (no tapada por otro programa), con sesión e internet; minimizado sigue sonando, pero no cuenta. Si ninguna caja avisa, sólo se ofrece pagar en caja. En el panel, *Configuración* de *Pedidos en línea* dice si hoy se ofrece.
- Si la clienta dice que le salió un cargo pendiente en su banco: si el pedido sigue en «Pagados en línea · ábrelo para cobrar», su dinero está apartado y se cobra al tocar *Abrir y cobrar*. Si nadie lo abrió a tiempo, se liberó y no se le cobró; quitar el pendiente depende de su banco.

## Sin internet

- Si aparece «Sin conexión: no llegan pedidos nuevos», aceptar, rechazar, *Listo*, *Entregado*, *Cancelar pedido* y *Pausar pedidos* quedan apagados hasta que vuelva la conexión.
- Sin red, el botón de un pagado en línea dice «Abrir y cobrar necesita conexión»: no se abre, no se cobra y nada queda guardado para después. Con lo que se leyó antes de quedarse sin red, el POS no suena.
- Si la conexión se cae al tocarlo y sale «Sin conexión: no se pudo confirmar. Al volver la conexión la lista dice dónde quedó; nunca se cobra dos veces.», no hagas nada más: al volver la red, revisa si está en «Por entregar».
- Si la red vuelve antes de los 10 minutos, el pedido vuelve a sonar y se abre normal; si no, se libera y no se cobra. Mientras ninguna caja tenga internet, la tienda deja de ofrecer «Pagar ahora con tarjeta» y sólo se puede pagar en caja.
