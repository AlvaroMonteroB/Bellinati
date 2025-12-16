require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
// --- IMPORTAR LIBRERÍAS DE GOOGLE ---
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(helmet());
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ==========================================
// 📊 CONFIGURACIÓN GOOGLE SHEETS
// ==========================================

// Configuración de Autenticación
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Hoja 1'; // Nombre de la pestaña
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

// Configuración de Autenticación (JWT para Service Accounts)
const serviceAccountAuth = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ==========================================
// 📝 FUNCIÓN UPDATE SHEETS
// ==========================================
async function updateGoogleSheet(phone, tag) {
    console.log("Actualizando google sheets")
    // Validación de seguridad
    if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL) {
        console.error("⚠️ Faltan variables de entorno para Google Sheets.");
        return;
    }

    try {
        // 1. Inicializar el documento con el ID constante
        const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
        
        // 2. Cargar info
        await doc.loadInfo();
        
        // 3. Seleccionar la hoja por NOMBRE (Estilo tu otro proyecto)
        const sheet = doc.sheetsByTitle[SHEET_NAME]; 

        if (!sheet) {
            console.error(`❌ No se encontró la hoja con nombre: "${SHEET_NAME}"`);
            return;
        }

        // --- MAPEO DE COLUMNAS ---
        let columnToMark = null;
        let valueToWrite = "✅"; 

        // Definimos la lógica de qué columna llenar
        if (tag.toLowerCase().includes("transbordo")) {
            columnToMark = "Tag Transbordo";
            valueToWrite = tag; 
        } 
        else if (tag === "Tag lista dívida") columnToMark = "Tag lista dívida";
        else if (tag === "IA - CPC" || tag === "Tag IA - CPC") columnToMark = "Tag IA - CPC";
        else if (tag === "Tag Opções de Pagamento") columnToMark = "Tag Opções de Pagamento";
        else if (tag === "BOT_BOLETO_GERADO") columnToMark = "Tag Formalizar Acordo";
        else if (tag.includes("Erro - API") || tag.includes("Error")) {
            columnToMark = "Tag Erro - API";
            valueToWrite = tag;
        }
        else if (tag === "Tag Confirmação CPF") columnToMark = "Tag Confirmação CPF";

        if (!columnToMark) return; // Si el tag no es relevante, salimos

        // --- LÓGICA DE ESCRITURA ---
        const rows = await sheet.getRows();
        
        // Buscamos si ya existe el teléfono
        const targetRow = rows.find(row => String(row.get('Numero')) === String(phone));

        if (targetRow) {
            // ACTUALIZAR (Usando assign para librería v4)
            targetRow.assign({ [columnToMark]: valueToWrite });
            await targetRow.save();
            console.log(`📊 Sheet: ${phone} -> [${columnToMark}: ${valueToWrite}] (Actualizado)`);
        } else {
            // CREAR NUEVO
            const newRowData = { "Numero": phone };
            newRowData[columnToMark] = valueToWrite;
            await sheet.addRow(newRowData);
            console.log(`📊 Sheet: ${phone} -> [${columnToMark}: ${valueToWrite}] (Nuevo)`);
        }

    } catch (error) {
        console.error("❌ Error Google Sheets:", error.message);
    }
}

// --- 1. HELPER RESPONDER ---
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

function handleApiError(res, error, titleES, titlePT, extraData = {}) {
    console.error(`❌ [Error] ${titleES}:`, error.message);
    const statusCode = error.response ? error.response.status : 500;
    responder(res, statusCode, titleES, titlePT, { error: error.message, ...extraData }, error.message, error.message);
}

// --- 2. CONFIGURACIÓN EMAIL ---
async function enviarReporteEmail(raw_phone, tag, dadosCliente, erroDetalhe = null) {
    const destinatario = process.env.EMAIL_DESTINATARIO;
    if (!process.env.EMAIL_USER || !destinatario) return;

    if (!dadosCliente) dadosCliente = { nombre: raw_phone, phone: 'N/A', cpf_cnpj: 'N/A' };

    console.log(`📧 ENVIANDO REPORTE AHORA (Interacción Detectada): [${tag}]`);

    const htmlContent = `
        <div style="border: 1px solid #d9534f; padding: 20px; font-family: sans-serif;">
            <h2 style="color: #d9534f;">🚨 Transbordo Solicitado: ${tag}</h2>
            <p><strong>Cliente:</strong> ${dadosCliente.nombre || 'N/A'}</p>
            <p><strong>Teléfono:</strong> ${raw_phone || 'N/A'}</p>
            <p><strong>CPF:</strong> ${dadosCliente.cpf_cnpj || 'N/A'}</p>
            ${erroDetalhe ? `<div style="background:#eee;padding:10px;margin-top:10px;"><strong>Detalle Técnico:</strong><br>${erroDetalhe}</div>` : ''}
        </div>`;

    try {
        console.log("Sending email");
        await autoMailer.post("send-email", { to: destinatario, subject: `[TRANSBORDO] ${tag} - ${dadosCliente.phone}`, text: "", html: htmlContent });
    } catch (e) { console.error('Error enviando email:', e.message); }
}

// --- 3. BASE DE DATOS (Optimized WAL) ---
const db = new sqlite3.Database('./cache_negociacion.db');

db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA synchronous = NORMAL;");
    db.run(`CREATE TABLE IF NOT EXISTS user_cache (
        phone TEXT PRIMARY KEY, cpf TEXT, credores_json TEXT, dividas_json TEXT,
        simulacion_json TEXT, last_updated DATETIME, last_tag TEXT, error_details TEXT
    )`);
});

// MODIFICADO: Ahora llama a updateGoogleSheet automáticamente
function saveToCache(phone, cpf, credores, dividas, simulacion, tag, errorDetails = null) {
    return new Promise((resolve, reject) => {
        // 1. Guardar en SQLite
        const stmt = db.prepare(`INSERT OR REPLACE INTO user_cache 
            (phone, cpf, credores_json, dividas_json, simulacion_json, last_updated, last_tag, error_details)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`);
        
        stmt.run(phone, cpf, JSON.stringify(credores || {}), JSON.stringify(dividas || []),
            JSON.stringify(simulacion || {}), tag, errorDetails, async (err) => {
                if (err) {
                    reject(err);
                } else {
                    // 2. Actualizar Google Sheets (Fuego y olvido para no bloquear respuesta)
                    updateGoogleSheet(phone, tag).catch(e => console.error("Sheets Error Async:", e));
                    resolve();
                }
            });
        stmt.finalize();
    });
}

function getFromCache(phone) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM user_cache WHERE phone = ?", [phone], (err, row) => err ? reject(err) : resolve(row));
    });
}

// --- 4. AXIOS ---
dns.setDefaultResultOrder('ipv4first');
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
const apiAuth = axios.create({ baseURL: 'https://bpdigital-api.bellinatiperez.com.br', timeout: 30000, httpsAgent });
const apiNegocie = axios.create({ baseURL: 'https://api-negocie.bellinati.com.br', timeout: 30000, httpsAgent });
const autoMailer = axios.create({ baseURL: "https://auto-mailer-delta.vercel.app/", timeout: 30000 }, httpsAgent);

// --- 5. SIMULACIÓN DB ---
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

"29103077861": {"cpf_cnpj" : "29103077861", "nombre": "Usuario test 1337"},

"+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },

}; 

async function getAuthToken(cpf_cnpj) {
    const res = await apiAuth.post('/api/Login/v5/Authentication', {
        AppId: process.env.API_APP_ID, AppPass: process.env.API_APP_PASS, Usuario: cpf_cnpj
    });
    return res.data.token || res.data.access_token;
}

// --- 6. SYNC SILENCIOSO ---
async function procesarYGuardarUsuario(phone, userData) {
    try {
        console.log(`🔄 Syncing ${phone}...`);
        let token;
        try {
            token = await getAuthToken(userData.cpf_cnpj);
        } catch (e) {
            const tag = "Transbordo - Usuário não identificado";
            await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, tag, e.message);
            return false;
        }

        // 1. Busca Credores
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!resCredores.data.credores?.length) {
            const tag = "Transbordo - Credor não encontrado";
            await saveToCache(phone, userData.cpf_cnpj, resCredores.data, [], {}, tag);
            return true;
        }

        const credor = resCredores.data.credores[0];
        const carteiraInfo = credor.carteiraCrms?.[0];
        const carteiraId = carteiraInfo?.carteiraId || carteiraInfo?.id;

        // 2. Busca Dívida
        let dividasData = [];
        try {
            const resDividas = await apiNegocie.post('/api/v5/busca-divida',
                { financeira: credor.financeira, crms: credor.crms },
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            dividasData = resDividas.data;
        } catch (e) {
            const tag = "Transbordo - Listar dividas - Erro";
            await saveToCache(phone, userData.cpf_cnpj, resCredores.data, [], {}, tag, e.message);
            return false;
        }

        // 3. Simula Opções
        let simulacionData = {};
        let currentTag = "Tag lista dívida";
        let contratosDocs = [];
        dividasData.forEach(d => d.contratos?.forEach(c => {
            if (c.numero || c.documento) contratosDocs.push(String(c.numero || c.documento));
        }));

        try {
            const resSimul = await apiNegocie.post('/api/v5/busca-opcao-pagamento', {
                Crm: credor.crms[0], Carteira: carteiraId, Contratos: contratosDocs,
                DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: 0, ValorParcela: 0
            }, { headers: { 'Authorization': `Bearer ${token}` } });

            simulacionData = resSimul.data;
            if (!simulacionData.opcoesPagamento?.length) {
                currentTag = "Transbordo - Cliente sem opções de pagamento";
            } else {
                currentTag = "Tag Opções de Pagamento";
            }
        } catch (e) {
            currentTag = "Transbordo - Busca Opções de Pagamento - Erro";
            await saveToCache(phone, userData.cpf_cnpj, resCredores.data, dividasData, {}, currentTag, e.message);
            return false;
        }

        await saveToCache(phone, userData.cpf_cnpj, resCredores.data, dividasData, simulacionData, currentTag);
        return true;
    } catch (error) {
        console.error(`❌ Fatal sync error ${phone}:`, error.message);
        return false;
    }
}

// ==========================================
// 🚦 ENDPOINTS
// ==========================================

// 1. ENDPOINT TRANSBORDO & TAGS
app.post('/api/transbordo', async (req, res) => {
    const { tag, function_call_username } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;
    const userData = simulacionDB[rawPhone] || { phone: rawPhone, nombre: "Desconhecido" };

    try {
        if (tag) {
            if (tag.toLowerCase().includes("transbordo")) {
                await enviarReporteEmail(rawPhone, tag, userData);
            }
            // Guardamos en cache (y por ende en Sheets)
            await saveToCache(rawPhone, userData.cpf_cnpj, null, null, null, tag);
            
            return responder(res, 200, "Transferencia solicitada", "Transbordo obrigatório", { received: true, tag }, "Tag procesada.", "Sua solicitação está em espera.");
        }

        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) {
            return responder(res, 404, "Usuario No Encontrado", "Usuário Não Encontrado", {}, "Datos no sync.", "Dados não sync.");
        }

        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            await enviarReporteEmail(rawPhone, cachedUser.last_tag, userData, cachedUser.error_details);
            const msgES = `⚠️ Transbordo requerido: **${cachedUser.last_tag}**.`;
            const msgPT = `⚠️ Transbordo necessário: **${cachedUser.last_tag}**.`;
            return responder(res, 200, "Transbordo Requerido", "Transbordo Necessário", { transbordo: true, tag: cachedUser.last_tag }, msgES, msgPT);
        }

        return responder(res, 200, "Estado Normal", "Estado Normal", { transbordo: false }, "OK", "OK");
    } catch (e) {
        handleApiError(res, e, "Error Transbordo", "Erro Transbordo");
    }
});

// 2. ENDPOINT CONSULTAR OFERTAS
app.post('/api/consultar-ofertas', async (req, res) => {
    const { function_call_username, cpf_cnpj } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return responder(res, 404, "Sin Datos", "Sem Dados", {}, "Sync requerido.", "Sync requerido.");
        
        if (cachedUser.cpf != cpf_cnpj) {
            // REGISTRAMOS TRANSBORDO POR CPF INCORRECTO
            const tag = "Transbordo - Recusa Confirmação CPF";
            const userData = simulacionDB[rawPhone] || { phone: rawPhone };
            await saveToCache(rawPhone, userData.cpf_cnpj, {}, [], {}, tag); // Esto actualiza el sheet
            await enviarReporteEmail(rawPhone, tag, userData);
            
            return responder(res, 404, "CPF Incorrecto", "CPF Incorreto", { transbordo: true, tag }, "El CPF no corresponde.", "CPF incorreto.");
        }

        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            console.log("Reporte email");
            await enviarReporteEmail(rawPhone, cachedUser.last_tag, simulacionDB[rawPhone], cachedUser.error_details);
            return responder(res, 200, "Bloqueo", "Bloqueio", { transbordo: true, tag: cachedUser.last_tag }, `⚠️ ${cachedUser.last_tag}`, `⚠️ ${cachedUser.last_tag}`);
        }

        await logicBuscarCredoresCompletos(res, cachedUser);
    } catch (e) {
        handleApiError(res, e, "Error Consultar", "Erro Consultar");
    }
});

// 3. ENDPOINT EMITIR BOLETO
app.post('/api/emitir-boleto', async (req, res) => {
    const { function_call_username, opt, Parcelas } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;
    const userData = simulacionDB[rawPhone] || { phone: rawPhone, nombre: "Desconhecido" };

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return responder(res, 404, "Sin Datos", "Sem Dados", {}, "Error datos.", "Erro dados.");

        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            console.log("Reporte email");
            await enviarReporteEmail(rawPhone, cachedUser.last_tag, userData, cachedUser.error_details);
            return responder(res, 200, "Bloqueo", "Bloqueio", { transbordo: true }, "Transbordo requerido.", "Transbordo necessário.");
        }

        await logicEmitirBoleto(req, res, rawPhone, cachedUser, userData);
    } catch (e) {
        handleApiError(res, e, "Error Boleto", "Erro Boleto");
    }
});

// --- LÓGICA INTERNA ---

async function logicBuscarCredoresCompletos(res, cachedUser) {
    const dividas = JSON.parse(cachedUser.dividas_json || '[]');
    const sim = JSON.parse(cachedUser.simulacion_json || '{}');
    const opcoes = sim.opcoesPagamento || [];

    let mdES = `**Hola.** He revisado tu estado de cuenta:\n\n`;
    let mdPT = `**Olá.** Verifiquei seu extrato:\n\n`;

    if (dividas.length === 0) {
        mdES = "No encontré deudas pendientes."; mdPT = "Não encontrei dívidas pendentes.";
    } else {
        mdES += `### 📌 Tus Deudas:\n`; mdPT += `### 📌 Suas Dívidas:\n`;
        dividas.forEach(d => {
            mdES += `- **Valor:** R$ ${d.valor}\n  - Contrato: ${d.contratos?.[0]?.numero}\n\n`;
            mdPT += `- **Valor:** R$ ${d.valor}\n  - Contrato: ${d.contratos?.[0]?.numero}\n\n`;
        });
    }

    if (opcoes.length > 0) {
        mdES += `### 💳 Opciones de Pago:\n\n`; mdPT += `### 💳 Opções de Pagamento:\n\n`;
        opcoes.forEach((op, i) => {
            const val = op.valorTotalComCustas || op.valor;
            mdES += `🔹 **Opción ${i + 1}:** ${op.texto}\n   (Total: R$ ${val})\n\n`;
            mdPT += `🔹 **Opção ${i + 1}:** ${op.texto}\n   (Total: R$ ${val})\n\n`;
        });
        mdES += `\n**Responde con el número de la opción.**`; mdPT += `\n**Responda com o número da opção.**`;
    }

    responder(res, 200, "Estado de Cuenta", "Extrato", { dividas, opcoes }, mdES, mdPT);
}

async function logicEmitirBoleto(req, res, phone, cachedUser, userData) {
    const { opt, Parcelas } = req.body;
    try {
        const simCache = JSON.parse(cachedUser.simulacion_json);
        const opcoes = simCache.opcoesPagamento || [];

        let targetOp;
        if (opt) {
            const idx = parseInt(opt) - 1;
            if (idx >= 0 && idx < opcoes.length) targetOp = opcoes[idx];
        } else if (Parcelas) {
            targetOp = opcoes.find(o => o.qtdParcelas == Parcelas);
        }

        if (!targetOp) return responder(res, 400, "Opción Inválida", "Opção Inválida", {}, "Opción no válida.", "Opção inválida.");

        const token = await getAuthToken(userData.cpf_cnpj);
        const credoresData = JSON.parse(cachedUser.credores_json);
        const credor = credoresData.credores[0];
        const carteiraId = credor.carteiraCrms[0].carteiraId || credor.carteiraCrms[0].id;
        const contratos = targetOp.contratos || [];

        const resReSimul = await apiNegocie.post('/api/v5/busca-opcao-pagamento', {
            Crm: credor.crms[0], Carteira: carteiraId, Contratos: contratos,
            DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: targetOp.qtdParcelas, ValorParcela: 0
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        const freshOp = resReSimul.data.opcoesPagamento?.find(o => o.qtdParcelas == targetOp.qtdParcelas);
        if (!freshOp) throw new Error("Opción no disponible.");
        let idBoleto = freshOp.codigo;

        if (resReSimul.data.chamarResumoBoleto) {
            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                Crm: credor.crms[0], CodigoCarteira: carteiraId, CNPJ_CPF: userData.cpf_cnpj,
                Contrato: contratos[0], CodigoOpcao: idBoleto
            }, { headers: { 'Authorization': `Bearer ${token}` } });
            if (resResumo.data.sucesso) idBoleto = resResumo.data.identificador;
            else throw new Error("Fallo en Resumo Boleto");
        }

        const resEmitir = await apiNegocie.post('/api/v5/emitir-boleto', {
            Crm: credor.crms[0], Carteira: carteiraId, CNPJ_CPF: userData.cpf_cnpj,
            fase: JSON.parse(cachedUser.dividas_json)[0]?.fase || "", Contrato: contratos[0], Valor: freshOp.valor,
            Parcelas: freshOp.qtdParcelas, DataVencimento: freshOp.dataVencimento,
            Identificador: idBoleto, TipoContrato: null
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        if (!resEmitir.data.sucesso) throw new Error(resEmitir.data.msgRetorno || "Error API.");

        // Éxito: Guardamos tag de éxito que activará "Tag Formalizar Acordo" en Sheets
        await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, "BOT_BOLETO_GERADO");
        
        const boleto = resEmitir.data;
        const mdES = `✅ **¡Acuerdo Exitoso!**\n\n📄 Código: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}\n📅 Vence: ${boleto.vcto}`;
        const mdPT = `✅ **Acordo Realizado!**\n\n📄 Linha Digitável: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}\n📅 Vencimento: ${boleto.vcto}`;

        responder(res, 200, "Boleto Generado", "Boleto Gerado", boleto, mdES, mdPT);

    } catch (error) {
        const tag = "Transbordo - Erro emissão de boleto";
        await enviarReporteEmail(phone, tag, userData, error.message);
        await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, tag, error.message);
        const errES = "Hubo un error técnico. He notificado al equipo.";
        const errPT = "Houve um erro técnico. Equipe notificada.";
        responder(res, 500, "Error Emisión", "Erro Emissão", { transbordo: true, tag }, errES, errPT);
    }
}

// --- SYNC BATCH ---
app.post('/api/admin/sync', async (req, res) => {
    const phones = Object.keys(simulacionDB);
    const BATCH_SIZE = 5;
    console.log(`🚀 Sync Optimizado (${phones.length} usuarios)`);
    res.json({ msg: "Sync iniciado", total: phones.length });

    const chunkArray = (arr, size) => {
        const res = [];
        for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
        return res;
    };
    const batches = chunkArray(phones, BATCH_SIZE);
    for (const batch of batches) {
        await Promise.all(batch.map(ph => procesarYGuardarUsuario(ph, simulacionDB[ph])));
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("🏁 Sync Finalizado.");
});

app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));