# Timelapse de semillas

Herramienta para hacer **timelapse** con una webcam, pensada para el experimento de germinación de semillas de Fisiología Vegetal (UTEC). Saca fotos automáticamente cada cierto tiempo, las guarda ordenadas por fecha y permite armar un video acelerado del crecimiento, todo desde una pantalla web.

No tiene dependencias de npm: solo **Node.js 12 o superior** y **ffmpeg**.

## Requisitos

- Node.js >= 12
- ffmpeg instalado y en el `PATH`
- Una webcam compatible con Linux (V4L2) que entregue MJPEG

## Uso

```bash
npm start        # o: node server.js
```

Después abrí `http://localhost:3000` en el navegador. Desde otra máquina de la red, usá la IP del equipo en lugar de `localhost`.

El puerto se cambia con una variable de entorno: `PORT=3001 node server.js`.

## Qué hace

La pantalla web tiene dos pestañas:

- **En vivo**: muestra la cámara en tiempo real y tiene la configuración (cámara, resolución e intervalo entre fotos). El botón **Generar timelapse** empieza a guardar una foto en `fotos/` cada N segundos (nombre con fecha UTC, por ejemplo `2026-10-16T16-18-04-777Z.jpg`); el mismo botón pasa a **Detener timelapse**. Mientras se guarda no se puede cambiar la cámara ni la resolución.
- **Galería**: fotos paginadas con filtro por rango de fechas y visor a pantalla completa. Abajo se puede crear un video `.mp4` (H.264) con las fotos del rango, eligiendo los FPS; los videos quedan en `videos/` para reproducirlos o descargarlos.

Si la cámara falla, se reintenta cada 3 segundos. La configuración se aplica al cambiar cada campo y se guarda en `config.json`. Los valores iniciales salen de las variables de entorno `CAMARA`, `RESOLUCION` e `INTERVALO_MS`.

## Estructura

```
server.js       servidor: captura, galería, timelapse y API
public/         pantalla web (index.html)
fotos/          fotos capturadas
videos/         timelapses generados
config.json     configuración guardada desde la pantalla
video.sh        alternativa por terminal: ./video.sh [salida.mp4] arma un video con todas las fotos
```

## API

| Método y ruta | Función |
|---|---|
| `GET /eventos` | Eventos en vivo (SSE): fotos nuevas, estado, avisos |
| `GET /foto` | Última foto |
| `GET /api/fotos?desde&hasta&pagina&limite` | Lista de fotos (fechas en ISO) |
| `GET /fotos/<nombre>` | Una foto |
| `GET /api/videos`, `GET /videos/<nombre>` | Lista y descarga de videos |
| `POST /api/timelapse` | Genera un video: `{ "fps": 30, "desde": "...", "hasta": "..." }` |
| `GET /api/config`, `POST /api/config` | Leer y guardar la configuración |
| `GET /api/camaras`, `GET /api/resoluciones?camara=` | Cámaras detectadas y resoluciones soportadas |
| `POST /iniciar`, `POST /parar` | Empezar y detener el guardado de fotos |

## Consejos para el experimento

- Fijá la cámara y la iluminación: cualquier movimiento se nota mucho en el video.
- Para semillas, un intervalo de 1 a 10 minutos suele alcanzar. Con intervalos cortos se llena el disco rápido (a 1920x1080, cada foto pesa cientos de KB).
- Los nombres de las fotos están en UTC; la pantalla las muestra en hora local.

## Notas

- El listado de cámaras solo funciona en Linux, porque lee `/sys/class/video4linux`.
- Esta versión no controla ningún dispositivo externo (ESP32, luces o fotoperiodo): se quitó todo eso y quedó solo el timelapse.
