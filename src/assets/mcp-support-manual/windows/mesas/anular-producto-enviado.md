---
title: Anular o dar de cortesía un producto ya enviado en el POS Windows
description: Quita de la cuenta de una mesa un producto que ya se mandó a cocina, o déjalo sin cobrar, desde Mesas en el POS Windows.
product: windows
category: mesas
task: anular-producto-enviado
requiredPermissions: []
featureCode: TABLE_SERVICE
gateKind: FEATURE
money: true
sourceRepo: avoqado-android
sourceRef: 9ffba05b58cda839dd74906ede1cca3847653a42
keywords:
  - cancelar un producto
  - quitar un producto que ya se mandó
  - anular producto
  - anular un platillo
  - borrar un producto de la mesa
  - el cliente cambió de parecer
  - cambiar una bebida ya enviada
  - se mandó a cocina por error
  - no puedo quitar un producto enviado
  - cortesía de un producto de la mesa
  - no reimprime la ronda sin internet
  - la cocina sigue viendo un producto anulado
  - producto anulado en la pantalla de cocina
  - sale tachado en la cocina
  - anular producto no se activa
---

## Antes de empezar

Es para productos que ya están guardados en la cuenta de una mesa en *Mesas*: los que se enviaron a cocina y también los que la terminal guardó en la cuenta. Anular pide el permiso de anular artículos y la cortesía el de dar cortesías; de fábrica los traen gerente, administrador y dueño. Lo que todavía está en tu carrito, sin enviar, no pasa por aquí.

## Pasos

1. En *Mesas*, toca la mesa ocupada para abrir su cuenta. Si la ventana está angosta, toca antes *Ver cheque*.
2. Toca el producto que ya se envió.
3. En *Motivo*, elige uno, por ejemplo «El cliente cambió de parecer». *Anular producto* se activa al elegir el motivo.
4. Toca *Anular producto*: sale de la cuenta y el total baja. Si aparece «Producto anulado — …», quedó.
5. Para dejarlo en la cuenta sin cobrarlo, en vez de anular toca *Dar de cortesía*.
6. Si aparece el teclado del PIN, un gerente escribe su PIN para autorizarlo.

## Problemas frecuentes

- *Esc* cierra la ventana sin anular nada, y *Enter* no anula: se anula con un clic en el botón.
- Si *Anular producto* sale en gris con «Es el único producto de la cuenta. Para quitarlo usa «Anular cuenta», o manda primero lo que lo reemplaza y luego anúlalo.»: agrega y envía primero el producto nuevo, o anula la cuenta completa.
- Si *Anular producto* sale en gris con «Es parte de una promoción y no se anula suelto…», ese producto es una pieza de un combo: dalo de cortesía o anula la cuenta completa.
- Si *Anular producto* sale en gris con «Esta cuenta ya tiene pagos registrados…», o aparece «Esta cuenta ya está pagada…», la cuenta ya tiene un cobro: no se anula. Si hay que devolver dinero, alguien con permiso hace un *Reembolso*.
- En la pantalla de cocina el producto anulado no desaparece: en unos segundos aparece con «ANULADO» en rojo, el producto tachado y «Cancelado», sin botones, y ya no cuenta como pendiente. Una pantalla de cocina con una versión anterior a la 2.25.55 lo muestra como «ANULADO · …» sin tachar. En una comanda sencilla la cocina la quita con *Listo*; con tiempos, sale sola cuando lo demás está listo.
- Con tiempos, si era lo último que faltaba de esa comanda, la comanda sale de la pantalla en segundos y la cocina quizá no alcance a ver «ANULADO»: si ya lo estaban preparando, avísales.
- Si esa estación sale en papel (impresora), no sale papel de cancelación: avisa a cocina. Si el encabezado dice «Enviado a la cocina» pero la cocina no lo recibió, pudo guardarlo la terminal sin mandarlo: revisa con cocina.
- Un producto que ya es cortesía no se abre al tocarlo.

## Sin internet

- Si la pantalla de cocina está sin internet, sigue viendo el producto como pendiente hasta que vuelva su internet: mientras, avisa a cocina.
- Sin internet el botón *Anular producto* no se ve en gris: al tocarlo aparece «Sin conexión — anular un producto enviado necesita internet; se habilita al volver la señal» y no se anuló: hazlo cuando vuelva la conexión. La cortesía de un producto enviado también necesita internet.
- Si aparece «Sin conexión: no supimos si el producto se anuló…», la red se cortó a media anulación: cuando vuelva, revisa la cuenta antes de anularlo otra vez.
- Sin internet, *Volver a imprimir pedido* no saca lo que ya se envió, porque otra caja pudo anular algo: aparece «Sin conexión: lo que ya se envió no se puede reimprimir porque otra caja pudo cambiarlo; se podrá al volver el internet.». Sí sale una ronda que esta caja mandó y que el servidor todavía no le confirma. Reimprime lo demás cuando vuelva la conexión; si la cocina lo necesita ya, díctaselo. Si aparece «Esta ronda se acaba de confirmar…» o «Una ronda de esta caja todavía no tiene confirmación del servidor…», lo que faltó sale al volver a tocar *Volver a imprimir pedido* cuando se confirme.
