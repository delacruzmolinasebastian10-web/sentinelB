/**
 * SentinelB — Servidor Backend (MySQL)
 * Recibe datos del ESP32 por HTTP POST
 * Sirve la API REST para la app web
 * Base de datos: MySQL (phpMyAdmin)
 *
 * Instalar dependencias:
 *   npm install express cors mysql2
 *
 * Ejecutar:
 *   node sentinelb-server.js
 *
 * El ESP32 debe hacer POST a: http://<IP_PC>:4000/api/datos
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const mysql   = require("mysql2/promise");

const app  = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── CONFIGURACIÓN MySQL ────────────────────────────────────────────────────
const DB_CONFIG = {
  host:             "localhost",
  port:             3306,
  user:             "root",
  password:         "",
  database:         "sentinelb.bd",
  waitForConnections: true,
  connectionLimit:  10,
  timezone:         "local"
};

let pool;

async function initDB() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    const conn = await pool.getConnection();
    console.log("✅ Conectado a MySQL correctamente");
    conn.release();
  } catch(e) {
    console.error("❌ Error conectando a MySQL:", e.message);
    process.exit(1);
  }
}

// ─── LÓGICA DE ALERTAS ──────────────────────────────────────────────────────
async function clasificarAlerta(rfid, sal, tempCorp) {
  const [rows] = await pool.query(`
    SELECT AVG(sal) as avg_sal
    FROM lecturas
    WHERE rfid = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
  `, [rfid]);

  const avgSal = rows[0]?.avg_sal || sal;

  if (sal < avgSal * 0.6 && tempCorp > 39.5) {
    return {
      tipo: "ROJA",
      mensaje: `⚠️ RIESGO SANITARIO — Animal ${rfid}: Sal caída ${Math.round((1 - sal/avgSal)*100)}% bajo lo normal + TC ${tempCorp}°C (fiebre). Posible anorexia o infección sistémica.`
    };
  }

  if (tempCorp > 40.0) {
    return {
      tipo: "ROJA",
      mensaje: `🌡️ FIEBRE SEVERA — Animal ${rfid}: TC ${tempCorp}°C. Requiere evaluación veterinaria inmediata.`
    };
  }

  if (sal < avgSal * 0.7) {
    return {
      tipo: "AMARILLA",
      mensaje: `🟡 BAJO CONSUMO DE SAL — Animal ${rfid}: Sal ${Math.round(sal)}g (${Math.round((1 - sal/avgSal)*100)}% bajo lo normal). Verificar comedero.`
    };
  }

  return { tipo: "NORMAL", mensaje: "" };
}

// ─── ENDPOINT PARA ESP32 ────────────────────────────────────────────────────
app.post("/api/datos", async (req, res) => {
  const { rfid, sal, temp_corp, temp_amb } = req.body;

  if (!rfid || sal === undefined || temp_corp === undefined || temp_amb === undefined) {
    return res.status(400).json({ ok: false, error: "Faltan campos" });
  }

  try {
    await pool.query("INSERT IGNORE INTO animales (rfid) VALUES (?)", [rfid]);

    const alerta = await clasificarAlerta(rfid, sal, temp_corp);

    await pool.query(
      "INSERT INTO lecturas (rfid, sal, temp_corp, temp_amb, alerta) VALUES (?, ?, ?, ?, ?)",
      [rfid, sal, temp_corp, temp_amb, alerta.tipo]
    );

    if (alerta.tipo !== "NORMAL") {
      await pool.query(
        "INSERT INTO alertas (rfid, tipo, mensaje) VALUES (?, ?, ?)",
        [rfid, alerta.tipo, alerta.mensaje]
      );
    }

    console.log(`[${new Date().toLocaleString()}] ESP32 → RFID:${rfid} Sal:${sal}g TC:${temp_corp}°C TA:${temp_amb}°C → ${alerta.tipo}`);
    res.json({ ok: true, alerta: alerta.tipo });

  } catch(e) {
    console.error("Error /api/datos:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API LOGIN ────────────────────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const [rows] = await pool.query(
      "SELECT * FROM usuarios WHERE usuario = ? AND password = ?",
      [usuario, password]
    );
    if (rows.length > 0) res.json({ ok: true, usuario: rows[0].usuario });
    else res.status(401).json({ ok: false, error: "Credenciales incorrectas" });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API DASHBOARD ────────────────────────────────────────────────────────────
app.get("/api/dashboard", async (req, res) => {
  try {
    const [[{ totalAnimales }]]   = await pool.query("SELECT COUNT(*) as totalAnimales FROM animales");
    const [[{ lecturasHoy }]]     = await pool.query("SELECT COUNT(*) as lecturasHoy FROM lecturas WHERE DATE(timestamp) = CURDATE()");
    const [[{ alertasNoLeidas }]] = await pool.query("SELECT COUNT(*) as alertasNoLeidas FROM alertas WHERE leida = 0");
    const [[{ alertasRojas }]]    = await pool.query("SELECT COUNT(*) as alertasRojas FROM alertas WHERE tipo = 'ROJA' AND leida = 0");

    const [ultimas] = await pool.query(`
      SELECT l.*, a.nombre FROM lecturas l
      LEFT JOIN animales a ON l.rfid = a.rfid
      ORDER BY l.timestamp DESC LIMIT 20
    `);

    const [promediosDia] = await pool.query(`
      SELECT rfid, AVG(sal) as avg_sal,
             AVG(temp_corp) as avg_tc, AVG(temp_amb) as avg_ta,
             MAX(timestamp) as ultima
      FROM lecturas
      WHERE DATE(timestamp) = CURDATE()
      GROUP BY rfid
    `);

    res.json({ totalAnimales, lecturasHoy, alertasNoLeidas, alertasRojas, ultimas, promediosDia });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API ALERTAS ──────────────────────────────────────────────────────────────
app.get("/api/alertas", async (req, res) => {
  try {
    const [alertas] = await pool.query(`
      SELECT al.*, an.nombre FROM alertas al
      LEFT JOIN animales an ON al.rfid = an.rfid
      ORDER BY al.timestamp DESC LIMIT 100
    `);
    res.json(alertas);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/api/alertas/:id/leer", async (req, res) => {
  try {
    await pool.query("UPDATE alertas SET leida = 1 WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/api/alertas/leer-todas", async (req, res) => {
  try {
    await pool.query("UPDATE alertas SET leida = 1");
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API ANIMALES ─────────────────────────────────────────────────────────────
app.get("/api/animales", async (req, res) => {
  try {
    const [animales] = await pool.query(`
      SELECT a.rfid, a.nombre, a.raza, a.descripcion,
             COUNT(l.id)      as total_lecturas,
             MAX(l.timestamp) as ultima_lectura,
             AVG(l.temp_corp) as avg_tc
      FROM animales a
      LEFT JOIN lecturas l ON a.rfid = l.rfid
      GROUP BY a.rfid, a.nombre, a.raza, a.descripcion
      ORDER BY ultima_lectura DESC
    `);
    res.json(animales);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/animales", async (req, res) => {
  const { rfid, nombre, raza, descripcion } = req.body;
  if (!rfid || !rfid.trim()) {
    return res.status(400).json({ ok: false, error: "El RFID es obligatorio" });
  }
  const rfidLimpio = rfid.trim().toUpperCase();
  try {
    const [existe] = await pool.query("SELECT rfid FROM animales WHERE rfid = ?", [rfidLimpio]);
    if (existe.length > 0) {
      return res.status(409).json({ ok: false, error: "Ya existe un animal con ese RFID" });
    }
    await pool.query(
      "INSERT INTO animales (rfid, nombre, raza, descripcion) VALUES (?, ?, ?, ?)",
      [rfidLimpio, nombre?.trim() || '', raza?.trim() || '', descripcion?.trim() || '']
    );
    console.log(`[${new Date().toLocaleString()}] ➕ Animal registrado: RFID=${rfidLimpio} Nombre=${nombre||'-'} Raza=${raza||'-'}`);
    res.json({ ok: true, rfid: rfidLimpio });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put("/api/animales/:rfid", async (req, res) => {
  const { nombre, raza, descripcion } = req.body;
  try {
    await pool.query(
      "UPDATE animales SET nombre = ?, raza = ?, descripcion = ? WHERE rfid = ?",
      [nombre?.trim() || '', raza?.trim() || '', descripcion?.trim() || '', req.params.rfid]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/animales/:rfid/historial", async (req, res) => {
  const { rfid } = req.params;
  const { dias = 7 } = req.query;
  try {
    const [historial] = await pool.query(`
      SELECT * FROM lecturas
      WHERE rfid = ? AND timestamp >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY timestamp ASC
    `, [rfid, parseInt(dias)]);
    const [[animal]] = await pool.query("SELECT * FROM animales WHERE rfid = ?", [rfid]);
    res.json({ animal, historial });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API REPORTE CSV ──────────────────────────────────────────────────────────
app.get("/api/reporte", async (req, res) => {
  const { desde, hasta, rfid } = req.query;
  let query = "SELECT l.*, a.nombre FROM lecturas l LEFT JOIN animales a ON l.rfid = a.rfid WHERE 1=1";
  const params = [];
  if (desde) { query += " AND DATE(l.timestamp) >= ?"; params.push(desde); }
  if (hasta) { query += " AND DATE(l.timestamp) <= ?"; params.push(hasta); }
  if (rfid)  { query += " AND l.rfid = ?"; params.push(rfid); }
  query += " ORDER BY l.timestamp DESC";

  try {
    const [rows] = await pool.query(query, params);
    const csv = [
      "ID,RFID,Nombre,Sal(g),Temp_Corp(°C),Temp_Amb(°C),Alerta,Timestamp",
      ...rows.map(r => `${r.id},"${r.rfid}","${r.nombre||''}",${r.sal},${r.temp_corp},${r.temp_amb},${r.alerta},"${r.timestamp}"`)
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="sentinelb_reporte_${Date.now()}.csv"`);
    res.send(csv);
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🐄 SentinelB Server (MySQL) corriendo en http://0.0.0.0:${PORT}`);
    console.log(`📱 App web:  http://localhost:${PORT}/login.html`);
    console.log(`📡 ESP32 debe hacer POST a: http://<TU_IP>:${PORT}/api/datos`);
    console.log(`\nFormato JSON del ESP32:`);
    console.log(`{ "rfid":"A042", "sal":142.5, "temp_corp":38.4, "temp_amb":24.1 }\n`);
  });
});