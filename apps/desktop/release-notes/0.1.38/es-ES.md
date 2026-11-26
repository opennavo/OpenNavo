## Novedades

- Pega texto, enlaces, rutas de archivos e imágenes en el compositor de Hermes. Los enlaces y las rutas se mantienen como chips de referencia, los textos largos y las imágenes del portapapeles se convierten en adjuntos, y los pegados demasiado grandes se rechazan antes de insertar nada.

## Correcciones

- Un fallo breve de red o de reactivación ya no sustituye la conversación por una pantalla de inicio de sesión. El historial en caché sigue visible tras un aviso de reconexión, y al reintentar se vuelve a comprobar de inmediato.
- El selector de sesiones vuelve a cargar el historial cada vez que se abre o cambia de vista, así que las sesiones creadas por otro cliente, una puerta de enlace o una tarea programada aparecen sin reiniciar la app.
- El compositor crece con un borrador de varias líneas hasta 110 px, también mientras hay una composición de IME abierta, y recupera su altura cuando Enviar o Nuevo chat borran el borrador.
- Un turno detenido muestra ahora una etiqueta clara de turno detenido, y las respuestas interrumpidas quedan vacías; la interfaz en inglés ya no muestra texto chino de parada.
- Enviar mientras se ejecuta una respuesta sigue la política de entrada ocupada: el mensaje se redirige, se guía o se pone en cola en lugar de iniciar un segundo turno, y Detener sigue disponible.
- Las actualizaciones de transmisión y de razonamiento ya no llevan el historial al final mientras lees mensajes anteriores. Solo sigue lo más reciente cuando ya estás al final.
