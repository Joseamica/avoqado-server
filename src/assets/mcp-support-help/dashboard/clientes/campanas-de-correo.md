---
title: Mandar una campaña de correo y la felicitación de cumpleaños
description: Arma una campaña de correo para los clientes que te dieron permiso, mándala, y configura la felicitación que sale sola antes de cada cumpleaños.
product: dashboard
category: clientes
featureCode: CUSTOMER_CAMPAIGNS
dashboardRoutes:
  - campaigns
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 34cd0e70ab3872f4ca6fc6410ea5925c31a71edd
relatedArticles:
  - aviso-de-privacidad
  - gestionar-clientes
keywords:
  - campaña de correo
  - mandar promoción por correo
  - correo a mis clientes
  - felicitación de cumpleaños
  - correo de cumpleaños
  - no me deja enviar la campaña
  - ningún cliente recibe el correo
  - entregados en cero
  - enviados en cero
  - cuántos correos llegaron
  - la campaña sigue en cola
  - newsletter
---

## Antes de empezar

Las campañas de correo vienen en el plan **Pro**. La entrada **Clientes > Campañas de correo** pide el permiso de manejar campañas; **Enviar** una campaña, **encender** la felicitación y guardar cambios mientras está encendida piden aparte el permiso de enviar. De fábrica, los dos los tienen el administrador y el dueño.

Sólo se le escribe a los clientes que dieron su permiso expreso para recibir correos de marketing. Ese permiso se pide al dar de alta o editar al cliente, y para pedirlo tu negocio necesita un **aviso de privacidad**.

## Pasos

1. Abre **Clientes > Campañas de correo** y toca **Nueva campaña**.
2. Escribe el **Nombre de la campaña** (sólo lo ves tú) y el **Asunto del correo**. En **A quién le llega** queda **Todos los que dieron permiso**.
3. Arma el **Contenido del correo** con los botones **Título**, **Texto**, **Imagen**, **Botón** y **Separador**; acomódalos con **Subir** y **Bajar** o quítalos con **Quitar**. Toca **Guardar borrador**: sale «Campaña guardada».
4. Para mandarla, abre la campaña en la lista y toca **Enviar**. El aviso dice a cuántos clientes se les puede mandar en ese momento (los que te dieron permiso) y que la campaña queda en la fila de envío; toca **Enviar a … clientes**. Sale «Campaña en la fila para … clientes: en la lista ves cuántos correos van saliendo.», con los que de verdad quedaron en la fila. Ya no se puede deshacer.
5. Para la felicitación de cumpleaños, en la tarjeta **Felicitación de cumpleaños** de arriba toca **Configurar** (o **Editar**). Revisa el **Asunto del correo**, los **Días de antelación** (0 = el mismo día, hasta 30) y el **Contenido del correo**.
6. Prende **Encender la felicitación** y toca **Guardar**. Sale «Felicitación encendida». Si la guardas apagada sale «Felicitación guardada y pausada».

## Problemas frecuentes

- **No sale el botón Enviar:** te falta el permiso de enviar. Una campaña nueva se manda hasta guardarla primero.
- **«Ningún cliente te ha dado permiso todavía para enviarle promociones.»:** pídeles permiso al registrarlos o márcalo en el formulario del cliente. Sin aviso de privacidad la casilla sale apagada.
- **«Pídele a un administrador que la encienda: encenderla autoriza el envío de correos.»:** quien tiene el permiso de enviar es quien la enciende.
- **La felicitación no llegó a tiempo:** cada día se revisa quién cumple años. Si el correo fuera a llegar tarde no se envía: felicitar después del cumpleaños es peor que no felicitar.
- **Los correos salen por tandas, no en el mismo segundo:** una campaña grande tarda más en terminar de salir. La campaña queda **En cola**, pasa a **Enviando** cuando se empieza a procesar la primera tanda (todavía puede decir 0 enviados) y a **Enviada** cuando ya no queda ninguno por mandar. **Enviada** no quiere decir que todos salieron: revisa **Enviados** y los **omitidos**. Mientras envía, la lista se actualiza sola cada 30 segundos; si sale un aviso de que no se pudo cargar, toca **Reintentar** o recarga la página.
- **¿Cuántos correos salieron?:** en la lista, **Enviados** dice cuántos ya salieron de los que se iban a mandar, por ejemplo «118 / 120». Cuenta los que el proveedor de correo aceptó y no rebotaron; si uno rebota después, pasa a **con error**, igual que los que el cliente marcó como spam o los que no se pudieron mandar tras varios intentos. Los **omitidos** no se mandaron: el cliente quitó su permiso, lo desactivaste o ya no tiene correo; su correo quedó bloqueado porque antes rebotó o lo marcó como spam; venció el plazo de envío; o al negocio le falta su nombre o un correo o teléfono de contacto.
- **Una campaña enviada ya no se edita:** se puede abrir para verla, no para cambiarla.
- **El estado de la felicitación** dice **Sin configurar**, **Encendida** o **Pausada**.
