require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
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

// --- CONFIGURACIÓN AXIOS ---
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
    //"06430897052": { "cpf_cnpj": "06430897052", "nombre": "Usuario Test 064" },
    "10173421997": { "cpf_cnpj": "10173421997", "nombre": "Usuario Test 101" },
    "04065282330": { "cpf_cnpj": "04065282330", "nombre": "Usuario Test 040" },
    "09241820918": { "cpf_cnpj": "09241820918", "nombre": "Usuario Test 092" },
    "63618955308": { "cpf_cnpj": "63618955308", "nombre": "Usuario Test 636" },
    "+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },
    "+5519981516633": { "cpf_cnpj": "06430897052", "nombre": "Bruno" }
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


// Función de sincronización en segundo plano
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
app.post('/api/admin/sync-database', async (req, res) => {
    res.json({ status: "Iniciando sincronización en segundo plano..." });
    console.log("--- INICIANDO SYNC MASIVO ---");
    const phones = Object.keys(simulacionDB);
    for (const phone of phones) {
        await procesarYGuardarUsuario(phone, simulacionDB[phone]);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("--- SYNC MASIVO TERMINADO ---");
});


// ==========================================
// ⚡ HELPERS Y ENDPOINTS PÚBLICOS
// ==========================================

// Helper MODIFICADO: Soporta respuesta bilingüe
const responder = (res, statusCode, titleES, titlePT, rawData, mdES, mdPT) => {
    // Si no se pasan mensajes específicos, usamos los del rawData o un default
    const messageES = mdES || rawData.mensaje || 'Operación completada.';
    const messagePT = mdPT || rawData.mensajePT || messageES; // Fallback al español si no hay PT

    res.status(statusCode).json({
        raw: { status: statusCode >= 400 ? 'error' : 'exito', ...rawData },
        markdown: `**${titleES}**\n\n${messageES}`,
        type: "markdown",
        desc: `**${titlePT}**\n\n${messagePT}`
    });
};

function handleApiError(res, error, titleES, titlePT) {
    console.error(`[Error] ${titleES}:`, error.message);
    let statusCode = 500;
    let mensajeES = 'Ocurrió un error inesperado en el servidor.';
    let mensajePT = 'Ocorreu um erro inesperado no servidor.';

    if (error.response) {
        statusCode = error.response.status;
        mensajeES = error.response.data.msgRetorno || 'Error de la API de negociación.';
        mensajePT = error.response.data.msgRetorno || 'Erro na API de negociação.';
    } else if (error.request) {
        statusCode = 504;
        mensajeES = 'La API no respondió a tiempo.';
        mensajePT = 'A API não respondeu a tempo.';
    }
    
    responder(res, statusCode, titleES, titlePT, { error: error.message }, mensajeES, mensajePT);
}

// 1. BUSCAR CREDORES (Llectura de Caché Bilingüe)
app.post('/api/negociacao/buscar-credores', async (req, res) => {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        
        if (!cachedUser) {
            return res.status(404).json({ error: "Usuario no sincronizado. Ejecute /api/admin/sync-database primero." });
        }

        const dividasData = JSON.parse(cachedUser.dividas_json);
        const fechaActualizacion = new Date(cachedUser.last_updated).toLocaleString();
        
        // --- GENERAR ESPAÑOL ---
        let md_es = `**Hola.** Hemos encontrado tus deudas (Actualizado al: ${fechaActualizacion}):\n\n`;
        // --- GENERAR PORTUGUÉS ---
        let md_pt = `**Olá.** Encontramos suas dívidas (Atualizado em: ${fechaActualizacion}):\n\n`;
        
        if (dividasData && dividasData.length > 0) {
            dividasData.forEach((deuda, i) => {
                // Español
                md_es += `### 💰 Deuda ${i + 1}: Total R$ ${deuda.valor}\n`;
                // Portugués
                md_pt += `### 💰 Dívida ${i + 1}: Total R$ ${deuda.valor}\n`;

                if (deuda.contratos && deuda.contratos.length > 0) {
                    deuda.contratos.forEach(contrato => {
                        // Español
                        md_es += `- **Producto:** ${contrato.produto}\n`;
                        md_es += `  - 📄 Contrato: ${contrato.numero || contrato.documento}\n`;
                        md_es += `  - 📅 **Días de Atraso:** ${contrato.diasAtraso}\n`;
                        md_es += `  - 💲 Valor Original: R$ ${contrato.valor}\n`;
                        
                        // Portugués
                        md_pt += `- **Produto:** ${contrato.produto}\n`;
                        md_pt += `  - 📄 Contrato: ${contrato.numero || contrato.documento}\n`;
                        md_pt += `  - 📅 **Dias de Atraso:** ${contrato.diasAtraso}\n`;
                        md_pt += `  - 💲 Valor Original: R$ ${contrato.valor}\n`;
                    });
                } else {
                    md_es += "  - Sin detalles de contratos.\n";
                    md_pt += "  - Sem detalhes de contratos.\n";
                }
                md_es += `\n`;
                md_pt += `\n`;
            });
            // Pregunta de cierre en PT como solicitaste en el prompt original
            md_pt += `Poderia explicar por que não pagou sua dívida?\n`; 
        } else {
            md_es += "No se encontraron deudas activas en el registro.";
            md_pt += "Não foram encontradas dívidas ativas no registro.";
        }

        responder(res, 200, "Deudas", "Dívidas", { detalle: dividasData }, md_es, md_pt);

    } catch (error) {
        console.error("Error en buscar-credores:", error);
        res.status(500).json({ error: "Error interno leyendo caché" });
    }
});

// 2. BUSCAR OPCIONES (Llectura de Caché Bilingüe)
app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        
        if (!cachedUser) return res.status(404).json({ error: "Datos no disponibles." });

        const simulacionData = JSON.parse(cachedUser.simulacion_json);
        
        let md_es = "Opciones de pago pre-calculadas:\n\n";
        let md_pt = "Opções de pagamento pré-calculadas:\n\n";

        if (simulacionData.opcoesPagamento) {
            simulacionData.opcoesPagamento.forEach((op, idx) => {
                // Español
                md_es += `**Opción ${idx + 1}. ${op.texto}**\n`;
                md_es += `- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
                
                // Portugués
                md_pt += `**Opção ${idx + 1}. ${op.texto}**\n`;
                md_pt += `- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
            });
        }

        responder(res, 200, "Opciones", "Opções", simulacionData, md_es, md_pt);

    } catch (error) {
        res.status(500).json({ error: "Error leyendo caché" });
    }
});

// ==========================================
// ⚠️ ENDPOINT DE EMISIÓN (REAL-TIME RESTAURADO)
// ==========================================
// Este endpoint debe reconstruir el contexto en tiempo real para obtener los IDs válidos
// y emitir el boleto. No usa caché para evitar boletos expirados o IDs inválidos.

// Helper local para reconstruir contexto (solo usado por emitir-boleto)
async function obtenerContextoDeudaReal(rawPhone) {
    // 1. Obtener CPF de BD simulada
    const userData = simulacionDB[rawPhone]; // Fallback a default
    if (!userData) throw new Error("Usuario no encontrado en BD.");
    
    // 2. Auth y búsqueda real
    const token = await getAuthToken(userData.cpf_cnpj);
    const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` }});
    
    if (!resCredores.data.credores?.length) throw new Error("Sin acreedores activos.");
    const credor = resCredores.data.credores[0];
    const carteiraId = credor.carteiraCrms?.[0]?.carteiraId || credor.carteiraCrms?.[0]?.id;

    const resDividas = await apiNegocie.post('/api/v5/busca-divida', 
        { financeira: credor.financeira, crms: credor.crms }, 
        { headers: { 'Authorization': `Bearer ${token}` }}
    );

    // 3. Extraer contratos (Strings)
    let contratosDocs = [];
    let fase = "";
    resDividas.data.forEach(d => {
        if (!fase && d.fase) fase = d.fase;
        d.contratos?.forEach(c => {
            if (c.documento || c.numero) contratosDocs.push(String(c.documento || c.numero));
        });
    });

    return { token, cpf_cnpj: userData.cpf_cnpj, Crm: credor.crms[0], Carteira: carteiraId, fase, Contratos: contratosDocs };
}

app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    const { function_call_username, Parcelas, DataVencimento } = req.body;
    if (!function_call_username || !Parcelas) return responder(res, 400, "Error", "Erro", { mensaje: "Faltan datos." });

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        // 1. Reconstruir contexto real
        const ctx = await obtenerContextoDeudaReal(rawPhone);

        // 2. Re-simular para obtener ID válido
        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.Contratos,
            DataVencimento: DataVencimento || null,
            ValorEntrada: 0,
            QuantidadeParcela: Parcelas,
            ValorParcela: 0
        };

        const resSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        const opcion = resSimulacion.data.opcoesPagamento?.find(op => op.qtdParcelas == Parcelas);
        if (!opcion) throw new Error("Opción no válida en simulación real.");

        let idFinal = opcion.codigo;

        // 3. Resumo Boleto (Si aplica)
        if (resSimulacion.data.chamarResumoBoleto) {
            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                Crm: ctx.Crm,
                CodigoCarteira: ctx.Carteira,
                CNPJ_CPF: ctx.cpf_cnpj,
                Contrato: ctx.Contratos[0],
                CodigoOpcao: opcion.codigo
            }, { headers: { 'Authorization': `Bearer ${ctx.token}` }});
            
            if (resResumo.data.sucesso) idFinal = resResumo.data.identificador;
        }

        // 4. Emitir Boleto
        // const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', {
        //     Crm: ctx.Crm,
        //     Carteira: ctx.Carteira,
        //     CNPJ_CPF: ctx.cpf_cnpj,
        //     fase: ctx.fase,
        //     Contrato: ctx.Contratos[0],
        //     Valor: opcion.valor,
        //     Parcelas: Parcelas,
        //     DataVencimento: opcion.dataVencimento || DataVencimento,
        //     Identificador: idFinal,
        //     TipoContrato: null
        // }, { headers: { 'Authorization': `Bearer ${ctx.token}` }});

        // 5. Generar mensajes bilingües
        const md_es = `¡Listo! Boleto generado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vence**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        const md_pt = `Pronto! Boleto gerado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimento**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        responder(res, 201, "Boleto Emitido", "Boleto Gerado", resEmision.data, md_es, md_pt);

    } catch (error) {
        handleApiError(res, error, "Error al emitir", "Erro ao emitir");
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
    console.log(`👉 Para llenar la base de datos, envía un POST a: http://${HOST}:${PORT}/api/admin/sync-database`);
});