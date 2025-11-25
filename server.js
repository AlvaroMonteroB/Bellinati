require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
// 1. IMPORTAR SQLITE
const sqlite3 = require('sqlite3').verbose(); 

const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// --- CONFIGURACIÓN DE BASE DE DATOS CACHÉ ---
const db = new sqlite3.Database('./cache_negociacion.db');

// Inicializar tabla
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS user_cache (
            phone TEXT PRIMARY KEY,
            cpf TEXT,
            credores_json TEXT,
            dividas_json TEXT,
            simulacion_json TEXT,
            last_updated DATETIME
        )
    `);
});

// Helper para guardar en BD
function saveToCache(phone, cpf, credores, dividas, simulacion) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO user_cache (phone, cpf, credores_json, dividas_json, simulacion_json, last_updated)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        stmt.run(phone, cpf, JSON.stringify(credores), JSON.stringify(dividas), JSON.stringify(simulacion), (err) => {
            if (err) reject(err);
            else resolve();
        });
        stmt.finalize();
    });
}

// Helper para leer de BD
function getFromCache(phone) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM user_cache WHERE phone = ?", [phone], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// --- CONFIGURACIÓN AXIOS (IGUAL QUE ANTES) ---
dns.setDefaultResultOrder('ipv4first');
const apiAuth = axios.create({
    baseURL: 'https://bpdigital-api.bellinatiperez.com.br',
    timeout: 30000,
    family: 4,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: true })
});

const apiNegocie = axios.create({
    baseURL: 'https://api-negocie.bellinati.com.br',
    timeout: 30000,
    family: 4,
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: true })
});

// ... (Tus interceptors de Axios se mantienen igual para el proceso de Sync) ...
apiNegocie.interceptors.response.use(response => response, error => Promise.reject(error));

// --- DATOS DE USUARIOS (TU BASE MAESTRA) ---
const simulacionDB = {
    "42154393888": { "cpf_cnpj": "42154393888", "nombre": "Alvaro Montero" },
    "98765432100": { "cpf_cnpj": "98765432100", "nombre": "Usuario de Prueba 2" },
    "02604738554": { "cpf_cnpj": "02604738554", "nombre": "Alvaro Montero" },
    "06212643342": { "cpf_cnpj": "06212643342", "nombre": "Usuario Test 062" },
    "52116745888": { "cpf_cnpj": "52116745888", "nombre": "Usuario Test 521" },
    "12144201684": { "cpf_cnpj": "12144201684", "nombre": "Usuario Test 121" },
    "46483299885": { "cpf_cnpj": "46483299885", "nombre": "Usuario Test 464" },
    "26776559856": { "cpf_cnpj": "26776559856", "nombre": "Usuario Test 267" },
    "04513675020": { "cpf_cnpj": "04513675020", "nombre": "Usuario Test 045" },
    "02637364238": { "cpf_cnpj": "02637364238", "nombre": "Usuario Test 0263" },
    "06430897052": { "cpf_cnpj": "06430897052", "nombre": "Usuario Test 064" },
    "10173421997": { "cpf_cnpj": "10173421997", "nombre": "Usuario Test 101" },
    "04065282330": { "cpf_cnpj": "04065282330", "nombre": "Usuario Test 040" },
    "09241820918": { "cpf_cnpj": "09241820918", "nombre": "Usuario Test 092" },
    "63618955308": { "cpf_cnpj": "63618955308", "nombre": "Usuario Test 636" },
    "+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },
    
};

// --- LOGICA DE CONEXIÓN REAL (SOLO SE USA PARA SYNC Y EMISIÓN) ---
async function getAuthToken(cpf_cnpj) {
    const response = await apiAuth.post('/api/Login/v5/Authentication', {
        AppId: process.env.API_APP_ID,
        AppPass: process.env.API_APP_PASS,
        Usuario: cpf_cnpj
    });
    return response.data.token || response.data.access_token;
}

// Esta función hace TODO el trabajo pesado y lento
async function procesarYGuardarUsuario(phone, userData) {
    try {
        console.log(`🔄 Procesando ${phone} (${userData.cpf_cnpj})...`);
        const token = await getAuthToken(userData.cpf_cnpj);

        // 1. Busca Credores
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const credoresData = resCredores.data;
        
        if (!credoresData.credores?.length) return console.log(`⚠️ ${phone} sin acreedores.`);

        const credor = credoresData.credores[0];
        const carteiraInfo = credor.carteiraCrms?.[0];
        const carteiraId = carteiraInfo?.carteiraId || carteiraInfo?.id;

        // 2. Busca Deuda Detallada
        const bodyDivida = { financeira: credor.financeira, crms: credor.crms };
        const resDividas = await apiNegocie.post('/api/v5/busca-divida', bodyDivida, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const dividasData = resDividas.data;

        // 3. Simula Opciones (Pre-calcula una oferta estándar)
        // Extraemos contratos para simulación
        let contratosDocs = [];
        dividasData.forEach(d => d.contratos?.forEach(c => contratosDocs.push(String(c.numero))));

        const bodySimulacion = {
            Crm: credor.crms[0],
            Carteira: carteiraId,
            Contratos: contratosDocs,
            DataVencimento: null, // Dejar que la API decida vencimiento por defecto
            ValorEntrada: 0,
            QuantidadeParcela: 0,
            ValorParcela: 0
        };

        const resSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const simulacionData = resSimulacion.data;

        // 4. GUARDAR EN CACHÉ (SQLITE)
        await saveToCache(phone, userData.cpf_cnpj, credoresData, dividasData, simulacionData);
        console.log(`✅ ${phone} guardado exitosamente.`);
        return true;

    } catch (error) {
        console.error(`❌ Error sincronizando ${phone}:`, error.message);
        return false;
    }
}

// ==========================================
// 🚀 ENDPOINT ESPECIAL: SYNC DATABASE
// ==========================================
// Llama a esto una vez al día o cuando quieras actualizar los datos
app.post('/api/admin/sync-database', async (req, res) => {
    // Respuesta inmediata para no bloquear
    res.json({ status: "Iniciando sincronización en segundo plano..." });

    console.log("--- INICIANDO SYNC MASIVO ---");
    const phones = Object.keys(simulacionDB);
    
    // Procesamos en serie para no saturar la API (Rate Limiting manual)
    for (const phone of phones) {
        await procesarYGuardarUsuario(phone, simulacionDB[phone]);
        // Esperar 1 segundo entre llamadas para ser amables con la API externa
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("--- SYNC MASIVO TERMINADO ---");
});


// ==========================================
// ⚡ ENDPOINTS PÚBLICOS (MODO LECTURA DE BD)
// ==========================================

// Helpers
const responder = (res, statusCode, title, rawData) => {
    const message = rawData.mensaje || 'Datos recuperados.';
    res.status(statusCode).json({
        raw: { status: 'exito', ...rawData },
        markdown: `**${title}**\n\n${message}`,
        type: "markdown"
    });
};

app.post('/api/negociacao/buscar-credores', async (req, res) => {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        // LEER DE SQLITE (0 latencia de red externa)
        const cachedUser = await getFromCache(rawPhone);
        
        if (!cachedUser) {
            return res.status(404).json({ error: "Usuario no sincronizado o no encontrado. Ejecute sync." });
        }

        const dividasData = JSON.parse(cachedUser.dividas_json);
        
        // Generar Markdown desde la cache
        let md = `**Hola.** Hemos encontrado tus deudas (Información al: ${cachedUser.last_updated}):\n\n`;
        dividasData.forEach((deuda, i) => {
            md += `### Deuda ${i + 1}: Total R$ ${deuda.valor}\n`;
            if (deuda.contratos) {
                deuda.contratos.forEach(contrato => {
                    md += `- Producto: ${contrato.produto} (Doc: ${contrato.numero})\n`;
                });
            }
        });

        responder(res, 200, "Deudas (Caché)", { mensaje: md, detalle: dividasData });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error interno leyendo caché" });
    }
});

app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        
        if (!cachedUser) return res.status(404).json({ error: "Datos no disponibles." });

        const simulacionData = JSON.parse(cachedUser.simulacion_json);
        
        let md = "Opciones de pago pre-calculadas:\n\n";
        if (simulacionData.opcoesPagamento) {
            simulacionData.opcoesPagamento.forEach((op, idx) => {
                md += `**${idx + 1}. ${op.texto}**\n`;
                md += `- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
            });
        }

        responder(res, 200, "Opciones (Caché)", { ...simulacionData, mensaje: md });

    } catch (error) {
        res.status(500).json({ error: "Error leyendo caché" });
    }
});

// ==========================================
// ⚠️ ENDPOINT DE EMISIÓN (SIGUE SIENDO REAL-TIME)
// ==========================================
// Este NO puede ser cacheado porque requiere generar un boleto válido en el momento
// Reutilizamos la lógica original de obtención de contexto SOLO para este endpoint.

// (Necesitas copiar tu función `obtenerContextoDeuda` original aquí abajo 
//  para que este endpoint funcione independientemente de la caché)

app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    // ... Tu código original de emitir boleto ...
    // Aquí SÍ debes llamar a la API real porque un boleto tiene fecha de expiración y registro bancario
    // que ocurre en tiempo real.
    res.json({mensaje: "Este endpoint debe mantener la lógica original de llamada API para ser válido."});
});

app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
    console.log(`👉 Para llenar la base de datos, envía un POST a: http://${HOST}:${PORT}/api/admin/sync-database`);
});