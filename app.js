const BASE = "";
let currentUser = null;
let charts = {};
let refreshTimer = null;
let currentRfidEdit = null;
let modoModal = 'editar'; // 'nuevo' | 'editar'

// ── PROTECCIÓN DE SESIÓN ───────────────────────────────────────────────────
(function checkSession(){
  const user = sessionStorage.getItem('sb_user');
  if(!user){
    window.location.href = 'login.html';
    return;
  }
  currentUser = user;
  document.getElementById('sbUser').textContent = currentUser;
  document.getElementById('sbAvatar').textContent = currentUser[0].toUpperCase();
})();

// ── CERRAR SESIÓN ──────────────────────────────────────────────────────────
function doLogout(){
  clearInterval(refreshTimer);
  sessionStorage.removeItem('sb_user');
  window.location.href = 'login.html';
}

// ── RELOJ ──────────────────────────────────────────────────────────────────
function updateClock(){
  const now = new Date();
  document.getElementById('topTime').textContent =
    now.toLocaleDateString('es-MX',{weekday:'short',day:'2-digit',month:'short'}) + ' · ' +
    now.toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
setInterval(updateClock,1000); updateClock();

// ── NAVEGACIÓN ─────────────────────────────────────────────────────────────
const secTitles = {
  dashboard:'Dashboard',alertas:'Alertas',animales:'Animales',vacunas:'Monitoreo de vacunas',
  historial:'Historial por animal',reporte:'Reportes'
};
function goTo(sec, el){
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));
  if(el) el.classList.add('active');
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById(`sec-${sec}`).classList.add('active');
  document.getElementById('topTitle').textContent = secTitles[sec]||sec;
  if(sec==='dashboard') loadDashboard();
  if(sec==='alertas')   loadAlertas();
  if(sec==='animales')  loadAnimales();
  if(sec==='vacunas')   loadVacunas();
  if(sec==='historial') loadSelectAnimales();
  if(sec==='reporte')   loadReporte();
}

// ── INICIO ─────────────────────────────────────────────────────────────────
function startApp(){
  loadDashboard();
  refreshTimer = setInterval(()=>{
    const active = document.querySelector('.section.active');
    if(active?.id==='sec-dashboard') loadDashboard();
    if(active?.id==='sec-alertas')   loadAlertas();
  }, 10000);
}

// ── DASHBOARD ──────────────────────────────────────────────────────────────
async function loadDashboard(){
  try {
    const d = await fetch(`${BASE}/api/dashboard`).then(r=>r.json());

    document.getElementById('d-animales').textContent = d.totalAnimales;
    document.getElementById('d-lecturas').textContent  = d.lecturasHoy;
    document.getElementById('d-alertas').textContent   = d.alertasNoLeidas;
    document.getElementById('d-rojas').textContent     = d.alertasRojas;

    const badge = document.getElementById('sbBadge');
    if(d.alertasNoLeidas > 0){ badge.textContent=d.alertasNoLeidas; badge.style.display='inline'; }
    else badge.style.display='none';

    const tbody = document.getElementById('tblUltimas');
    if(d.ultimas.length === 0){
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-3);">Sin lecturas. El ESP32 aún no ha enviado datos.</td></tr>`;
    } else {
      tbody.innerHTML = d.ultimas.map(r=>`
        <tr>
          <td><code style="font-size:.78rem;background:var(--surface2);padding:2px 7px;border-radius:5px;">${r.rfid}</code></td>
          <td style="font-weight:600">${r.nombre||'Sin nombre'}</td>
          <td>${(+r.sal).toFixed(1)}</td>
          <td>${(+r.temp_corp).toFixed(1)}</td>
          <td>${(+r.temp_amb).toFixed(1)}</td>
          <td><span class="badge ${r.alerta}">${r.alerta}</span></td>
          <td style="color:var(--ink-3);font-size:.8rem">${fmtTime(r.timestamp)}</td>
        </tr>`).join('');
    }

    renderChartConsumo(d.promediosDia);
    renderChartTemp(d.promediosDia);

  } catch(e){
    console.error('Dashboard error:',e);
  }
}

function renderChartConsumo(data){
  const ctx = document.getElementById('chartConsumo').getContext('2d');
  if(charts.consumo) charts.consumo.destroy();
  charts.consumo = new Chart(ctx,{
    type:'bar',
    data:{
      labels: data.map(d=>d.rfid),
      datasets:[
        { label:'Sal (g)', data:data.map(d=>+(+d.avg_sal).toFixed(1)), backgroundColor:'#4caf7d', borderRadius:5 }
      ]
    },
    options:{ responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{font:{family:'Nunito'},boxRadius:4}}},
      scales:{x:{grid:{display:false}},y:{beginAtZero:true,grid:{color:'#f0f0f0'}}}
    }
  });
}

function renderChartTemp(data){
  const ctx = document.getElementById('chartTemp').getContext('2d');
  if(charts.temp) charts.temp.destroy();
  charts.temp = new Chart(ctx,{
    type:'bar',
    data:{
      labels: data.map(d=>d.rfid),
      datasets:[
        { label:'Temp. Corporal (°C)', data:data.map(d=>+(+d.avg_tc).toFixed(1)),
          backgroundColor: data.map(d=>(+d.avg_tc)>39.5?'#dc2626':'#1b5e3b'), borderRadius:5 },
        { label:'Temp. Ambiental (°C)', data:data.map(d=>+(+d.avg_ta).toFixed(1)),
          backgroundColor:'#93c5fd', borderRadius:5 }
      ]
    },
    options:{ responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{font:{family:'Nunito'},boxRadius:4}}},
      scales:{x:{grid:{display:false}},
        y:{beginAtZero:false,suggestedMin:15,suggestedMax:42,grid:{color:'#f0f0f0'}}}
    }
  });
}

// ── ALERTAS ────────────────────────────────────────────────────────────────
async function loadAlertas(){
  const alertas = await fetch(`${BASE}/api/alertas`).then(r=>r.json());
  const cont = document.getElementById('listaAlertas');
  if(!alertas.length){
    cont.innerHTML=`<div class="empty"><div class="empty-icon">✅</div><div class="empty-msg">No hay alertas registradas</div></div>`;
    return;
  }
  cont.innerHTML = alertas.map(a=>`
    <div class="alert-banner ${a.tipo} ${a.leida?'leida':''}" id="al-${a.id}" style="${a.leida?'opacity:.45':''}">
      <span class="ab-icon">${a.tipo==='ROJA'?'🔴':'🟡'}</span>
      <div class="ab-body">
        <div class="ab-title">${a.tipo==='ROJA'?'ALERTA ROJA — Riesgo Sanitario':'ALERTA AMARILLA — Riesgo Nutricional'}</div>
        <div class="ab-msg">${a.mensaje}</div>
        <div class="ab-time">${fmtTime(a.timestamp)} · Animal: ${a.nombre||a.rfid}</div>
      </div>
      ${!a.leida?`<button class="ab-leer" onclick="leerAlerta(${a.id})">✓ Leída</button>`:''}
    </div>`).join('');
}

async function leerAlerta(id){
  await fetch(`${BASE}/api/alertas/${id}/leer`,{method:'PUT'});
  loadAlertas(); loadDashboard();
}
async function leerTodas(){
  await fetch(`${BASE}/api/alertas/leer-todas`,{method:'PUT'});
  loadAlertas(); loadDashboard();
}

// ── ANIMALES ───────────────────────────────────────────────────────────────
const CATEGORIAS_ANIMAL = [
  {key:'vaca',    label:'Vacas',    icon:'🐄', css:'cat-vaca'},
  {key:'toro',    label:'Toros',    icon:'🐃', css:'cat-toro'},
  {key:'becerro', label:'Becerros', icon:'🐮', css:'cat-becerro'},
  {key:'torete',  label:'Toretes',  icon:'🐂', css:'cat-torete'},
  {key:'novilla', label:'Novillas', icon:'🐄', css:'cat-novilla'}
];

function esc(s){ return (s||'').replace(/'/g,"\\'"); }

function animalCardHTML(a){
  return `
    <div class="animal-card" onclick="abrirEditAnimal('${a.rfid}','${esc(a.nombre)}','${esc(a.raza)}','${a.fecha_nac||''}','${esc(a.descripcion)}','${a.categoria||''}')">
      <div class="ac-rfid">📡 RFID: ${a.rfid}</div>
      <div class="ac-name">${a.nombre||'Sin nombre'}</div>
      ${a.raza?`<div class="ac-raza">${a.raza}</div>`:''}
      <div class="ac-metrics">
        <div class="ac-metric"><div class="ac-metric-lbl">Lecturas</div><div class="ac-metric-val">${a.total_lecturas||0}</div></div>
        <div class="ac-metric"><div class="ac-metric-lbl">TC prom.</div><div class="ac-metric-val">${a.avg_tc?(+a.avg_tc).toFixed(1):'--'}°</div></div>
      </div>
      <div class="ac-footer">
        <span class="ac-time">Última: ${a.ultima_lectura?fmtTime(a.ultima_lectura):'sin lecturas'}</span>
        <span style="font-size:.75rem;color:var(--green-2);font-weight:700;">✏️ Editar</span>
      </div>
    </div>`;
}

function catGroupHTML(css, icon, label, count, cardsHTML){
  return `
    <div class="cat-group ${css}">
      <div class="cat-group-header">
        <div class="cat-group-title">
          <span class="cat-icon-circle">${icon}</span>
          ${label}
        </div>
        <span class="cat-count-pill">${count} animal${count===1?'':'es'}</span>
      </div>
      <div class="animales-grid">${cardsHTML}</div>
    </div>`;
}

async function loadAnimales(){
  const animales = await fetch(`${BASE}/api/animales`).then(r=>r.json());
  const grid = document.getElementById('gridAnimales');
  if(!animales.length){
    grid.innerHTML=`<div class="empty">
      <div class="empty-icon">🐄</div>
      <div class="empty-msg">Ningún animal registrado aún.<br><span style="font-size:.8rem;margin-top:6px;display:block;">Usa el botón "Agregar animal" o espera a que el ESP32 envíe datos.</span></div>
    </div>`;
    return;
  }

  let html = '';

  CATEGORIAS_ANIMAL.forEach(cat=>{
    const delCat = animales.filter(a => (a.categoria||'').toLowerCase() === cat.key);
    if(!delCat.length) return;
    html += catGroupHTML(cat.css, cat.icon, cat.label, delCat.length, delCat.map(animalCardHTML).join(''));
  });

  const sinCategoria = animales.filter(a => !a.categoria);
  if(sinCategoria.length){
    html += catGroupHTML('cat-sin', '❓', 'Sin categoría', sinCategoria.length, sinCategoria.map(animalCardHTML).join(''));
  }

  grid.innerHTML = html;
}

// ── ABRIR MODAL: NUEVO ANIMAL ───────────────────────────────────────────────
function abrirNuevoAnimal(){
  modoModal = 'nuevo';
  currentRfidEdit = null;

  document.getElementById('modalAnimalTitle').textContent = '🐄 Agregar nuevo animal';
  document.getElementById('mRfid').value      = '';
  document.getElementById('mRfid').readOnly   = false;
  document.getElementById('mRfid').classList.remove('error');
  document.getElementById('mNombre').value    = '';
  document.getElementById('mRaza').value      = '';
  document.getElementById('mCategoria').value = '';
  document.getElementById('mFecha').value     = '';
  document.getElementById('mDesc').value      = '';
  document.getElementById('mRfidHint').textContent = '';
  document.getElementById('mRfidHint').className = 'field-hint';
  document.getElementById('modalGuardarBtn').textContent = '➕ Registrar animal';

  document.getElementById('modalAnimal').classList.add('open');
  setTimeout(()=>document.getElementById('mRfid').focus(), 100);
}

// ── ABRIR MODAL: EDITAR ANIMAL ──────────────────────────────────────────────
function abrirEditAnimal(rfid, nombre, raza, fecha, desc, categoria){
  modoModal = 'editar';
  currentRfidEdit = rfid;

  document.getElementById('modalAnimalTitle').textContent = '✏️ Editar Animal';
  document.getElementById('mRfid').value      = rfid;
  document.getElementById('mRfid').readOnly   = true;
  document.getElementById('mRfid').classList.remove('error');
  document.getElementById('mNombre').value    = nombre;
  document.getElementById('mRaza').value      = raza;
  document.getElementById('mCategoria').value = categoria || '';
  document.getElementById('mFecha').value     = fecha;
  document.getElementById('mDesc').value      = desc;
  document.getElementById('mRfidHint').textContent = '';
  document.getElementById('mRfidHint').className = 'field-hint';
  document.getElementById('modalGuardarBtn').textContent = '💾 Guardar';

  document.getElementById('modalAnimal').classList.add('open');
}

function cerrarModal(){ document.getElementById('modalAnimal').classList.remove('open'); }
document.getElementById('modalAnimal').addEventListener('click',e=>{ if(e.target===e.currentTarget) cerrarModal(); });

// ── GUARDAR ANIMAL ────────────────────────────────────────────────────────────
async function guardarAnimal(){
  const rfid      = document.getElementById('mRfid').value.trim().toUpperCase();
  const nombre    = document.getElementById('mNombre').value.trim();
  const raza      = document.getElementById('mRaza').value.trim();
  const categoria = document.getElementById('mCategoria').value;
  const fecha     = document.getElementById('mFecha').value;
  const desc      = document.getElementById('mDesc').value.trim();

  if(!rfid){
    document.getElementById('mRfid').classList.add('error');
    document.getElementById('mRfidHint').textContent = 'El RFID es obligatorio.';
    document.getElementById('mRfidHint').className = 'field-hint error-msg';
    document.getElementById('mRfid').focus();
    return;
  }

  if(!categoria){
    alert('Selecciona la categoría del animal.');
    return;
  }

  const btn = document.getElementById('modalGuardarBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    if(modoModal === 'nuevo'){
      const check = await fetch(`${BASE}/api/animales`).then(r=>r.json());
      const existe = check.some(a => a.rfid.toUpperCase() === rfid);
      if(existe){
        document.getElementById('mRfid').classList.add('error');
        document.getElementById('mRfidHint').textContent = 'Este RFID ya está registrado.';
        document.getElementById('mRfidHint').className = 'field-hint error-msg';
        btn.disabled = false;
        btn.textContent = '➕ Registrar animal';
        return;
      }
      const r = await fetch(`${BASE}/api/animales`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ rfid, nombre, raza, categoria, fecha_nac: fecha, descripcion: desc })
      });
      const d = await r.json();
      if(!d.ok) throw new Error(d.error || 'Error al crear');
    } else {
      await fetch(`${BASE}/api/animales/${currentRfidEdit}`,{
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ nombre, raza, categoria, fecha_nac: fecha, descripcion: desc })
      });
    }

    cerrarModal();
    loadAnimales();

  } catch(e){
    console.error(e);
    alert('Error al guardar: ' + e.message);
    btn.disabled = false;
    btn.textContent = modoModal === 'nuevo' ? '➕ Registrar animal' : '💾 Guardar';
  }
}

// ── VACUNAS ────────────────────────────────────────────────────────────────
let currentVacunaEdit = null;
let modoModalVacuna = 'nuevo';

async function loadVacunas(){
  const vacunas = await fetch(`${BASE}/api/vacunas`).then(r=>r.json());
  const tbody = document.getElementById('tblVacunas');
  if(!vacunas.length){
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-3);">Sin vacunas registradas.</td></tr>`;
    return;
  }
  tbody.innerHTML = vacunas.map(v=>`
    <tr style="cursor:pointer" onclick='abrirEditVacuna(${JSON.stringify(v).replace(/'/g,"&#39;")})'>
      <td style="font-weight:600">${v.nombre||v.rfid}</td>
      <td>${v.categoria}</td>
      <td>${v.nombre_vacuna}</td>
      <td>${v.lote||'—'}</td>
      <td>${fmtTime(v.fecha_aplicacion)}</td>
      <td style="color:${v.proxima_dosis && new Date(v.proxima_dosis)<new Date()?'var(--red)':'inherit'}">${v.proxima_dosis?fmtTime(v.proxima_dosis):'—'}</td>
      <td>${v.responsable||'—'}</td>
    </tr>`).join('');
}

async function abrirNuevaVacuna(){
  modoModalVacuna = 'nuevo';
  currentVacunaEdit = null;
  document.getElementById('modalVacunaTitle').textContent = '💉 Registrar vacuna';

  const animales = await fetch(`${BASE}/api/animales`).then(r=>r.json());
  document.getElementById('vRfid').innerHTML = animales.map(a=>`<option value="${a.rfid}">${a.rfid}${a.nombre?' — '+a.nombre:''}</option>`).join('');

  document.getElementById('vCategoria').value = 'vaca';
  document.getElementById('vNombreVacuna').selectedIndex = 0;
  document.getElementById('vLote').value = '';
  document.getElementById('vFechaAplicacion').value = new Date().toISOString().split('T')[0];
  document.getElementById('vProximaDosis').value = '';
  document.getElementById('vResponsable').value = '';
  document.getElementById('vObservaciones').value = '';
  document.getElementById('modalVacunaGuardarBtn').textContent = '➕ Registrar';

  document.getElementById('modalVacuna').classList.add('open');
}

function abrirEditVacuna(v){
  modoModalVacuna = 'editar';
  currentVacunaEdit = v.id;
  document.getElementById('modalVacunaTitle').textContent = '✏️ Editar vacuna';

  document.getElementById('vRfid').innerHTML = `<option value="${v.rfid}">${v.rfid}${v.nombre?' — '+v.nombre:''}</option>`;
  document.getElementById('vCategoria').value = v.categoria;
  document.getElementById('vNombreVacuna').value = v.nombre_vacuna;
  document.getElementById('vLote').value = v.lote||'';
  document.getElementById('vFechaAplicacion').value = v.fecha_aplicacion?.split('T')[0]||'';
  document.getElementById('vProximaDosis').value = v.proxima_dosis?.split('T')[0]||'';
  document.getElementById('vResponsable').value = v.responsable||'';
  document.getElementById('vObservaciones').value = v.observaciones||'';
  document.getElementById('modalVacunaGuardarBtn').textContent = '💾 Guardar';

  document.getElementById('modalVacuna').classList.add('open');
}

function cerrarModalVacuna(){ document.getElementById('modalVacuna').classList.remove('open'); }
document.getElementById('modalVacuna').addEventListener('click', e=>{ if(e.target===e.currentTarget) cerrarModalVacuna(); });

async function guardarVacuna(){
  const body = {
    rfid: document.getElementById('vRfid').value,
    categoria: document.getElementById('vCategoria').value,
    nombre_vacuna: document.getElementById('vNombreVacuna').value,
    lote: document.getElementById('vLote').value.trim(),
    fecha_aplicacion: document.getElementById('vFechaAplicacion').value,
    proxima_dosis: document.getElementById('vProximaDosis').value,
    responsable: document.getElementById('vResponsable').value.trim(),
    observaciones: document.getElementById('vObservaciones').value.trim()
  };

  if(!body.rfid || !body.fecha_aplicacion){
    alert('Selecciona el animal y la fecha de aplicación.');
    return;
  }

  const btn = document.getElementById('modalVacunaGuardarBtn');
  btn.disabled = true;

  try {
    if(modoModalVacuna === 'nuevo'){
      await fetch(`${BASE}/api/vacunas`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
    } else {
      await fetch(`${BASE}/api/vacunas/${currentVacunaEdit}`, {
        method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
    }
    cerrarModalVacuna();
    loadVacunas();
  } catch(e){
    alert('Error al guardar: '+e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── HISTORIAL ──────────────────────────────────────────────────────────────
async function loadSelectAnimales(){
  const animales = await fetch(`${BASE}/api/animales`).then(r=>r.json());
  const sel  = document.getElementById('selectRfid');
  const rSel = document.getElementById('rRfid');
  const opts = animales.map(a=>`<option value="${a.rfid}">${a.rfid}${a.nombre?' — '+a.nombre:''}</option>`).join('');
  sel.innerHTML  = '<option value="">Seleccionar animal...</option>' + opts;
  if(rSel) rSel.innerHTML = '<option value="">Todos los animales</option>' + opts;
}

async function cargarHistorial(){
  const rfid = document.getElementById('selectRfid').value;
  const dias  = document.getElementById('selectDias').value;
  const cont  = document.getElementById('historialContent');
  if(!rfid){ cont.innerHTML=`<div class="empty"><div class="empty-icon">📈</div><div class="empty-msg">Selecciona un animal</div></div>`; return; }

  const d = await fetch(`${BASE}/api/animales/${rfid}/historial?dias=${dias}`).then(r=>r.json());

  if(!d.historial.length){
    cont.innerHTML=`<div class="empty"><div class="empty-icon">📭</div><div class="empty-msg">Sin datos para este período</div></div>`;
    return;
  }

  cont.innerHTML = `
    <div class="grid-2" style="margin-bottom:16px;">
      <div class="card">
        <div class="card-title">🧂 Consumo de sal (${rfid})</div>
        <div class="chart-wrap"><canvas id="chartHSal"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">🌡️ Temperatura corporal (${rfid})</div>
        <div class="chart-wrap"><canvas id="chartHTc"></canvas></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">📋 Registros detallados</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Fecha/Hora</th><th>Sal (g)</th><th>TC (°C)</th><th>TA (°C)</th><th>Estado</th></tr></thead>
          <tbody>${d.historial.slice().reverse().map(r=>`
            <tr>
              <td style="font-size:.8rem;color:var(--ink-3)">${fmtTime(r.timestamp)}</td>
              <td>${(+r.sal).toFixed(1)}</td>
              <td style="color:${(+r.temp_corp)>39.5?'var(--red)':'inherit'};font-weight:${(+r.temp_corp)>39.5?700:400}">
                ${(+r.temp_corp).toFixed(1)}</td>
              <td>${(+r.temp_amb).toFixed(1)}</td>
              <td><span class="badge ${r.alerta}">${r.alerta}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;

  const labels = d.historial.map(r=>fmtTimeShort(r.timestamp));

  new Chart(document.getElementById('chartHSal').getContext('2d'),{
    type:'line',
    data:{ labels,
      datasets:[
        { label:'Sal (g)', data:d.historial.map(r=>(+r.sal).toFixed(1)),
          borderColor:'#2d8653',backgroundColor:'rgba(45,134,83,.1)',fill:true,tension:.3,pointRadius:2 }
      ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{font:{family:'Nunito'},boxRadius:4}}},
      scales:{x:{grid:{display:false},ticks:{maxRotation:45,font:{size:10}}},y:{beginAtZero:true}}
    }
  });

  new Chart(document.getElementById('chartHTc').getContext('2d'),{
    type:'line',
    data:{ labels,
      datasets:[
        { label:'TC °C', data:d.historial.map(r=>(+r.temp_corp).toFixed(1)),
          borderColor:'#1b5e3b',backgroundColor:'rgba(27,94,59,.08)',fill:true,tension:.3,pointRadius:2 },
        { label:'TA °C', data:d.historial.map(r=>(+r.temp_amb).toFixed(1)),
          borderColor:'#93c5fd',backgroundColor:'rgba(147,197,253,.1)',fill:true,tension:.3,pointRadius:2 },
        { label:'Límite fiebre', data:d.historial.map(()=>39.5),
          borderColor:'#dc2626',borderDash:[5,5],pointRadius:0,borderWidth:1.5,fill:false }
      ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{font:{family:'Nunito'},boxRadius:4}}},
      scales:{x:{grid:{display:false},ticks:{maxRotation:45,font:{size:10}}},
        y:{suggestedMin:15,suggestedMax:42}}
    }
  });
}

// ── REPORTE ────────────────────────────────────────────────────────────────
async function loadReporte(){
  await loadSelectAnimales();
  const hoy   = new Date().toISOString().split('T')[0];
  const hace7 = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  document.getElementById('rDesde').value = hace7;
  document.getElementById('rHasta').value = hoy;

  const d = await fetch(`${BASE}/api/dashboard`).then(r=>r.json());
  const res = document.getElementById('resumenEstadistico');
  if(!d.promediosDia.length){
    res.innerHTML=`<div class="empty"><div class="empty-icon">📊</div><div class="empty-msg">Sin datos hoy todavía</div></div>`;
    return;
  }
  res.innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>RFID</th><th>Prom. Sal</th><th>Prom. TC</th><th>Prom. TA</th><th>Última lectura</th></tr></thead>
        <tbody>${d.promediosDia.map(r=>`
          <tr>
            <td><code style="font-size:.78rem;background:var(--surface2);padding:2px 7px;border-radius:5px;">${r.rfid}</code></td>
            <td>${(+r.avg_sal).toFixed(1)} g</td>
            <td style="color:${(+r.avg_tc)>39.5?'var(--red)':'inherit'};font-weight:${(+r.avg_tc)>39.5?700:400}">
              ${(+r.avg_tc).toFixed(1)} °C</td>
            <td>${(+r.avg_ta).toFixed(1)} °C</td>
            <td style="font-size:.8rem;color:var(--ink-3)">${fmtTime(r.ultima)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function exportarCSV(){
  const desde = document.getElementById('rDesde').value;
  const hasta  = document.getElementById('rHasta').value;
  const rfid   = document.getElementById('rRfid').value;
  let url = `${BASE}/api/reporte?`;
  if(desde) url+=`desde=${desde}&`;
  if(hasta)  url+=`hasta=${hasta}&`;
  if(rfid)   url+=`rfid=${rfid}&`;
  window.open(url,'_blank');
}

// ── UTILS ──────────────────────────────────────────────────────────────────
function fmtTime(ts){
  if(!ts) return '—';
  return new Date(ts).toLocaleString('es-MX',{
    day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
}
function fmtTimeShort(ts){
  if(!ts) return '';
  const d = new Date(ts);
  return `${d.getDate()}/${d.getMonth()+1} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

startApp();
