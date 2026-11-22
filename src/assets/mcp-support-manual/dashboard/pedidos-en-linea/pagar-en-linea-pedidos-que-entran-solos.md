---
title: Cobrar con tarjeta en línea los pedidos que entran solos, en el panel
description: Prende «Pagar en línea» con «No, entran solos» en Pedidos en línea, qué necesita, qué ve la clienta y por qué a veces no se ofrece o sale un cargo pendiente.
product: dashboard
category: pedidos-en-linea
task: pagar-en-linea-pedidos-que-entran-solos
requiredPermissions:
  - online-orders:manage
featureCode: ONLINE_ORDERING
gateKind: FEATURE
money: true
sourceRepo: avoqado-web-dashboard
sourceRef: f4e3180b42107eeb9e66a62174fa76fa21ffe9ad
browserTested: 2026-11-21
keywords:
  - pagar en línea
  - pagar ahora con tarjeta
  - cobrar con tarjeta en la tienda en línea
  - pedidos que entran solos
  - no me deja pagar en línea
  - no sale pagar ahora
  - no se ofrece pagar en línea
  - me salió pendiente en el banco
  - cargo pendiente en mi tarjeta
  - me apartaron el dinero
  - me cobraron sin que me atendieran
---

## Antes de empezar

Necesitas el permiso «Configurar pedidos en línea» y un plan que incluya Pedidos en línea. *Pagar en línea* es el interruptor de la tarjeta cuando los pedidos entran solos; viene apagado y no copia lo que tenías en «Sí, alguien del personal lo acepta».

Cómo funciona: la clienta paga con tarjeta al pedir y su dinero se aparta. Se cobra cuando una caja (terminal o POS actualizados) abre su pedido con *Abrir y cobrar*. Si nadie lo abre en 10 minutos (o antes, si cierra la tienda), se libera y no se le cobra. Nadie acepta ni rechaza el pedido, y el panel no lo puede abrir ni cobrar.

Para prenderlo hace falta:
- Una cuenta de Stripe que ya pueda cobrar. Sin ella, el interruptor sale en gris con «Para cobrar con tarjeta en línea, date de alta en Stripe.» o «Tu cuenta de Stripe todavía no puede cobrar.» y la liga *Conectar Stripe* o *Revisar Stripe* (sólo la ve un administrador o el dueño).
- Una terminal o un POS actualizados que ya hayan avisado pedidos pagados en los últimos 7 días.
- Lo que pide «No, entran solos»: tu horario de pedidos y un aparato que cobra folios conectado.

## Pasos

1. En *Ventas* › *Pedidos en línea* › *Configuración*, en «¿Alguien tiene que aceptar cada pedido?», elige *No, entran solos*.
2. Prende *Pagar en línea*. Debajo dice «La clienta paga con tarjeta al pedir: su dinero se aparta y se cobra cuando una caja abre su pedido. Si nadie lo abre en 10 minutos, se libera y no se le cobra.»
3. Toca *Guardar*. Si sale «Configuración guardada», ya quedó.
4. Lee la línea debajo de *Pagar en línea*: «Ahora tus clientes ven «Pagar ahora».» quiere decir que ya se ofrece.
5. Mientras la tienda esté abierta, deja al menos una terminal o un POS actualizados abiertos, al frente, con sesión e internet: es la caja que suena y abre los pedidos pagados.

## Qué ve la clienta

- En «¿Cómo quieres pagar?» elige *Pagar ahora con tarjeta* o *Pagar en caja*. Para pagar en línea tiene que entrar a su cuenta (WhatsApp, correo o Google): si no ha entrado, al tocar *Pedir* le pide «Entra a tu cuenta».
- Antes de pagar lee: «Se cobra a tu tarjeta cuando <tu negocio> abra tu pedido; si nadie lo abre a tiempo, no se te cobra. Si no lo recoges o cambias de opinión, no se te devuelve solo: lo decide <tu negocio>.»
- Ya pagado ve «Avisando a <tu negocio>… se te cobra cuando abra tu pedido.» y, abierto, «¡Pagado! Lo están preparando», la hora estimada y «Pasa por él con tu nombre o tu folio.» Ya pagado no lo puede cancelar desde su celular.
- Si nadie lo abre a tiempo: «<tu negocio> no pudo atender tu pedido. No se te cobró.» y «Si viste un cargo, tu banco lo liberará en unos días.»
- Si no pasa por él: al terminar el día ve «No lo recogiste» y «Si quieres que te devuelvan tu pago, habla con <tu negocio>.»

## Problemas frecuentes

- Si al guardar sale «Actualiza la terminal o el POS para que avise los pedidos pagados», no se guardó nada y *Pagar en línea* regresa apagado: actualiza la terminal o el POS, ábrelo con sesión y vuelve a intentarlo.
- Si dice «Ahora no se ofrece: ninguna caja está avisando los pedidos pagados en línea. Vuelve sola en cuanto una caja actualizada (terminal o POS) esté abierta en la lista de pedidos.» (y «Una caja avisó por última vez: …»), abre una terminal o un POS actualizados con sesión e internet y déjalos al frente; un POS Windows minimizado o tapado por otro programa no cuenta.
- Si dice «Ahora tus clientes no ven «Pagar ahora»: la tienda está apagada.», «… está cerrada por horario.» o «… está en pausa.», se vuelve a ofrecer en cuanto la tienda reciba pedidos.
- Si la clienta dice «no me deja pagar en línea»: sin una caja que avise ahora, con la tienda cerrada o en pausa, o con Stripe sin poder cobrar, la tienda sólo ofrece pagar en caja. Si le sale «Pagar en línea no está disponible ahora. Puedes pagar en caja.», la caja dejó de avisar mientras pedía. «Ahora hay muchos pagos en línea. Puedes pagar en caja o intentar en unos minutos.» y «Ya tienes pagos con tarjeta sin terminar en este negocio. Paga en caja o espera unos minutos.» son topes de pagos en espera; «Este monto no se puede pagar con tarjeta en línea. Paga en caja.» es por el monto. En caja siempre puede pagar.
- Si la clienta dice «me salió pendiente en el banco»: es el dinero apartado. Si una caja abrió su pedido, ya se cobró. Si nadie lo abrió a tiempo o el cobro falló, se liberó y no se le cobró: quitar el pendiente depende de su banco y el negocio no lo puede acelerar. En *Ventas* › *Pedidos en línea* › *Bandeja*, en «Últimas 24 horas», el pedido dice «Venció sin respuesta» y «No se cobró la tarjeta» (no se cobró) o «Liberando la tarjeta…» (se está soltando).
- Mientras espera a que una caja lo abra (hasta 10 minutos), el pedido pagado no sale en la *Bandeja* del panel: se abre y se cobra en la terminal o el POS, nunca en el panel. Sale en el panel al abrirse (en «Por entregar») o, si vence, en «Últimas 24 horas».
- Si apagas *Pagar en línea*, cambias a «Sí, alguien del personal lo acepta» o apagas la tienda, los pedidos que ya se pagaron siguen sonando en las cajas hasta que alguien los abra o se liberen.
- Para devolver un pedido ya cobrado (no lo recogió o cambió de opinión), ve la guía de devolver un pedido en línea pagado con tarjeta.

## Sin internet

El panel necesita internet. Si las cajas se quedan sin internet, la tienda deja de ofrecer «Pagar ahora» en poco más de un minuto y sólo se puede pagar en caja. Un pedido ya pagado no se puede abrir sin red: si la red vuelve antes de los 10 minutos, suena y se abre; si no, se libera y no se cobra.
