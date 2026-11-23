---
title: Resolver cobros de la máquina de efectivo en duda
description: Registra en el panel cómo terminó un cobro de la máquina de efectivo que la caja no alcanzó a confirmar, y revisa el renglón «Efectivo · máquina» del corte.
product: dashboard
category: ventas
dashboardRoutes:
  - cash-machine-doubts
  - shifts
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-21
sourceRepo: avoqado-web-dashboard
sourceRef: a0f0ac68aa0225db9e8f30c6e01e7106367aea86
relatedArticles:
  - gestionar-turnos
keywords:
  - esperando a la máquina
  - cobro de la máquina en duda
  - un gerente lo resuelve en el panel
  - la máquina cobró y no se registró
  - resolver cobro de la máquina
  - efectivo máquina en el corte
  - máquina de efectivo
  - QuickPay
---

## Antes de empezar

Cuando la caja de la máquina de efectivo no alcanza a saber cómo terminó un cobro (se cerró el punto de venta, se cortó la red o se apagó la computadora a media venta), la caja dice «Esperando a la máquina: un gerente lo resuelve en el panel» y no deja cobrar esa venta otra vez. Ese cobro se resuelve **sólo en el panel**, también desde el celular, con lo que dice la máquina. Nunca se cierra solo.

Necesitas el permiso «Resolver cobros de la máquina en duda», que de fábrica tienen el gerente, el administrador y el dueño. La entrada **Ventas > Cobros de la máquina en duda** sale en el menú sólo mientras hay algo pendiente de la máquina; si acaba de pasar y no la ves, recarga la página.

## Pasos

1. Abre **Ventas > Cobros de la máquina en duda**.
2. Ubica el cobro por su **Hora de inicio**, lo que **Debía** y su **Carrito**. La columna **La máquina reportó que entraron** dice lo más que la máquina alcanzó a reportar.
3. Ve a la máquina y revisa su pantalla o su comprobante.
4. Toca **Resolver**. En **¿Qué pasó en la máquina?** elige **Se cobró**, **Se canceló y devolvió** o **Se canceló y se quedó con el dinero**.
5. Escribe **Recibió $** y **Devolvió $**. Si fue una cancelación, contesta **¿Qué hizo la máquina con el dinero?**. Si tienes la **Hora del comprobante**, escríbela; si no, la venta queda con turno por conciliar.
6. En **Qué viste en la máquina** escribe lo que leíste (por ejemplo, «Pago completado», cuánto entró y cuánto dio de cambio) y toca **Guardar**.
7. Sale «Listo: el cobro … quedó resuelto». La caja se entera sola y enseña cómo terminó.

Si sale «Queda pendiente regresarle $… al cliente.», ese dinero se le paga desde la caja con un retiro, con el folio en la nota.

## Problemas frecuentes

- «Para «Se cobró», lo recibido tiene que ser al menos lo que debía»: revisa el monto; si no entró todo, no fue un cobro completo.
- «Si recibió todo lo que debía (…), el cobro no se pudo cancelar: elige «Se cobró».»
- «La máquina ya reportó que entraron …: no puedes registrar menos»: vuelve a revisar la pantalla de la máquina.
- **No sé** en **¿Qué hizo la máquina con el dinero?** no deja guardar: deja el cobro en duda hasta revisar la máquina.
- «Llegó evidencia nueva: revísala otra vez.»: la caja mandó algo nuevo mientras lo resolvías; revisa y guarda de nuevo.
- «Este cobro ya estaba resuelto así:»: alguien más lo resolvió; no lo vuelvas a capturar.
- «Registrado como incidencia: …»: no se armó la venta (por ejemplo, «las reservas y clases no se cobran en la máquina»), pero el dinero quedó anotado.
- **Cobro de la máquina por terminar**: la máquina ya dijo cómo terminó pero la venta no se terminó de registrar. Toca **Terminar**: se registra tal cual, sin teclear importes.
- **Otras incidencias de la máquina**: toca **Revisar**, escribe **Qué revisaste** y toca **Marcar como revisada**. Eso no mueve dinero.

## El corte: «Efectivo · máquina»

En **Ventas > Turnos de caja**, abre el turno. En **Metodos de Pago**, el Efectivo se parte en **Gaveta** y **Efectivo · máquina** cuando en ese turno se cobró con la máquina. Lo de la máquina no cuenta en el cajón: el efectivo esperado del arqueo no lo incluye, así que no sale un faltante falso. Cada venta queda en el turno en que se cobró.
