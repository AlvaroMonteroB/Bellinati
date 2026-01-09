require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { time } = require('console');

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
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'TAGS';
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

const serviceAccountAuth = new JWT({
    email: GOOGLE_CLIENT_EMAIL,
    key: GOOGLE_PRIVATE_KEY ? GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function updateGoogleSheet(phone, cpf, tag) {
    if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL) return;

    try {
        console.log(`📊 [Sheet] Update: ${phone} | CPF: ${cpf} | Tag: ${tag}`);
        const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        
        const sheet = doc.sheetsByTitle[SHEET_NAME] || doc.sheetsByIndex[0];
        if (!sheet) {
            console.error(`❌ Hoja '${SHEET_NAME}' no encontrada.`);
            return;
        }

        // Cargar encabezados
        await sheet.loadHeaderRow();
        const headersEnExcel = sheet.headerValues;

        let columnToMark = null;
        let valueToWrite = "✅"; 

        // Mapeo de Tags a Columnas
        if (tag.toLowerCase().includes("transbordo")) {
            columnToMark = "Tag Transbordo";
            valueToWrite = tag; 
        } 
        else if (tag === "Tag lista dívida") columnToMark = "Tag lista dívida";
        else if (tag === "IA - CPC" || tag === "Tag IA - CPC") columnToMark = "Tag IA - CPC";
        else if (tag === "Tag Opções de Pagamento") columnToMark = "Tag Opções de Pagamento";
        else if (tag === "BOT_BOLETO_GERADO" || tag === "Tag Formalizar Acordo") columnToMark = "Tag Formalizar Acordo";
        else if (tag.includes("Erro - API") || tag.includes("Error")) {
            columnToMark = "Tag Erro - API";
            valueToWrite = tag;
        }
        else if (tag === "Tag Confirmação CPF") columnToMark = "Tag Confirmação CPF";

        if (!columnToMark || !headersEnExcel.includes(columnToMark)) return;

        const rows = await sheet.getRows();
        const targetRow = rows.find(row => String(row.get('Numero')) === String(phone));

        if (targetRow) {
            const updates = { [columnToMark]: valueToWrite };
            // Si tenemos el CPF y la fila no lo tiene (o es diferente), lo actualizamos
            if (cpf) updates['CPF'] = cpf; 
            targetRow.assign(updates);
            await targetRow.save();
        } else {
            // Nueva fila con Numero, CPF y el Tag correspondiente
            const newRowData = { "Numero": phone, "CPF": cpf || "" };
            newRowData[columnToMark] = valueToWrite;
            await sheet.addRow(newRowData);
        }

    } catch (error) {
        console.error("❌ [Sheet Error]:", error.message);
    }
}

// ==========================================
// 🛠️ BASE DE DATOS (SQLite) - ¡MANTENIDA!
// ==========================================
const db = new sqlite3.Database('./cache_negociacion.db');

db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");
    // Tabla completa con acordos_json
    db.run(`CREATE TABLE IF NOT EXISTS user_cache (
        phone TEXT PRIMARY KEY, 
        cpf TEXT, 
        nome TEXT,
        contrato TEXT,
        credores_json TEXT, 
        dividas_json TEXT,
        simulacion_json TEXT, 
        acordos_json TEXT, 
        last_updated DATETIME, 
        last_tag TEXT, 
        error_details TEXT
    )`);
    
    // Migración segura: Intenta agregar la columna 'acordos_json' si no existe
    db.run("ALTER TABLE user_cache ADD COLUMN acordos_json TEXT", (err) => {
        // Ignorar error si la columna ya existe
    });

    db.run("ALTER TABLE user_cache ADD COLUMN contrato TEXT", (err) => {
        // Ignorar error si la columna ya existe
    });

    db.run("ALTER TABLE user_cache ADD COLUMN nome TEXT", (err) => {
        // Ignoramos el error si la columna ya existe
    });
});

// Función unificada para guardar en DB y actualizar Sheet
function saveToCache(phone, cpf, nome, contrato,credores, dividas, simulacion, tag, errorDetails = null, acordos = null) {
    return new Promise((resolve, reject) => {
        // Actualizamos la query SQL para incluir 'nome'
        const stmt = db.prepare(`INSERT OR REPLACE INTO user_cache 
            (phone, cpf, nome, contrato, credores_json, dividas_json, simulacion_json, acordos_json, last_updated, last_tag, error_details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`);
        
        stmt.run(
            phone,                          // 1
            cpf,                            // 2
            nome || null,                   // 3
            contrato || null,               // 4
            JSON.stringify(credores || {}), // 5
            JSON.stringify(dividas || []),  // 6
            JSON.stringify(simulacion || {}), // 7
            JSON.stringify(acordos || []),    // 8 (Este es el que faltaba en el VALUES)
            tag,                            // 9
            errorDetails,                   // 10
            async (err) => {
                if (err) reject(err);
                else {
                    updateGoogleSheet(phone, cpf, tag).catch(e => console.error("Sheet Async Err:", e));
                    resolve();
                }
            }
        );
        stmt.finalize();
    });
}

function getFromCache(phone) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM user_cache WHERE phone = ?", [phone], (err, row) => err ? reject(err) : resolve(row));
    });
}

// ==========================================
// 📡 CONFIGURACIÓN DE RED (AXIOS/EMAIL)
// ==========================================
dns.setDefaultResultOrder('ipv4first');
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
const apiAuth = axios.create({ baseURL: 'https://bpdigital-api.bellinatiperez.com.br', timeout: 30000, httpsAgent });
const apiNegocie = axios.create({ baseURL: 'https://api-negocie.bellinati.com.br', timeout: 30000, httpsAgent });
const autoMailer = axios.create({ baseURL: "https://auto-mailer-delta.vercel.app/", timeout: 30000 }, httpsAgent);

// Simulación DB (Tu lista de usuarios para Sync masivo)
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


"+5519981516633": {"cpf_cnpj" : "29103077861", "nombre": "Usuario test 1337"},


"+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },
"788324039": { "cpf_cnpj": "788324039", "nombre": "Usuario Test 1" },
  "00357155106": { "cpf_cnpj": "00357155106", "nombre": "Usuario Test 2" },
  "432206906": { "cpf_cnpj": "432206906", "nombre": "Usuario Test 3" },
  "1012234983": { "cpf_cnpj": "1012234983", "nombre": "Usuario Test 4" },
  "489302610": { "cpf_cnpj": "00489302610", "nombre": "Usuario Test 5" },
  "01751211509": { "cpf_cnpj": "1751211509", "nombre": "Usuario Test 6" },
  "2505540543": { "cpf_cnpj": "2505540543", "nombre": "Usuario Test 7" },
  "3266177797": { "cpf_cnpj": "3266177797", "nombre": "Usuario Test 8" },
  "4957486921": { "cpf_cnpj": "4957486921", "nombre": "Usuario Test 9" },
  "7651663721": { "cpf_cnpj": "7651663721", "nombre": "Usuario Test 10" },

}; 

// Helper de Respuesta
const responder = (res, statusCode, titleES, titlePT, rawData, mdES, mdPT) => {
    const messageES = mdES || rawData.mensaje || 'Operación completada.';
    const messagePT = mdPT || rawData.mensajePT || messageES;
    res.status(statusCode).json({
        raw: { status: statusCode >= 400 ? 'error' : 'exito', ...rawData },
        markdown: `**${titleES}**\n\n${messageES}`,
        type: "markdown",
        desc: `${messagePT}`
    });
};

async function handleApiError(res, error, titleES, titlePT, extraData = {}) {
    console.error(`❌ [Error] ${titleES}:`, error.message);
    
    responder(res, 200, titleES, titlePT, { error: error.message, ...extraData }, error.message, error.message);
    
}

// Helper Email
async function enviarReporteEmail(raw_phone, tag, dadosCliente, erroDetalhe = null) {
    const destinatario = process.env.EMAIL_DESTINATARIO;
    if (!process.env.EMAIL_USER || !destinatario) return;
    if (!dadosCliente) dadosCliente = { nombre: raw_phone, phone: 'N/A', cpf_cnpj: 'N/A' };

    const htmlContent = `
        <div style="border: 1px solid #d9534f; padding: 20px; font-family: sans-serif;">
            <h2 style="color: #d9534f;">🚨 Transbordo: ${tag}</h2>
            <p><strong>Teléfono:</strong> ${raw_phone || 'N/A'}</p>
            <p><strong>CPF:</strong> ${dadosCliente.cpf_cnpj || 'N/A'}</p>
            ${erroDetalhe ? `<div style="background:#eee;padding:10px;">Error: ${erroDetalhe}</div>` : ''}
        </div>`;

    try {
        await autoMailer.post("send-email", { to: destinatario, subject: `[TRANSBORDO] ${tag}`, text: "", html: htmlContent });
    } catch (e) { console.error('Error email:', e.message); }
}

async function getAuthToken(cpf_cnpj) {
    const res = await apiAuth.post('/api/Login/v5/Authentication', {
        AppId: process.env.API_APP_ID, AppPass: process.env.API_APP_PASS, Usuario: cpf_cnpj
    });
    return res.data.token || res.data.access_token;
}

// ==========================================
// 🔄 LOGICA DE SINCRONIZACIÓN (SYNC) - ¡MANTENIDA!
// ==========================================
async function procesarYGuardarUsuario(phone, userData) {
    try {
        console.log(`🔄 Syncing ${phone}...`);
        
        let token;
        try {
            token = await getAuthToken(userData.cpf_cnpj);
        } catch (e) {
            const tag = "Transbordo - Usuário não identificado";
            await saveToCache(phone, userData.cpf_cnpj,null,null,null, {}, [], {}, tag, e.message);
            return false;
        }

        // 1. Busca Credores
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` } });
        if (!resCredores.data.credores?.length) {
            const tag = "Transbordo - Credor não encontrado";
            await saveToCache(phone, userData.cpf_cnpj,resCredores.data.nome,null, resCredores.data, [], {}, tag);
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
            // Marcamos en Sheet que tiene deuda
            await updateGoogleSheet(phone, userData.cpf_cnpj, "Tag lista dívida");
        } catch (e) {
            const tag = "Transbordo - Listar dividas - Erro";
            await saveToCache(phone, userData.cpf_cnpj,resCredores.nome,dividasData.data[0].numero, resCredores.data, [], {}, tag, e.message);
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
                DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: null, ValorParcela: 0
            }, { headers: { 'Authorization': `Bearer ${token}` } });

            simulacionData = resSimul.data;
            if (!simulacionData.opcoesPagamento?.length) {
                currentTag = "Transbordo - Cliente sem opções de pagamento";
            } else {
                currentTag = "Tag Opções de Pagamento";
            }
        } catch (e) {
            currentTag = "Transbordo - Busca Opções de Pagamento - Erro";
            await saveToCache(phone, userData.cpf_cnpj,resCredores.nome,contratosDocs[0], resCredores.data, dividasData, {}, currentTag, e.message);
            return false;
        }

        // Guardamos todo en caché
        await saveToCache(phone, userData.cpf_cnpj,resCredores.nome,contratosDocs[0], resCredores.data, dividasData, simulacionData, currentTag);
        return true;
    } catch (error) {
        console.error(`❌ Fatal sync error ${phone}:`, error.message);
        return false;
    }
}

// ==========================================
// 🚀 LOGICA EN VIVO (LIVE CHECK)
// ==========================================
async function logicLiveCheck(res, phone, cpf_cnpj) {
    console.log(`📡 Live Check para ${phone} (${cpf_cnpj})`);
    
    // Tag Inicial en Excel
    await updateGoogleSheet(phone, cpf_cnpj, "Tag Confirmação CPF");

    try {
        const token = await getAuthToken(cpf_cnpj);
        
        // 1. Credores
        const resCred = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` } });
        const nombreCliente = resCred.data.nome || null;
        if (!resCred.data.credores?.length) {
            const tag = "Transbordo - Credor não encontrado";
            await saveToCache(phone, cpf_cnpj,nombreCliente,null, resCred.data, [], {}, tag);
            await updateGoogleSheet(phone,cpf_cnpj,tag)
            return responder(
                            res, 
                            200, 
                            "deudor no encontrado", 
                            "Credor não encontrado", 
                            { "tag": "Transbordo - Dados Incompletos" }, 
                            "Credor não encontrado. Transfiriendo a humano (Horario: L-V 08:00-20:40, S 08:00-14:20).", 
                            "Para garantir a segurança e precisão na análise dos seus dados, vou direcionar seu atendimento para um especialista. Nosso time está disponível de segunda a sexta, das 08:00 às 20:40, e aos sábados, das 08:00 às 14:20. Se estivermos dentro do horário de atendimento, aguarde um momento."
                            );
        }

        const credor = resCred.data.credores[0];
        const carteiraInfo = credor.carteiraCrms?.[0];
        const carteiraId = carteiraInfo?.carteiraId || carteiraInfo?.id;

        // 2. Dívida
        let dividasData = [];
        try {
            const resDiv = await apiNegocie.post('/api/v5/busca-divida', 
                { financeira: credor.financeira, crms: credor.crms }, 
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            dividasData = resDiv.data;
            await updateGoogleSheet(phone, cpf_cnpj, "Tag lista dívida");
        } catch (e) {
            const tag = "Transbordo - Listar dividas - Erro";
            await saveToCache(phone, cpf_cnpj,nombreCliente,dividasData.data[0].numero, resCred.data, [], {}, tag, e.message);
            return responder(
                            res, 
                            200, 
                            "Error - Transferencia", 
                            "Erro Técnico - Transferência", 
                            { "tag": "Transbordo - Erro API" }, 
                            "Error al buscar deudas. Se transfiere a humano según disponibilidad.", 
                            "Tivemos um erro técnico ao consultar suas informações. Para te ajudar, vou transferir essa conversa para o nosso atendimento humano. Assim que um especialista estiver livre (dentro do horário: Seg a Sex 08:00-20:40 e Sáb 08:00-14:20), ele falará com você."
                            );
        }

        // 3. Busca Acordo (Nueva lógica solicitada)
        let acordosData = [];
        try {
            const resAcordo = await apiNegocie.post('/api/v5/busca-acordo', 
                { financeira: credor.financeira, crms: credor.crms },
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            acordosData = resAcordo.data;
        } catch (e) {
            console.log("⚠️ Sin acuerdos o error no crítico en busca-acordo");
        }
        contrato=acordosData.contrato.data[0].numero

        // --- ESCENARIO A: YA TIENE ACUERDO ---
        if (acordosData && acordosData.length > 0) {
            const activeAgreement = acordosData[0];
            const tag = "Acordo Existente Encontrado";
            
            // Guardamos todo en cache (incluyendo acuerdos)
            await saveToCache(phone, cpf_cnpj, nombreCliente,contrato,resCred.data, dividasData, {}, tag, null, acordosData);

            const mdES = `⚠️ **¡Ya tienes un acuerdo activo!**\n\n- Valor: R$ ${activeAgreement.valor}\n- Vencimiento: ${activeAgreement.parcelas?.[0]?.dataVencimento}\n\n**¿Deseas emitir la segunda vía del boleto?** (Responde 'Sí' o 'Segunda Via')`;
            const mdPT = `⚠️ Obrigada pela confirmação, ${nombreCliente}!\n Encontrei uma ótima oferta para negociar sua pendência\nNúmero do contrato: ${contrato}\n Valor: R$ ${activeAgreement.valor}\n- Vencimento: ${activeAgreement.parcelas?.[0]?.dataVencimento}\n\n**Deseja emitir a segunda via do boleto?** (Responda 'Sim' ou 'Segunda Via')`;
            
            return responder(res, 200, "Acuerdo Encontrado", "Acordo Encontrado", { 
                existe_acordo: true, 
                acuerdo: activeAgreement 
            }, mdES, mdPT);
        }

        // --- ESCENARIO B: NO HAY ACUERDO (Flujo Normal) ---
        let contratosDocs = [];
        dividasData.forEach(d => d.contratos?.forEach(c => {
            const num = c.numero || c.documento;
            if (num) contratosDocs.push(String(num));
        }));

        let simulacionData = {};
        let currentTag = "Tag Opções de Pagamento";

        try {
            const resSim = await apiNegocie.post('/api/v5/busca-opcao-pagamento', {
                Crm: credor.crms[0], Carteira: carteiraId, Contratos: contratosDocs,
                DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: null, ValorParcela: 0
            }, { headers: { 'Authorization': `Bearer ${token}` } });
            
            simulacionData = resSim.data;
            if (!simulacionData.opcoesPagamento?.length) {
                currentTag = "Transbordo - Cliente sem opções de pagamento";
                await enviarReporteEmail(phone, currentTag, { cpf_cnpj });
                await updateGoogleSheet(phone, cpf_cnpj, "Transbordo - Cliente sem opções de pagamento");
                return responder(
                                res, 
                                200, 
                                "Sin Opciones de Pago", 
                                "Sem Opções de pagamento", 
                                { "tag": "Transbordo - Sem Opções" }, 
                                "No se encontraron opciones de pago. Se transfiere a humano según disponibilidad.", 
                                "Não encontrei propostas de negociação automática disponíveis para o seu caso neste momento. Por isso, vou transferir você para o atendimento humano. Caso um de nossos especialistas esteja livre agora (dentro do horário: Seg a Sex 08:00-20:40, Sáb 08:00-14:20), ele dará continuidade ao seu atendimento."
                                );
            } else{
                await updateGoogleSheet(phone, cpf_cnpj, "Tag Opções de Pagamento");
            }
        } catch (e) {
            currentTag = "Transbordo - Busca Opções de Pagamento - Erro";
            await saveToCache(phone, cpf_cnpj, resCred.data, dividasData, {}, currentTag, e.message);
            return responder(
                            res, 
                            200, 
                            "Error Calculando Opciones", 
                            "Erro no Cálculo", 
                            { "tag": "Transbordo - Erro Calculo" }, 
                            "Error al calcular opciones. Se transfiere a humano según disponibilidad.", 
                            "Houve uma falha técnica ao calcular as opções de parcelamento automaticamente. Para não te deixar sem resposta, vou transferir você para o atendimento humano. Caso um especialista esteja livre (dentro do horário: Seg a Sex 08:00-20:40, Sáb 08:00-14:20), ele te ajudará a concluir a negociação."
                            );
        }

        await saveToCache(phone, cpf_cnpj, resCred.data, dividasData, simulacionData, currentTag);
        
        return logicMostrarOfertas(res, { 
            dividas_json: JSON.stringify(dividasData), //Cambiar aqui
            simulacion_json: JSON.stringify(simulacionData) 
        });

    } catch (error) {
        const tag = "Transbordo - Erro Genérico";
        await saveToCache(phone, cpf_cnpj, {}, [], {}, tag, error.message);
        await enviarReporteEmail(phone, tag, { cpf_cnpj }, error.message);
        handleApiError(res, error, "Error Live Check", "Erro Live Check");
    }
}

// ==========================================
// 🚦 ENDPOINTS DEL SERVIDOR
// ==========================================

// 1. LIVE CHECK (Entrada Principal para nuevos usuarios)
app.post('/api/live-check', async (req, res) => {
    const { function_call_username, cpf_cnpj } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    if (!cpf_cnpj) return responder(res, 200, "Falta CPF", "Falta CPF", {}, "Por favor envía tu CPF.", "Por favor envie seu CPF.");

    try {
        const cachedUser = await getFromCache(rawPhone);
        
        // A. SI YA EXISTE EN CACHE Y CPF COINCIDE -> USAR CACHE
        if (cachedUser && cachedUser.cpf === cpf_cnpj) {
            console.log("⚡ Usuario en cache, retornando datos locales.");
            
            if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
                return responder(
                                    res, 
                                    200, 
                                    "Bloqueo - Transferencia Activa", 
                                    "Aguardando Especialista", 
                                    { transbordo: true, tag: cachedUser.last_tag }, 
                                    "El usuario ya fue transferido. Bloqueando interacción automática.", 
                                    "Seu atendimento já foi transferido para um de nossos especialistas. Por favor, aguarde um momento que em breve alguém falará com você por aqui."
                                    );
            }
            
            const acordos = JSON.parse(cachedUser.acordos_json || '[]');
            if (acordos.length > 0) {
                 const activeAgreement = acordos[0]; // Obtenemos el acuerdo completo del cache
                 
                 // Construimos el mensaje detallado igual que en Live Check
                 const mdES = `⚠️ **¡Ya tienes un acuerdo activo!**\n\n- Valor: R$ ${activeAgreement.valor}\n- Vencimiento: ${activeAgreement.parcelas?.[0]?.dataVencimento}\n\n**¿Deseas emitir la segunda vía del boleto?** (Responde 'Sí' o 'Segunda Via')`;
                 const mdPT = `⚠️ Obrigada pela confirmação ${cachedUser.nome}\nEncontrei uma ótima oferta para negociar sua pendência:\n- Valor: R$ ${activeAgreement.valor}\n- Vencimento: ${activeAgreement.parcelas?.[0]?.dataVencimento}\n\n**Deseja emitir a segunda via do boleto?** (Responda 'Sim' ou 'Segunda Via')`;
                 
                 return responder(res, 200, "Acuerdo Encontrado", "Acordo Encontrado", { 
                     existe_acordo: true, 
                     acuerdo: activeAgreement 
                 }, mdES, mdPT);
            }

            return logicMostrarOfertas(res, cachedUser);
        }

        // B. SI NO EXISTE -> LLAMADA EN VIVO
        await logicLiveCheck(res, rawPhone, cpf_cnpj);

    } catch (e) {
        await enviarReporteEmail(rawPhone,"Tag Erro - API",{cpf_cnpj},e.message)
        handleApiError(res, e, "Error Check", "Erro Check");
    }
});

// 2. TRANSBORDO (Manual o Verificación)
app.post('/api/transbordo', async (req, res) => {
    const { tag, function_call_username } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;
    
    // Intentar recuperar CPF si existe, si no, solo el teléfono
    const cachedUser = await getFromCache(rawPhone);
    const cpf = cachedUser ? cachedUser.cpf : null;

    try {
        if (tag) {
            // Registro Manual
            if (tag.toLowerCase().includes("transbordo")) await enviarReporteEmail(rawPhone, tag, { cpf_cnpj: cpf });
            await saveToCache(rawPhone, cpf, null, null, null, tag);
            return responder(
                            res, 
                            200, 
                            "Transferencia Solicitada", 
                            "", 
                            { received: true, tag }, 
                            "Usuario solicitó humano. Transfiriendo según horario y disponibilidad.", 
                            "Compreendo. Vou direcionar seu atendimento para um de nossos especialistas. Caso um atendente esteja livre (dentro do horário: Seg a Sex 08:00-20:40, Sáb 08:00-14:20), ele dará continuidade à sua solicitação por aqui."
                            );
        }

        // Verificación de Estado
        if (!cachedUser) return responder(res, 200, "No encontrado", "Não encontrado", {}, "Datos no sync.", "Dados não sync.");

        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            await enviarReporteEmail(rawPhone, cachedUser.last_tag, { cpf_cnpj: cpf }, cachedUser.error_details);
            return responder(res, 200, "Transbordo", "Transbordo", { transbordo: true, tag: cachedUser.last_tag }, "Transbordo necesario.", "Transbordo necessário.");
        }

        return responder(res, 200, "OK", "OK", { transbordo: false }, "OK", "OK");
    } catch (e) {
        handleApiError(res, e, "Error Transbordo", "Erro Transbordo");
    }
});

// 3. EMITIR BOLETO (Nueva y Segunda Vía)
app.post('/api/emitir-boleto', async (req, res) => {
    const { function_call_username, opt, Parcelas, segunda_via } = req.body;
    const rawPhone = function_call_username?.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return responder(res, 200, "Sin Datos", "Sem Dados", {}, "Error datos.", "Erro dados.");

        // A. SEGUNDA VÍA
        if (segunda_via) {
            const acordos = JSON.parse(cachedUser.acordos_json || '[]');
            if (acordos.length === 0) return responder(res, 200, "Sin Acuerdo", "Sem Acordo", {}, "No hay acuerdo activo.", "Não há acordo ativo.");
            
            const acordo = acordos[0];
            const token = await getAuthToken(cachedUser.cpf);
            
            const payload2Via = {
                "Crm": acordo.crm,
                "CodigoCarteira": acordo.codCarteira, 
                "Fase": acordo.fase || "",
                "CNPJ_CPF": cachedUser.cpf,
                "Contrato": acordo.contrato?.[0]?.numero,
                "DataVencimento": acordo.parcelas?.[0]?.dataVencimento,
                "Id": acordo.idAcordo,
                "NossoNumero": "",
                "QuantidadeParcela": acordo.quantidadeParcelas,
                "ValorBoleto": acordo.valor,
                "TipoBoleto": "2"
            };

            const res2Via = await apiNegocie.post('/api/v5/emitir-boleto-segunda-via', payload2Via, { 
                headers: { 'Authorization': `Bearer ${token}` } 
            });

            if (!res2Via.data.sucesso) throw new Error(res2Via.data.msgRetorno || "Error 2a Via");

            const boleto = res2Via.data;
            const mdES = `✅ 📄 Línea: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}`;
            const mdPT = `✅ \n\n📄 Linha: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}`;
            
            await updateGoogleSheet(rawPhone, cachedUser.cpf, "BOT_BOLETO_GERADO");
            return responder(res, 200, "2a Via OK", "2a Via OK", boleto, mdES, mdPT);
        }

        // B. EMISIÓN NUEVA
        await logicEmitirBoletoNuevo(req, res, rawPhone, cachedUser);

    } catch (e) {
        console.log("Entrando al error de la api de segunda via")
        query= await getFromCache(rawPhone)
        cpf= query.cpf
        await updateGoogleSheet(rawPhone, cpf, "Tag Erro - API");
        await enviarReporteEmail(rawPhone,"Tag Erro - API",{ cpf_cnpj:cpf },e.message)
        handleApiError(res, {message:"Ocorreu um erro ao tentar gerar seu boleto, Um atendente humano entrará em contato com você assim que estiver disponível."}, "Error Boleto", "Erro Boleto segunda via");
    }
});

app.post('/api/admin/clear-db', (req, res) => {
    // 1. Pequeña medida de seguridad para evitar accidentes
    const { confirmacion } = req.body;
    
    if (confirmacion !== "SI_ESTOY_SEGURO") {
        return res.status(400).json({ 
            status: 'error', 
            message: "Falta confirmación de seguridad. Envía { 'confirmacion': 'SI_ESTOY_SEGURO' }" 
        });
    }

    // 2. Ejecutar el borrado (DELETE FROM borra datos, mantiene estructura)
    db.run("DELETE FROM user_cache", function(err) {
        if (err) {
            console.error("❌ Error al limpiar DB:", err.message);
            return res.status(500).json({ status: 'error', message: err.message });
        }

        // 3. Compactar la base de datos (opcional, libera espacio en disco)
        db.run("VACUUM", () => {
            console.log(`🗑️ Base de datos limpiada. ${this.changes} filas eliminadas.`);
            
            res.json({
                status: 'exito',
                message: `Base de datos limpiada correctamente.`,
                filas_eliminadas: this.changes
            });
        });
    });
});

// 4. SYNC MASIVO (Restaurado)
app.post('/api/admin/sync', async (req, res) => {
    const phones = Object.keys(simulacionDB);
    const BATCH_SIZE = 1;
    console.log(`🚀 Sync Masivo (${phones.length} usuarios)`);
    res.json({ msg: "Sync iniciado", total: phones.length });

    const chunkArray = (arr, size) => {
        const res = [];
        for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
        return res;
    };
    
    // Procesamos en lotes
    const batches = chunkArray(phones, BATCH_SIZE);
    for (const batch of batches) {
        await Promise.all(batch.map(ph => procesarYGuardarUsuario(ph, simulacionDB[ph])));
        // Pequeña pausa para no saturar
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("🏁 Sync Finalizado.");
});

// --- LOGICA DE RESPUESTA & EMISIÓN NUEVA ---
async function logicMostrarOfertas(res, cachedUser) {
    const dividas = JSON.parse(cachedUser.dividas_json || '[]');
    const sim = JSON.parse(cachedUser.simulacion_json || '{}');
    const opcoes = sim.opcoesPagamento || [];

    let mdES = `Estado de cuenta:\n\n`;
    let mdPT = `Extrato:\n\n`;

    dividas.forEach(d => {
        mdES += `- R$ ${d.valor} (Contrato: ${d.contratos?.[0]?.numero})\n`;
        mdPT += `- R$ ${d.valor} (Contrato: ${d.contratos?.[0]?.numero})\n`;
    });

    if (opcoes.length > 0) {
        mdES += `\n**Opciones:**\n`; mdPT += ``;
        opcoes.forEach((op, i) => {
            const val = op.valorTotalComCustas || op.valor;
            mdES += `${i + 1}. ${op.texto} (R$ ${val})\n`;
            mdPT += `${i + 1}. ${op.texto} (R$ ${val})\n`;
        });
    }

    responder(res, 200, "Ofertas", "Ofertas", { dividas, opcoes }, mdES, mdPT);
}

async function logicEmitirBoletoNuevo(req, res, phone, cachedUser) {
    const { opt, Parcelas } = req.body;
    try {
        const simCache = JSON.parse(cachedUser.simulacion_json);
        const opcoes = simCache.opcoesPagamento || [];
        
        let targetOp;
        if (opt) targetOp = opcoes[parseInt(opt) - 1];
        else if (Parcelas) targetOp = opcoes.find(o => o.qtdParcelas == Parcelas);

        if (!targetOp) return responder(res, 200, "Inválido", "Inválido", {}, "Opción inválida.", "Opção inválida.");

        const token = await getAuthToken(cachedUser.cpf);
        const credoresData = JSON.parse(cachedUser.credores_json);
        const credor = credoresData.credores[0];
        const carteiraId = credor.carteiraCrms[0].carteiraId || credor.carteiraCrms[0].id;
        const contratos = targetOp.contratos || [];

        // Re-simular para obtener ID fresco
        const resReSimul = await apiNegocie.post('/api/v5/busca-opcao-pagamento', {
            Crm: credor.crms[0], Carteira: carteiraId, Contratos: contratos,
            DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: targetOp.qtdParcelas, ValorParcela: 0
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        const freshOp = resReSimul.data.opcoesPagamento?.find(o => o.qtdParcelas == targetOp.qtdParcelas);
        let idBoleto = freshOp.codigo;

        if (resReSimul.data.chamarResumoBoleto) {
            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                Crm: credor.crms[0], CodigoCarteira: carteiraId, CNPJ_CPF: cachedUser.cpf,
                Contrato: contratos[0], CodigoOpcao: idBoleto
            }, { headers: { 'Authorization': `Bearer ${token}` } });
            if (resResumo.data.sucesso) idBoleto = resResumo.data.identificador;
        }

        const resEmitir = await apiNegocie.post('/api/v5/emitir-boleto', {
            Crm: credor.crms[0], Carteira: carteiraId, CNPJ_CPF: cachedUser.cpf,
            fase: JSON.parse(cachedUser.dividas_json)[0]?.fase || "", 
            Contrato: contratos[0], Valor: freshOp.valor, 
            Parcelas: freshOp.qtdParcelas, DataVencimento: freshOp.dataVencimento,
            Identificador: idBoleto, TipoContrato: null
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        if (!resEmitir.data.sucesso) throw new Error(resEmitir.data.msgRetorno);

        await updateGoogleSheet(phone, cachedUser.cpf, "BOT_BOLETO_GERADO");
        const boleto = resEmitir.data;
        
        const mdES = `✅ Code: \`${boleto.linhaDigitavel}\`\nValor: R$ ${boleto.valorTotal}`;
        const mdPT = `✅ Linha: \`${boleto.linhaDigitavel}\`\nValor: R$ ${boleto.valorTotal}`;
        
        responder(res, 200, "Boleto", "Boleto", boleto, mdES, mdPT);

    } catch (error) {
        const tag = "Transbordo - Erro emissão de boleto";
        await enviarReporteEmail(phone, tag, { cpf_cnpj: cachedUser.cpf }, error.message);
        await saveToCache(phone, cachedUser.cpf, {}, [], {}, tag, error.message);
        responder(res, 200, "Error Emisión", "Erro Emissão", { transbordo: true }, "Error técnico.", "Erro técnico.");
    }
}

app.listen(PORT, HOST, () => console.log(`Server running on ${HOST}:${PORT}`));


    
    //00109396103
    