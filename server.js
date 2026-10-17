// Muestra la webcam (ffmpeg) en vivo en una pantalla web. Al iniciar el timelapse guarda una foto cada N ms.
// Desde la pantalla se pueden ver las fotos y generar videos. Sin dependencias: Node >= 12 + ffmpeg.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PUERTO = Number(process.env.PORT) || 3000;
const DIR_FOTOS = path.join(__dirname, 'fotos');
const DIR_VIDEOS = path.join(__dirname, 'videos');

const FPS_VISTA = 4; // cuadros por segundo de la vista en vivo; el intervalo de guardado se mide aparte
let grabando = false; // true: se guardan fotos en disco cada intervaloMs
let proximaFoto = 0; // momento (ms) en que toca la siguiente foto guardada
let ultima = null; // Buffer del último JPEG
let contador = 0;
let job = null; // timelapse en curso: { estado, hecho, total, archivo }
let estado = { ok: false, mensaje: 'iniciando', ts: null };
let camara = null; // proceso ffmpeg de la webcam (null si no está corriendo)
let timerCamara = null; // reintento pendiente de la webcam
let saliendo = false;
const clientes = new Set(); // conexiones SSE

fs.mkdirSync(DIR_FOTOS, { recursive: true });
fs.mkdirSync(DIR_VIDEOS, { recursive: true });

function emitir(evento, datos) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const res of clientes) res.write(msg);
}
const snapshot = () => Object.assign({ grabando, config, n: contador, timelapse: job }, estado);

// ---------- Configuración ----------
// Se edita desde la pantalla y se guarda en config.json. Los valores iniciales salen de las variables
// de entorno (CAMARA, RESOLUCION, INTERVALO_MS) y config.json las pisa si existe.
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_BASE = {
  camara: process.env.CAMARA || '/dev/video0',
  resolucion: process.env.RESOLUCION || '1920x1080',
  intervaloMs: Number(process.env.INTERVALO_MS) || 60000, // tiempo entre fotos guardadas
};
let config = cargarConfig();

function cargarConfig() {
  try {
    return validarConfig(Object.assign({}, CONFIG_BASE, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))));
  } catch (e) { return Object.assign({}, CONFIG_BASE); }
}

function validarConfig(c) {
  if (!/^\/dev\/video\d+$/.test(c.camara)) throw new ErrorUsuario('Cámara inválida');
  if (!/^\d{3,5}x\d{3,5}$/.test(c.resolucion)) throw new ErrorUsuario('Resolución inválida (ej. 1920x1080)');
  const ms = Number(c.intervaloMs);
  if (!(ms >= 1000 && ms <= 86400000)) throw new ErrorUsuario('El intervalo debe estar entre 1 s y 24 h');
  return { camara: c.camara, resolucion: c.resolucion, intervaloMs: Math.round(ms) };
}

function guardarConfig(nueva) {
  const anterior = config;
  const validada = validarConfig(Object.assign({}, config, nueva));
  const cambioCamara = ['camara', 'resolucion'].some(k => validada[k] !== anterior[k]);
  if (grabando && cambioCamara) throw new ErrorUsuario('Detené el timelapse para cambiar la cámara o la resolución');
  config = validada;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  if (cambioCamara) reiniciarCamara();
  emitir('estado', snapshot());
}

// Webcams conectadas: cada una aparece como /dev/videoN; solo el nodo index 0 es el que captura imagen
function listarCamaras() {
  const base = '/sys/class/video4linux';
  let nodos = [];
  try { nodos = fs.readdirSync(base); } catch (e) { /* no es Linux o no hay cámaras */ }
  return nodos
    .filter(n => /^video\d+$/.test(n))
    .filter(n => { try { return fs.readFileSync(path.join(base, n, 'index'), 'utf8').trim() === '0'; } catch (e) { return true; } })
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
    .map(n => {
      let nombre = n;
      try { nombre = fs.readFileSync(path.join(base, n, 'name'), 'utf8').trim() || n; } catch (e) { /* sin nombre */ }
      return { dispositivo: '/dev/' + n, nombre };
    });
}

const RESOLUCIONES_COMUNES = ['3840x2160', '2560x1440', '1920x1080', '1280x720', '1024x768', '800x600', '640x480', '320x240'];

// Resoluciones MJPEG que soporta la cámara, preguntándole a ffmpeg; si no responde, una lista común
function listarResoluciones(dispositivo) {
  return new Promise(resolve => {
    if (!/^\/dev\/video\d+$/.test(dispositivo)) return resolve(RESOLUCIONES_COMUNES);
    const ff = spawn('ffmpeg', ['-hide_banner', '-f', 'v4l2', '-list_formats', 'all', '-i', dispositivo]);
    let out = '';
    const limite = setTimeout(() => ff.kill(), 5000);
    ff.stderr.on('data', d => { out += d; });
    const fin = () => {
      clearTimeout(limite);
      const encontradas = new Set();
      out.split('\n').filter(l => /mjpeg/i.test(l)).forEach(l =>
        (l.match(/\d{3,5}x\d{3,5}/g) || []).forEach(r => encontradas.add(r)));
      const area = r => r.split('x').reduce((a, b) => a * b);
      resolve(encontradas.size ? [...encontradas].sort((a, b) => area(b) - area(a)) : RESOLUCIONES_COMUNES);
    };
    ff.on('error', fin);
    ff.on('close', fin);
  });
}

// ---------- Webcam: ffmpeg queda abierto y escupe JPEGs por stdout ----------
const JPEG_INI = Buffer.from([0xff, 0xd8]);
const JPEG_FIN = Buffer.from([0xff, 0xd9]);

function nuevaFoto(jpeg) {
  ultima = jpeg;
  contador++;
  const ts = new Date();
  if (grabando && ts.getTime() >= proximaFoto - 1000 / FPS_VISTA / 2) {
    proximaFoto = Math.max(proximaFoto + config.intervaloMs, ts.getTime());
    const nombre = ts.toISOString().replace(/[:.]/g, '-') + '.jpg';
    fs.writeFile(path.join(DIR_FOTOS, nombre), jpeg, err => {
      if (err) avisar('no se pudo guardar la foto: ' + err.message);
    });
  }
  estado = { ok: true, mensaje: 'ok', ts: ts.toISOString() };
  emitir('foto', { n: contador, ts: estado.ts, bytes: jpeg.length });
}

function avisar(mensaje) {
  estado = { ok: false, mensaje, ts: new Date().toISOString() };
  emitir('aviso', estado);
}

function iniciarCamara() {
  if (saliendo || camara) return;
  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-f', 'v4l2', '-input_format', 'mjpeg', '-video_size', config.resolucion, '-framerate', '30',
    '-i', config.camara,
    '-vf', `fps=${FPS_VISTA}`,
    '-c:v', 'mjpeg', '-q:v', '2',
    '-f', 'image2pipe', '-',
  ]);
  camara = ff;

  let buf = Buffer.alloc(0);
  ff.stdout.on('data', chunk => {
    if (camara !== ff) return; // proceso ya reemplazado
    buf = Buffer.concat([buf, chunk]);
    // Cortar por marcadores JPEG: inicio FFD8, fin FFD9
    while (true) {
      const ini = buf.indexOf(JPEG_INI);
      if (ini < 0) { buf = Buffer.alloc(0); break; }
      const fin = buf.indexOf(JPEG_FIN, ini + 2);
      if (fin < 0) { buf = buf.slice(ini); break; }
      nuevaFoto(buf.slice(ini, fin + 2));
      buf = buf.slice(fin + 2);
    }
  });
  ff.stderr.on('data', d => { if (camara === ff) avisar('webcam: ' + d.toString().trim().slice(0, 200)); });

  let terminado = false;
  const reintentar = mensaje => {
    if (terminado) return; // 'error' y 'close' pueden dispararse los dos
    terminado = true;
    if (camara !== ff) return; // lo reemplazó reiniciarCamara()
    camara = null;
    avisar(mensaje);
    if (!saliendo) timerCamara = setTimeout(iniciarCamara, 3000);
  };
  ff.on('error', e => reintentar(`no se pudo ejecutar ffmpeg (${e.message}), reintentando`));
  ff.on('close', code => reintentar(`ffmpeg terminó (${code}), reintentando`));
}

// Aplica un cambio de cámara/resolución: espera a que la anterior suelte el dispositivo
function reiniciarCamara() {
  clearTimeout(timerCamara);
  const vieja = camara;
  if (!vieja) return iniciarCamara();
  camara = null;
  vieja.once('close', iniciarCamara);
  vieja.kill();
}

// ---------- Galería ----------
const RE_FOTO = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jpg$/;
const RE_VIDEO = /^[\w.-]+\.mp4$/;

class ErrorUsuario extends Error {}

// Nombre "2026-10-16T16-18-04-777Z.jpg" (UTC) -> Date
function fechaDeNombre(n) {
  return new Date(`${n.slice(0, 10)}T${n.slice(11, 13)}:${n.slice(14, 16)}:${n.slice(17, 19)}.${n.slice(20, 23)}Z`);
}

function parsearFecha(valor, nombre) {
  if (!valor) return null;
  const t = Date.parse(valor);
  if (isNaN(t)) throw new ErrorUsuario(`Fecha "${nombre}" inválida`);
  return t;
}

// Fotos entre desde y hasta (ISO, opcionales), de la más vieja a la más nueva
function listarFotos(desde, hasta) {
  const d = parsearFecha(desde, 'desde');
  const h = parsearFecha(hasta, 'hasta');
  return fs.readdirSync(DIR_FOTOS)
    .filter(n => RE_FOTO.test(n))
    .sort()
    .map(n => ({ nombre: n, ts: fechaDeNombre(n).toISOString() }))
    .filter(f => {
      const t = Date.parse(f.ts);
      return (d === null || t >= d) && (h === null || t <= h);
    });
}

// ---------- Timelapse ----------
function borrarCarpeta(dir) {
  try {
    for (const n of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, n));
    fs.rmdirSync(dir);
  } catch (e) { /* ya no existe o no se pudo: no es grave */ }
}

function generarTimelapse(opciones) {
  if (job && job.estado === 'generando') throw new ErrorUsuario('Ya hay un timelapse en curso');
  const fps = Math.min(120, Math.max(1, Number(opciones.fps) || 30));
  const fotos = listarFotos(opciones.desde, opciones.hasta);
  if (!fotos.length) throw new ErrorUsuario('No hay fotos en ese rango');

  // Carpeta temporal con enlaces numerados, para que ffmpeg las lea en orden
  const tmp = path.join(DIR_VIDEOS, '.tmp-' + Date.now());
  fs.mkdirSync(tmp);
  try {
    fotos.forEach((f, i) =>
      fs.symlinkSync(path.join(DIR_FOTOS, f.nombre), path.join(tmp, String(i + 1).padStart(7, '0') + '.jpg')));
  } catch (e) {
    borrarCarpeta(tmp);
    throw e;
  }

  const archivo = `timelapse-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
  job = { estado: 'generando', hecho: 0, total: fotos.length, archivo };
  emitir('estado', snapshot());

  const terminar = (ok, mensaje) => {
    if (job.estado !== 'generando') return; // 'error' y 'close' pueden dispararse los dos
    borrarCarpeta(tmp);
    job = ok ? Object.assign({}, job, { estado: 'listo', hecho: job.total })
             : Object.assign({}, job, { estado: 'error', mensaje });
    emitir('estado', snapshot());
  };

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y',
    '-framerate', String(fps), '-i', path.join(tmp, '%07d.jpg'),
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20',
    path.join(DIR_VIDEOS, archivo),
  ]);
  let err = '';
  ff.stdout.on('data', d => {
    const m = d.toString().match(/^frame=(\d+)/gm);
    if (m) { job.hecho = Number(m[m.length - 1].slice(6)); emitir('estado', snapshot()); }
  });
  ff.stderr.on('data', d => { err += d; });
  ff.on('error', e => terminar(false, `no se pudo ejecutar ffmpeg (${e.message})`));
  ff.on('close', code => terminar(code === 0, err.trim().slice(-300) || `ffmpeg salió con ${code}`));
}

// ---------- HTTP ----------
function leerJSON(req) {
  return new Promise((ok, mal) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > 1e5) { mal(new ErrorUsuario('Cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { ok(b ? JSON.parse(b) : {}); } catch (e) { mal(new ErrorUsuario('JSON inválido')); }
    });
    req.on('error', mal);
  });
}

function responder(res, codigo, tipo, cuerpo) {
  res.writeHead(codigo, tipo ? { 'Content-Type': tipo } : {});
  res.end(cuerpo);
}
const responderJSON = (res, datos) => responder(res, 200, 'application/json', JSON.stringify(datos));

// Sirve un archivo con soporte de Range (para poder adelantar el video)
function servirArchivo(req, res, ruta, tipo) {
  fs.stat(ruta, (e, st) => {
    if (e || !st.isFile()) return responder(res, 404);
    let ini = 0, fin = st.size - 1, parcial = false;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { // bytes=N- o bytes=N-M
        ini = Number(m[1]);
        if (m[2]) fin = Math.min(fin, Number(m[2]));
      } else {    // bytes=-N: los últimos N bytes
        ini = Math.max(0, st.size - Number(m[2]));
      }
      if (ini > fin) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      parcial = true;
    }
    const cabeceras = { 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Content-Length': fin - ini + 1 };
    if (parcial) cabeceras['Content-Range'] = `bytes ${ini}-${fin}/${st.size}`;
    res.writeHead(parcial ? 206 : 200, cabeceras);
    if (st.size === 0) return res.end();
    const flujo = fs.createReadStream(ruta, { start: ini, end: fin });
    flujo.on('error', () => res.destroy());
    flujo.pipe(res);
  });
}

async function atender(req, res) {
  const url = req.url.split('?')[0];
  const get = req.method === 'GET';
  const post = req.method === 'POST';

  if (get && url === '/') {
    return servirArchivo(req, res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }
  if (get && url === '/foto') {
    if (!ultima) return responder(res, 404);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return res.end(ultima);
  }
  if (get && url === '/eventos') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: estado\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clientes.add(res);
    return req.on('close', () => clientes.delete(res));
  }
  if (get && url === '/api/fotos') {
    const q = new URL(req.url, 'http://x').searchParams;
    const todas = listarFotos(q.get('desde'), q.get('hasta')).reverse(); // más nuevas primero
    const limite = Math.min(200, Number(q.get('limite')) || 60);
    const pagina = Math.max(1, Number(q.get('pagina')) || 1);
    return responderJSON(res, { total: todas.length, pagina, limite,
      fotos: todas.slice((pagina - 1) * limite, pagina * limite) });
  }
  if (get && url.startsWith('/fotos/')) {
    const n = decodeURIComponent(url.slice(7));
    if (!RE_FOTO.test(n)) return responder(res, 400);
    return servirArchivo(req, res, path.join(DIR_FOTOS, n), 'image/jpeg');
  }
  if (get && url === '/api/videos') {
    const lista = fs.readdirSync(DIR_VIDEOS).filter(n => RE_VIDEO.test(n)).sort().reverse()
      .map(n => ({ nombre: n, mb: +(fs.statSync(path.join(DIR_VIDEOS, n)).size / 1048576).toFixed(1) }));
    return responderJSON(res, lista);
  }
  if (get && url.startsWith('/videos/')) {
    const n = decodeURIComponent(url.slice(8));
    if (!RE_VIDEO.test(n)) return responder(res, 400);
    return servirArchivo(req, res, path.join(DIR_VIDEOS, n), 'video/mp4');
  }
  if (get && url === '/api/config') return responderJSON(res, config);
  if (post && url === '/api/config') {
    guardarConfig(await leerJSON(req));
    return responder(res, 204);
  }
  if (get && url === '/api/camaras') return responderJSON(res, listarCamaras());
  if (get && url === '/api/resoluciones') {
    const q = new URL(req.url, 'http://x').searchParams;
    return responderJSON(res, await listarResoluciones(q.get('camara') || config.camara));
  }
  if (post && url === '/api/timelapse') {
    generarTimelapse(await leerJSON(req));
    return responder(res, 202);
  }
  if (post && (url === '/iniciar' || url === '/parar')) {
    grabando = url === '/iniciar';
    proximaFoto = Date.now(); // la primera foto se guarda enseguida
    emitir('estado', snapshot());
    return responder(res, 204);
  }
  responder(res, 404);
}

const servidor = http.createServer((req, res) => {
  atender(req, res).catch(e => {
    if (res.headersSent) return res.destroy();
    const esUsuario = e instanceof ErrorUsuario || e instanceof URIError;
    console.error(esUsuario ? 'Pedido inválido:' : 'Error:', e.message);
    responder(res, esUsuario ? 400 : 500, 'text/plain; charset=utf-8', e.message);
  });
});

// Al cerrar, también cerrar la webcam para que no quede ffmpeg huérfano
function salir() {
  saliendo = true;
  clearTimeout(timerCamara);
  if (camara) camara.kill();
  process.exit(0);
}
process.on('SIGINT', salir);
process.on('SIGTERM', salir);

servidor.listen(PUERTO, () => {
  console.log(`Pantalla: http://localhost:${PUERTO}`);
  console.log(`Webcam: ${config.camara} ${config.resolucion}, guardando una foto cada ${config.intervaloMs} ms al iniciar el timelapse`);
  // Restos de un timelapse que quedó a medias si el proceso se cortó
  for (const n of fs.readdirSync(DIR_VIDEOS)) {
    if (n.startsWith('.tmp-')) borrarCarpeta(path.join(DIR_VIDEOS, n));
  }
  iniciarCamara();
});
