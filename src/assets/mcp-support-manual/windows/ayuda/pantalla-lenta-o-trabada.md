---
title: Cuando la pantalla va lenta o se traba en el POS Windows
description: Qué hacer si el POS Windows tarda en dibujar la pantalla en una computadora vieja: el modo rápido, dónde se cambia y qué esperar.
product: windows
category: ayuda
task: pantalla-lenta-o-trabada
requiredPermissions: []
versionMin: 2.25.59
sourceRepo: avoqado-android
sourceRef: 8f540228321648fb2d945cd76e86d5efa4c53fee
keywords:
  - el POS va lento
  - se traba
  - está trabado
  - tarda en responder
  - se congela
  - se queda pensando
  - la pantalla va lenta
  - computadora vieja
  - PC vieja
  - modo rápido
  - modo de dibujo
  - tarjeta de video
  - Windows lento
  - activar modo rápido
  - diagnóstico de esta computadora
---

## Antes de empezar

Esta guía es para cuando lo lento es la pantalla: tocar, deslizar o abrir una pantalla tarda en responder. Si lo que tarda es cargar o mandar datos, o sale «Sin conexión», es el internet: el modo rápido no lo arregla.

Cuando el POS mide al abrir que la computadora tarda en dibujar la pantalla, arriba de la app sale el aviso «Esta computadora tarda en dibujar la pantalla. El modo rápido puede ayudar.».

## Pasos

1. En ese aviso, toca *Activar modo rápido*. Si ya no sale (por ejemplo, porque tocaste *Ahora no*), ve a *Más*, toca *Modo de dibujo* (junto a *Ajustes*) y elige *Modo rápido*.
2. Sale «Listo. Cierra y vuelve a abrir el POS para aplicarlo.». Toca *Entendido*.
3. Cierra el POS y vuelve a abrirlo: el modo rápido se aplica hasta que lo abres otra vez.
4. Para ver cómo quedó, en *Más* toca *Diagnóstico de esta computadora*: en *Gráficos* dice si usa la tarjeta de video o el modo rápido.
5. Para regresar, en *Más* › *Modo de dibujo* elige *Automático*, y cierra y vuelve a abrir el POS.

## Qué esperar

- El modo rápido dibuja sin la tarjeta de video y con menos animaciones. En una computadora con tarjeta de video antigua la hace usable, pero no tan fluida.
- Para que el POS vaya fluido hace falta una tarjeta de video con DirectX 12. Con una así, deja *Automático*: en una tarjeta moderna el modo rápido puede ir más lento.
- Cambiar el modo no toca las ventas, las mesas ni lo que está guardado sin internet.

## Problemas frecuentes

- Si al abrir sale «El modo rápido no funcionó en esta computadora. La app regresó al modo automático.», el modo rápido no pudo abrir y el POS volvió solo a *Automático*. Toca *Entendido* y sigue trabajando. Si la pantalla sigue lenta, esa computadora necesita una tarjeta de video más nueva.
- Si sale «Esta computadora tarda en dibujar la pantalla, aun en modo rápido. Puedes seguir trabajando, pero la app va a responder lento.», el modo rápido ya está puesto y no alcanza. Se puede seguir vendiendo, lento. En *Diagnóstico de esta computadora* revisa también la memoria RAM y el procesador: ahí dice lo recomendado.
- Si eliges *Automático* a mano, el aviso ya no vuelve a ofrecer el modo rápido. Siempre se puede cambiar en *Más* › *Modo de dibujo*.
- Si en *Modo de dibujo* sale «Fijado a mano en esta computadora…», el modo se fijó en la configuración de esa computadora y manda sobre lo que elijas en la app: una persona de soporte tiene que revisarlo.
- Si en *Más* sale *Diagnóstico de esta computadora* pero no *Modo de dibujo*, el modo de dibujo está apagado en esa computadora: una persona de soporte tiene que revisarlo.
- En el panel web, en *Dispositivos*, la página de esa computadora muestra *Rendimiento* («Fluida», «Modo rápido», «No alcanza» o «Sin medir todavía») y *Modo de dibujo*. Ahí sólo se ve: se cambia en la computadora.

## Sin internet

- Cambiar el modo de dibujo no necesita internet: se guarda en la computadora y se aplica al volver a abrir el POS.
- El panel web lo muestra cuando el POS vuelve a tener conexión.
