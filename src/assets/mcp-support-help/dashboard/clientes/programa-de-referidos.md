---
title: Activar, ajustar o pausar el programa de referidos
description: Prende el programa de referidos con el premio del cliente nuevo y los tres niveles de quien recomienda, cambia un nivel, el premio o la vigencia, pausa la captura de códigos y reactívalo tal como estaba.
product: dashboard
category: clientes
featureCode: REFERRAL_PROGRAM
dashboardRoutes:
  - referrals
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 3d41101b39fc62045977b0b5f26acfa58c1c3103
relatedArticles:
  - gestionar-clientes
keywords:
  - programa de referidos
  - código de referido
  - activar referidos
  - premio por recomendar
  - niveles de referidos
  - pausar referidos
  - reactivar referidos
  - cambiar premio al referido
  - cambiar vigencia del cupón
  - mensaje de whatsapp del código
  - cliente recomienda a otro
  - descuento por referido
---

## Antes de empezar

El programa de referidos viene en el plan **Pro**. Verlo pide permiso para ver referidos; activarlo, editar un nivel, el premio o la vigencia, pausarlo o reactivarlo pide el permiso para configurarlo, que de fábrica tienen el administrador y el dueño. Sin él sale «No tienes permisos para configurar el programa de referidos. Pídelo a un administrador.».

Así funciona: el cliente nuevo da al pagar el código de quien lo recomendó y recibe un **% de descuento en su primera compra**. Quien recomienda sube de nivel cuando junta referidos que ya compraron, y en cada nivel gana un premio.

## Pasos

1. Abre **Clientes > Programa de Referidos**.
2. En **Premio al referido (su primera compra)**, escribe el % de descuento del cliente nuevo.
3. En **Niveles de quien recomienda**, para cada **Nivel** escribe los **Referidos requeridos** y el **Premio %**. Abajo, escribe la **Vigencia del cupón (días)** de esos premios.
4. Toca **Activar programa de referidos**. Sale «Programa activado correctamente» y la página muestra «✓ Activo desde …» con el **Resumen del mes**.
5. Para cambiar un nivel ya activo, toca **Editar nivel** junto a ese nivel. Ajusta los **Referidos requeridos** y cada premio: **Cupón de descuento** o **Producto gratis** (con su **Producto**, **Cantidad** y **Recurrencia**). Con **Agregar otro premio** sumas otro. Toca **Guardar cambios**.
6. Para cambiar el **Premio al referido (su primera compra)** o la **Vigencia del cupón (días)** ya activo, toca **Editar** junto a cualquiera de los dos. Escribe el número nuevo y toca **Guardar cambios**; sale «Cambios guardados». El nuevo premio aplica a los códigos que se validen desde ese momento y la nueva vigencia a los cupones que se emitan desde ese momento; lo ya emitido no cambia.
7. Para detenerlo, toca **Pausar programa**, escribe la **Razón de pausa** si quieres y toca **Pausar**. Arriba sale «Programa en pausa» y la página sigue enseñando tu premio, tus niveles con sus premios y tu vigencia. Los códigos existentes se conservan, pero ya no se pueden capturar códigos nuevos al cobrar hasta que lo reactives.
8. Para prenderlo otra vez, toca **Reactivar programa**. Vuelve tal como lo tenías, sin escribir nada de nuevo, y sale «Programa reactivado, tal como lo tenías». Los clientes que diste de alta durante la pausa reciben su código.

## Problemas frecuentes

- **«Debe ser mayor a … (el umbral del nivel anterior)»** o **«Debe ser menor a … (el umbral del siguiente nivel)»:** cada nivel necesita más referidos que el anterior y menos que el siguiente.
- **«Agrega al menos un premio para este nivel»:** cada nivel lleva por lo menos un premio.
- **«Selecciona un producto para este premio»:** un **Producto gratis** necesita su producto. Este premio lo entrega el personal a mano: no se aplica solo al cobrar.
- **Descuento permanente** sale apagado con «Requiere actualización de la terminal (próximamente)»: todavía no se puede elegir.
- **«El premio al referido debe ser un número entero entre 0 y 100»** o **«La vigencia debe ser un número entero de días entre 1 y 3650»:** escribe un número sin decimales dentro de ese rango.
- **Un nivel dice «sin premio (este nivel no entrega nada)»:** ese nivel no tiene premio guardado y nadie lo recibe al llegar a él. Toca **Editar nivel** y agrégale uno.
- **El cajero no puede capturar el código:** revisa que el programa siga activo (no pausado). En el punto de venta y en la terminal, el código se captura en el cobro con un cliente ya elegido y necesita internet.
- **¿Dónde está el código de un cliente?** En la ficha del cliente, en **Programa de Referidos**. Si dice «Esta persona aún no tiene código activo.», quien puede configurar referidos toca **Activar código ahora**; luego se puede **Copiar** o mandar por **WhatsApp**.
- **¿Qué dice el mensaje de WhatsApp?** El código del cliente y el **Premio al referido** que tienes guardado en ese momento. Con el programa en pausa no se abre y sale «El programa está en pausa: en la caja no se puede usar este código hasta que lo reactives.». Si sale «Tu navegador bloqueó la ventana de WhatsApp…», permite las ventanas emergentes del panel y vuelve a tocar **WhatsApp**.
