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

// Helpers DB
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
    "06430897052": { "cpf_cnpj": "06430897052", "nombre": "Usuario Test 064" },
    "10173421997": { "cpf_cnpj": "10173421997", "nombre": "Usuario Test 101" },
    "04065282330": { "cpf_cnpj": "04065282330", "nombre": "Usuario Test 040" },
    "09241820918": { "cpf_cnpj": "09241820918", "nombre": "Usuario Test 092" },
    "63618955308": { "cpf_cnpj": "63618955308", "nombre": "Usuario Test 636" },
    "+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },
};

// --- LOGICA DE CONEXIÓN REAL ---
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

        // 3. Simula Opciones
        let contratosDocs = [];
        dividasData.forEach(d => d.contratos?.forEach(c => {
            if (c.documento || c.numero) contratosDocs.push(String(c.documento || c.numero));
        }));

        const bodySimulacion = {
            Crm: credor.crms[0],
            Carteira: carteiraId,
            Contratos: contratosDocs,
            DataVencimento: null, 
            ValorEntrada: 0,
            QuantidadeParcela: 0,
            ValorParcela: 0
        };

        const resSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const simulacionData = resSimulacion.data;

        await saveToCache(phone, userData.cpf_cnpj, credoresData, dividasData, simulacionData);
        console.log(`✅ ${phone} guardado exitosamente.`);
        return true;

    } catch (error) {
        console.error(`❌ Error sincronizando ${phone}:`, error.message);
        return false;
    }
}

// --- HELPER PARA EMISIÓN REAL ---
async function obtenerContextoDeudaReal(rawPhone) {
    const userData = simulacionDB[rawPhone] || simulacionDB["+525510609610"]; 
    if (!userData) throw new Error("Usuario no encontrado en BD.");
    
    const token = await getAuthToken(userData.cpf_cnpj);
    const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` }});
    
    if (!resCredores.data.credores?.length) throw new Error("Sin acreedores activos.");
    const credor = resCredores.data.credores[0];
    const carteiraId = credor.carteiraCrms?.[0]?.carteiraId || credor.carteiraCrms?.[0]?.id;

    const resDividas = await apiNegocie.post('/api/v5/busca-divida', 
        { financeira: credor.financeira, crms: credor.crms }, 
        { headers: { 'Authorization': `Bearer ${token}` }}
    );

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

// --- HELPERS DE RESPUESTA ---
const responder = (res, statusCode, titleES, titlePT, rawData, mdES, mdPT) => {
    const messageES = mdES || rawData.mensaje || 'Operación completada.';
    const messagePT = mdPT || rawData.mensajePT || messageES; 

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
    }
    
    responder(res, statusCode, titleES, titlePT, { error: error.message }, mensajeES, mensajePT);
}

// =========================================================================
// 🚦 MAIN HANDLER / DISPATCHER (PUNTO DE ENTRADA ÚNICO)
// =========================================================================
app.post('/api/chat-handler', async (req, res) => {
    try {
        const body = req.body;
        console.log("📨 Payload recibido en Handler:", JSON.stringify(body, null, 2));

        // 1. Verificar si es IDENTIFICACIÓN (llega CPF) -> Llamar a Buscar Credores
        if (body.cpf_cnpj) {
            console.log("➡️ Detectado: Solicitud de Credores (por CPF)");
            return await logicBuscarCredores(req, res);
        }

        // 2. Verificar si es SOLICITUD DE OPCIONES (llega msg) -> Llamar a Buscar Opciones
        if (body.msg) {
            console.log("➡️ Detectado: Solicitud de Opciones (por msg)");
            return await logicBuscarOpcoes(req, res);
        }

        // 3. Verificar si es EMISIÓN (llegan Parcelas y Fecha) -> Llamar a Emitir Boleto
        if (body.Parcelas && body.DataVencimento) {
            console.log("➡️ Detectado: Solicitud de Emisión");
            return await logicEmitirBoleto(req, res);
        }

        // 4. Default / Fallback
        console.warn("⚠️ No se detectó intención clara en el JSON.");
        return responder(res, 400, "Error de Solicitud", "Erro de Solicitação", {}, "No entendí tu solicitud. Faltan datos.", "Não entendi sua solicitação. Dados ausentes.");

    } catch (error) {
        console.error("Error fatal en handler:", error);
        return handleApiError(res, error, "Error Interno", "Erro Interno");
    }
});


// =========================================================================
// 🧠 LÓGICA DE NEGOCIO (FUNCIONES INTERNAS)
// =========================================================================

// Lógica A: Buscar Credores (Lectura de Caché)
async function logicBuscarCredores(req, res) {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) {
            return res.status(404).json({ error: "Usuario no sincronizado. Ejecute /api/admin/sync-database primero." });
        }

        const dividasData = JSON.parse(cachedUser.dividas_json);
        const fechaActualizacion = new Date(cachedUser.last_updated).toLocaleString();
        
        let md_es = `**Hola.** Hemos encontrado tus deudas (Actualizado al: ${fechaActualizacion}):\n\n`;
        let md_pt = `**Olá.** Encontramos suas dívidas (Atualizado em: ${fechaActualizacion}):\n\n`;
        
        if (dividasData && dividasData.length > 0) {
            dividasData.forEach((deuda, i) => {
                md_es += `### 💰 Deuda ${i + 1}: Total R$ ${deuda.valor}\n`;
                md_pt += `### 💰 Dívida ${i + 1}: Total R$ ${deuda.valor}\n`;

                if (deuda.contratos && deuda.contratos.length > 0) {
                    deuda.contratos.forEach(contrato => {
                        md_es += `- **Producto:** ${contrato.produto}\n  - 📄 Contrato: ${contrato.numero || contrato.documento}\n  - 📅 **Días de Atraso:** ${contrato.diasAtraso}\n  - 💲 Valor Original: R$ ${contrato.valor}\n`;
                        md_pt += `- **Produto:** ${contrato.produto}\n  - 📄 Contrato: ${contrato.numero || contrato.documento}\n  - 📅 **Dias de Atraso:** ${contrato.diasAtraso}\n  - 💲 Valor Original: R$ ${contrato.valor}\n`;
                    });
                } else {
                    md_es += "  - Sin detalles de contratos.\n";
                    md_pt += "  - Sem detalhes de contratos.\n";
                }
                md_es += `\n`;
                md_pt += `\n`;
            });
            md_pt += `Poderia explicar por que não pagou sua dívida?\n`; 
        } else {
            md_es += "No se encontraron deudas activas en el registro.";
            md_pt += "Não foram encontradas dívidas ativas no registro.";
        }

        return responder(res, 200, "Deudas", "Dívidas", { detalle: dividasData }, md_es, md_pt);
    } catch (error) {
        console.error("Error en logicBuscarCredores:", error);
        return handleApiError(res, error, "Error leyendo datos", "Erro lendo dados");
    }
}

// Lógica B: Buscar Opciones (Lectura de Caché)
async function logicBuscarOpcoes(req, res) {
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
                md_es += `**Opción ${idx + 1}. ${op.texto}**\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
                md_pt += `**Opção ${idx + 1}. ${op.texto}**\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
            });
        }

        return responder(res, 200, "Opciones", "Opções", simulacionData, md_es, md_pt);
    } catch (error) {
        return handleApiError(res, error, "Error al buscar opciones", "Erro ao buscar opções");
    }
}

// Lógica C: Emitir Boleto (Real-time Stateless)
async function logicEmitirBoleto(req, res) {
    const { function_call_username, Parcelas, DataVencimento } = req.body;
    // Si no llega Parcelas, no podemos emitir. El handler principal ya valida esto, pero doble check.
    if (!Parcelas) return responder(res, 400, "Error", "Erro", { mensaje: "Faltan datos." });

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const ctx = await obtenerContextoDeudaReal(rawPhone);

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

        const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            CNPJ_CPF: ctx.cpf_cnpj,
            fase: ctx.fase,
            Contrato: ctx.Contratos[0],
            Valor: opcion.valor,
            Parcelas: Parcelas,
            DataVencimento: opcion.dataVencimento || DataVencimento,
            Identificador: idFinal,
            TipoContrato: null
        }, { headers: { 'Authorization': `Bearer ${ctx.token}` }});

        const md_es = `¡Listo! Boleto generado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vence**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        const md_pt = `Pronto! Boleto gerado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimento**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        return responder(res, 201, "Boleto Emitido", "Boleto Gerado", resEmision.data, md_es, md_pt);

    } catch (error) {
        return handleApiError(res, error, "Error al emitir", "Erro ao emitir");
    }
}

// Endpoint de sincronización (Admin)
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

app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
    console.log(`👉 Punto de entrada principal: POST http://${HOST}:${PORT}/api/chat-handler`);
});