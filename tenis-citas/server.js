require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool, types } = require('pg');

// Que las columnas DATE lleguen como texto "YYYY-MM-DD" (sin problemas de zona horaria)
types.setTypeParser(1082, (v) => v);

const PORT = process.env.PORT || 3000;
const TZ_NEGOCIO = process.env.TZ_NEGOCIO || 'America/El_Salvador';
const APERTURA = Number(process.env.HORA_APERTURA ?? 7); // primera hora de clase
const CIERRE = Number(process.env.HORA_CIERRE ?? 20); // las clases deben terminar antes de esta hora
const PASO = 30; // las clases empiezan en :00 o :30
const DURACIONES = [30, 60, 90, 120];
const PIN = process.env.PROFESOR_PIN || '';

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable DATABASE_URL (la cadena de conexión de Postgres de Railway).');
  process.exit(1);
}

const esLocal = /localhost|127\.0\.0\.1|railway\.internal/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: esLocal ? false : { rejectUnauthorized: false },
});

/* ---------- utilidades ---------- */

function aMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function aHHMM(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

function fechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function ahoraNegocio() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_NEGOCIO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => partes.find((p) => p.type === t).value;
  return {
    fecha: `${g('year')}-${g('month')}-${g('day')}`,
    minutos: Number(g('hour')) * 60 + Number(g('minute')),
  };
}

function exigirPin(req, res, next) {
  if (!PIN) {
    return res.status(500).json({ error: 'Falta configurar PROFESOR_PIN en el servidor.' });
  }
  const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const dado = hash(req.get('x-pin') || '');
  if (!crypto.timingSafeEqual(dado, hash(PIN))) {
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  next();
}

/* ---------- base de datos ---------- */

async function iniciarBD() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservas (
      id           SERIAL PRIMARY KEY,
      nombre       TEXT        NOT NULL,
      telefono     TEXT        NOT NULL,
      fecha        DATE        NOT NULL,
      hora_inicio  TIME        NOT NULL,
      duracion_min INT         NOT NULL CHECK (duracion_min > 0),
      notas        TEXT,
      estado       TEXT        NOT NULL DEFAULT 'activa',
      creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas (fecha);
  `);
}

/* ---------- app ---------- */

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Configuración pública para la web de reservas
app.get('/api/config', (_req, res) => {
  res.json({
    apertura: APERTURA,
    cierre: CIERRE,
    paso: PASO,
    duraciones: DURACIONES,
    ahora: ahoraNegocio(),
  });
});

// Horarios ocupados de un día (sin datos personales)
app.get('/api/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  try {
    const { rows } = await pool.query(
      `SELECT (EXTRACT(EPOCH FROM hora_inicio) / 60)::int AS inicio, duracion_min
         FROM reservas
        WHERE fecha = $1 AND estado = 'activa'
        ORDER BY hora_inicio`,
      [fecha]
    );
    res.json({
      ocupados: rows.map((r) => ({ inicio: r.inicio, fin: r.inicio + r.duracion_min })),
      ahora: ahoraNegocio(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

// Crear una reserva
app.post('/api/reservas', async (req, res) => {
  const { nombre, telefono, fecha, hora, duracion, notas } = req.body || {};
  const n = String(nombre || '').trim();
  const tel = String(telefono || '').trim();
  const nt = String(notas || '').trim().slice(0, 300);
  const dur = Number(duracion);

  if (n.length < 2 || n.length > 80) return res.status(400).json({ error: 'Escribe tu nombre.' });
  if (!/^[0-9+()\-\s]{7,20}$/.test(tel)) return res.status(400).json({ error: 'Escribe un teléfono válido.' });
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  if (typeof hora !== 'string' || !/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ error: 'Hora inválida.' });
  if (!DURACIONES.includes(dur)) return res.status(400).json({ error: 'Duración inválida.' });

  const ini = aMinutos(hora);
  const fin = ini + dur;
  if (ini % PASO !== 0 || ini < APERTURA * 60 || fin > CIERRE * 60) {
    return res.status(400).json({ error: `Fuera del horario de clases (${APERTURA}:00 a ${CIERRE}:00).` });
  }

  const ahora = ahoraNegocio();
  if (fecha < ahora.fecha || (fecha === ahora.fecha && ini <= ahora.minutos)) {
    return res.status(400).json({ error: 'Esa hora ya pasó. Elige otra.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Evita que dos personas reserven el mismo horario al mismo tiempo
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fecha]);

    const choque = await client.query(
      `SELECT 1 FROM reservas
        WHERE fecha = $1 AND estado = 'activa'
          AND (EXTRACT(EPOCH FROM hora_inicio) / 60)::int < $3::int
          AND (EXTRACT(EPOCH FROM hora_inicio) / 60)::int + duracion_min > $2::int
        LIMIT 1`,
      [fecha, ini, fin]
    );
    if (choque.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ese horario ya fue reservado. Elige otro.' });
    }

    const ins = await client.query(
      `INSERT INTO reservas (nombre, telefono, fecha, hora_inicio, duracion_min, notas)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [n, tel, fecha, hora, dur, nt || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ id: ins.rows[0].id, fecha, hora, duracion: dur, fin: aHHMM(fin) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Error del servidor.' });
  } finally {
    client.release();
  }
});

// ----- Zona del profesor (protegida con PIN) -----

app.get('/api/profesor/clases', exigirPin, async (req, res) => {
  const fecha = req.query.fecha || ahoraNegocio().fecha;
  if (!fechaValida(fecha)) return res.status(400).json({ error: 'Fecha inválida.' });
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, telefono, to_char(hora_inicio, 'HH24:MI') AS hora,
              duracion_min, notas
         FROM reservas
        WHERE fecha = $1 AND estado = 'activa'
        ORDER BY hora_inicio`,
      [fecha]
    );
    const clases = rows.map((r) => ({
      id: r.id,
      nombre: r.nombre,
      telefono: r.telefono,
      hora: r.hora,
      fin: aHHMM(aMinutos(r.hora) + r.duracion_min),
      duracion: r.duracion_min,
      notas: r.notas,
    }));
    res.json({ fecha, clases });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

app.patch('/api/profesor/clases/:id/cancelar', exigirPin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido.' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE reservas SET estado = 'cancelada' WHERE id = $1 AND estado = 'activa'`,
      [id]
    );
    if (!rowCount) return res.status(404).json({ error: 'La clase no existe o ya estaba cancelada.' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

iniciarBD()
  .then(() => app.listen(PORT, () => console.log(`Servidor listo en el puerto ${PORT}`)))
  .catch((e) => {
    console.error('No se pudo conectar a la base de datos:', e.message);
    process.exit(1);
  });
