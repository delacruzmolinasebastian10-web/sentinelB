const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ Falta JWT_SECRET en las variables de entorno.");
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      cliente_id: user.cliente_id,
      usuario: user.usuario,
      rol: user.rol
    },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map(x => x.trim());
  const item = parts.find(x => x.startsWith(name + "="));

  return item
    ? decodeURIComponent(item.slice(name.length + 1))
    : null;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";

  const bearer = header.startsWith("Bearer ")
    ? header.slice(7)
    : null;

  const token = bearer || getCookie(req, "sb_token");

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Token requerido"
    });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Token inválido o expirado"
    });
  }
}

function role(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.rol)) {
      return res.status(403).json({
        ok: false,
        error: "No tienes permisos para esta operación"
      });
    }

    next();
  };
}

async function clienteActivo(clienteId) {
  const r = await pool.query(
    "SELECT id FROM clientes WHERE id=$1 AND activo=TRUE",
    [clienteId]
  );

  return r.rows.length > 0;
}

async function getAnimal(clienteId, rfid) {
  const r = await pool.query(
    "SELECT * FROM animales WHERE cliente_id=$1 AND rfid=$2",
    [clienteId, rfid]
  );

  return r.rows[0] || null;
}

async function clasificarAlerta(clienteId, rfid, sal, tempCorp) {
  const result = await pool.query(
    `SELECT AVG(sal) AS avg_sal
     FROM lecturas
     WHERE cliente_id=$1
       AND rfid=$2
       AND timestamp >= NOW() - INTERVAL '7 days'`,
    [clienteId, rfid]
  );

  const avgSal =
    Number(result.rows[0]?.avg_sal) || Number(sal);

  if (sal < avgSal * 0.6 && tempCorp > 39.5) {
    return {
      tipo: "ROJA",
      mensaje:
        `⚠️ RIESGO SANITARIO — Animal ${rfid}: ` +
        `Sal caída ${Math.round((1 - sal / avgSal) * 100)}% ` +
        `bajo lo normal + TC ${tempCorp}°C. ` +
        `Requiere evaluación veterinaria.`
    };
  }

  if (tempCorp > 40) {
    return {
      tipo: "ROJA",
      mensaje:
        `🌡️ FIEBRE SEVERA — Animal ${rfid}: ` +
        `TC ${tempCorp}°C. Requiere evaluación veterinaria.`
    };
  }

  if (sal < avgSal * 0.7) {
    return {
      tipo: "AMARILLA",
      mensaje:
        `🟡 BAJO CONSUMO DE SAL — Animal ${rfid}: ` +
        `Sal ${Math.round(sal)}g ` +
        `(${Math.round((1 - sal / avgSal) * 100)}% bajo lo normal). ` +
        `Verificar comedero.`
    };
  }

  return {
    tipo: "NORMAL",
    mensaje: ""
  };
}

async function verificarVacunasProximas() {
  try {
    const proximas = await pool.query(`
      SELECT v.*, a.nombre
      FROM vacunas v
      LEFT JOIN animales a
        ON v.cliente_id=a.cliente_id
       AND v.rfid=a.rfid
      WHERE v.proxima_dosis IS NOT NULL
        AND v.alerta_generada=FALSE
        AND v.proxima_dosis <= CURRENT_DATE + INTERVAL '7 days'
    `);

    for (const v of proximas.rows) {
      const vencida =
        new Date(v.proxima_dosis) < new Date();

      const tipo = vencida
        ? "ROJA"
        : "AMARILLA";

      const fecha =
        new Date(v.proxima_dosis)
          .toLocaleDateString("es-MX");

      const mensaje = vencida
        ? `💉 REFUERZO VENCIDO — ${
            v.nombre || v.rfid
          }: ${v.nombre_vacuna} venció el ${fecha}.`
        : `💉 PRÓXIMO REFUERZO — ${
            v.nombre || v.rfid
          }: ${v.nombre_vacuna} programado para el ${fecha}.`;

      await pool.query(
        `INSERT INTO alertas
         (cliente_id, rfid, tipo, mensaje)
         VALUES ($1,$2,$3,$4)`,
        [
          v.cliente_id,
          v.rfid,
          tipo,
          mensaje
        ]
      );

      await pool.query(
        `UPDATE vacunas
         SET alerta_generada=TRUE
         WHERE cliente_id=$1
           AND id=$2`,
        [
          v.cliente_id,
          v.id
        ]
      );
    }
  } catch (e) {
    console.error(
      "❌ Error verificarVacunasProximas:",
      e.message
    );
  }
}


/* =========================================================
   HEALTH
========================================================= */

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      servicio: "SentinelB",
      database: "PostgreSQL"
    });
  } catch {
    res.status(500).json({
      ok: false,
      error: "Base de datos no disponible"
    });
  }
});


/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({
      ok: false,
      error: "Usuario y contraseña son obligatorios"
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.usuario,
        u.password_hash,
        u.rol,
        u.cliente_id,
        c.nombre AS cliente_nombre
      FROM usuarios u
      JOIN clientes c
        ON c.id=u.cliente_id
      WHERE u.usuario=$1
        AND u.activo=TRUE
        AND c.activo=TRUE
    `, [usuario.trim()]);
