require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(helmet());
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

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
async function enviarReporteEmail(tag, dadosCliente, erroDetalhe = null) {

    const destinatario = process.env.EMAIL_DESTINATARIO;
    if (!process.env.EMAIL_USER || !destinatario) return;

    // Evitar spam si no hay datos claros
    if (!dadosCliente) dadosCliente = { nombre: 'Desconocido', phone: 'N/A', cpf_cnpj: 'N/A' };

    console.log(`📧 ENVIANDO REPORTE AHORA (Interacción Detectada): [${tag}]`);

    const htmlContent = `
        <div style="border: 1px solid #d9534f; padding: 20px; font-family: sans-serif;">
            <h2 style="color: #d9534f;">🚨 Transbordo Solicitado: ${tag}</h2>
            <p><strong>Cliente:</strong> ${dadosCliente.nombre || 'N/A'}</p>
            <p><strong>Teléfono:</strong> ${dadosCliente.phone || 'N/A'}</p>
            <p><strong>CPF:</strong> ${dadosCliente.cpf_cnpj || 'N/A'}</p>

            ${erroDetalhe ? `<div style="background:#eee;padding:10px;margin-top:10px;"><strong>Detalle Técnico:</strong><br>${erroDetalhe}</div>` : ''}
            <p style="color: #777; font-size: 12px; margin-top: 20px;">
                Este correo se envió porque el usuario intentó interactuar con el bot y tiene un estado de bloqueo.
            </p>
        </div>`;
        
    const transporter = nodemailer.createTransport({
        service: process.env.EMAIL_SERVICE || 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    try {
        await transporter.sendMail({
            from: `"Bot Cobrança" <${process.env.EMAIL_USER}>`,
            to: destinatario,
            subject: `[TRANSBORDO] ${tag} - ${dadosCliente.phone}`,
            html: htmlContent
        });
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

function saveToCache(phone, cpf, credores, dividas, simulacion, tag, errorDetails = null) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`INSERT OR REPLACE INTO user_cache 
            (phone, cpf, credores_json, dividas_json, simulacion_json, last_updated, last_tag, error_details)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`);
        stmt.run(phone, cpf, JSON.stringify(credores || {}), JSON.stringify(dividas || []),
            JSON.stringify(simulacion || {}), tag, errorDetails, (err) => err ? reject(err) : resolve());
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
    "+525510609610": { "cpf_cnpj": "02637364238", "nombre": "Usuario Default" },
};

async function getAuthToken(cpf_cnpj) {
    const res = await apiAuth.post('/api/Login/v5/Authentication', {
        AppId: process.env.API_APP_ID, AppPass: process.env.API_APP_PASS, Usuario: cpf_cnpj
    });
    return res.data.token || res.data.access_token;
}

// --- 6. SYNC SILENCIOSO (SOLO GUARDA TAGS) ---
async function procesarYGuardarUsuario(phone, userData) {
    try {
        console.log(`🔄 Syncing ${phone}...`);

        let token;
        try {
            token = await getAuthToken(userData.cpf_cnpj);
        } catch (e) {
            // SOLO GUARDAMOS EL TAG, NO ENVIAMOS EMAIL
            const tag = "Transbordo - Usuário não identificado";
            await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, tag, e.message);
            return false;
        }

        // 1. Busca Credores
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` } });

        if (!resCredores.data.credores?.length) {
            const tag = "Transbordo - Credor não encontrado";
            await saveToCache(phone, userData.cpf_cnpj, resCredores.data, [], {}, tag);
            // NO ENVIAMOS EMAIL AQUI
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
            // NO EMAIL
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
                // NO EMAIL
            } else {
                currentTag = "Tag Opções de Pagamento";
            }
        } catch (e) {
            currentTag = "Transbordo - Busca Opções de Pagamento - Erro";
            await saveToCache(phone, userData.cpf_cnpj, resCredores.data, dividasData, {}, currentTag, e.message);
            // NO EMAIL
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
// 🚦 NUEVOS ENDPOINTS SEPARADOS
// ==========================================

// 1. ENDPOINT TRANSBORDO & TAGS
// Maneja registro de tags manuales Y verifica si el usuario está bloqueado
app.post('/api/transbordo', async (req, res) => {
    const { tag, function_call_username } = req.body;
    const rawPhone = function_call_username?.includes("--")
        ? function_call_username.split("--").pop()
        : function_call_username;

    const userData = simulacionDB[rawPhone] || { phone: rawPhone, nombre: "Desconhecido" };

    try {
        // A. Si viene un tag en el body, es un registro manual (ej: "Transbordo - Recusa acordo")
        if (tag) {
            if (tag.toLowerCase().includes("transbordo")) {
                //Reporte
                //await enviarReporteEmail(tag, userData);
            }
            return responder(res, 200, "Tag Registrada", "Tag Registrada", { received: true, tag }, "Tag procesada.", "Tag processada.");
        }

        // B. Si no viene tag, verificamos el estado del usuario en Cache
        const cachedUser = await getFromCache(rawPhone);

        if (!cachedUser) {
            return responder(res, 404, "Usuario No Encontrado", "Usuário Não Encontrado", {},
                "Tus datos no están sincronizados.", "Seus dados não estão sincronizados.");
        }

        // Si hay tag de bloqueo
        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            
            //Reporte
            // await enviarReporteEmail(cachedUser.last_tag, userData, cachedUser.error_details);

            const msgES = `⚠️ He detectado un problema con tu cuenta: **${cachedUser.last_tag}**. He notificado a un asesor humano.`;
            const msgPT = `⚠️ Detectei uma pendência no seu cadastro: **${cachedUser.last_tag}**. Já notifiquei um atendente humano.`;

            return responder(res, 200, "Transbordo Requerido", "Transbordo Necessário",
                { transbordo: true, tag: cachedUser.last_tag }, msgES, msgPT);
        }

        // Si está limpio
        return responder(res, 200, "Estado Normal", "Estado Normal", { transbordo: false }, "Usuario sin bloqueos.", "Usuário sem bloqueios.");

    } catch (e) {
        handleApiError(res, e, "Error Transbordo", "Erro Transbordo");
    }
});

// 2. ENDPOINT BUSCAR CREDORES COMPLETOS (Deudas + Opciones)
app.post('/api/consultar-ofertas', async (req, res) => {
    const { function_call_username,cpf_cnpj } = req.body;
    const rawPhone = function_call_username?.includes("--")
        ? function_call_username.split("--").pop()
        : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);

        if (!cachedUser) {
            return responder(res, 404, "Sin Datos", "Sem Dados", {}, "Usuario no sincronizado.", "Usuário não sincronizado.");
        }
        if(!cachedUser.cpf_cnpj==cpf_cnpj){
            return responder(res,"Introduce el cpf correcto","cpf incorreto",{},"El cpf no corresponde con el numero de telefono","O CPF não corresponde ao número de telefone.");
        }

        // Verificar bloqueo antes de dar info
        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            return responder(res, 200, "Bloqueo", "Bloqueio", { transbordo: true, tag: cachedUser.last_tag },
                `⚠️ Transbordo requerido: ${cachedUser.last_tag}`, `⚠️ Transbordo necessário: ${cachedUser.last_tag}`);
        }

        // Ejecutar lógica completa
        await logicBuscarCredoresCompletos(res, cachedUser);

    } catch (e) {
        handleApiError(res, e, "Error Consultar Ofertas", "Erro Consultar Ofertas");
    }
});

// 3. ENDPOINT EMITIR BOLETO
app.post('/api/emitir-boleto', async (req, res) => {
    const { function_call_username, opt, Parcelas } = req.body;
    const rawPhone = function_call_username?.includes("--")
        ? function_call_username.split("--").pop()
        : function_call_username;

    const userData = simulacionDB[rawPhone] || { phone: rawPhone, nombre: "Desconhecido" };

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return responder(res, 404, "Sin Datos", "Sem Dados", {}, "Error datos.", "Erro dados.");

        // Verificar bloqueo
        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
             
             return responder(res, 200, "Bloqueo", "Bloqueio", { transbordo: true }, "Transbordo requerido.", "Transbordo necessário.");
        }

        await logicEmitirBoleto(req, res, rawPhone, cachedUser, userData);

    } catch (e) {
        handleApiError(res, e, "Error Boleto", "Erro Boleto");
    }
});

// --- LOGICA INTERNA (Separada para ser llamada por los endpoints) ---

// LÓGICA A: Deudas + Opciones
async function logicBuscarCredoresCompletos(res, cachedUser) {
    const dividas = JSON.parse(cachedUser.dividas_json || '[]');
    const sim = JSON.parse(cachedUser.simulacion_json || '{}');
    const opcoes = sim.opcoesPagamento || [];

    let mdES = `**Hola.** He revisado tu estado de cuenta:\n\n`;
    let mdPT = `**Olá.** Verifiquei seu extrato:\n\n`;

    if (dividas.length === 0) {
        mdES = "No encontré deudas pendientes actualmente.";
        mdPT = "Não encontrei dívidas pendentes no momento.";
    } else {
        mdES += `### 📌 Tus Deudas:\n`;
        mdPT += `### 📌 Suas Dívidas:\n`;
        dividas.forEach((d, i) => {
            const detailES = `- **Valor:** R$ ${d.valor}\n  - Contrato: ${d.contratos?.[0]?.numero}\n\n`;
            const detailPT = `- **Valor:** R$ ${d.valor}\n  - Contrato: ${d.contratos?.[0]?.numero}\n\n`;
            mdES += detailES; mdPT += detailPT;
        });
    }

    if (opcoes.length > 0) {
        mdES += `### 💳 Opciones de Pago Disponibles:\n\n`;
        mdPT += `### 💳 Opções de Pagamento Disponíveis:\n\n`;
        opcoes.forEach((op, i) => {
            const val = op.valorTotalComCustas || op.valor;
            const lineES = `🔹 **Opción ${i + 1}:** ${op.texto}\n   (Total a pagar: R$ ${val})\n\n`;
            const linePT = `🔹 **Opção ${i + 1}:** ${op.texto}\n   (Total a pagar: R$ ${val})\n\n`;
            mdES += lineES; mdPT += linePT;
        });
        mdES += `\n**Para formalizar, responde con el número de la opción (ej: "Opción 1").**`;
        mdPT += `\n**Para formalizar, responda com o número da opção (ex: "Opção 1").**`;
    } else if (dividas.length > 0) {
        mdES += `\n⚠️ No encontré ofertas automáticas. Un asesor te ayudará.`;
        mdPT += `\n⚠️ Não encontrei ofertas automáticas. Um atendente irá auxiliar.`;
    }

    responder(res, 200, "Estado de Cuenta y Opciones", "Extrato e Opções",
        { dividas, opcoes, total_deudas: dividas.length }, mdES, mdPT);
}

// LÓGICA B: Emisión (LIVE)
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

        // Re-simular
        const resReSimul = await apiNegocie.post('/api/v5/busca-opcao-pagamento', {
            Crm: credor.crms[0], Carteira: carteiraId, Contratos: contratos,
            DataVencimento: null, ValorEntrada: 0, QuantidadeParcela: targetOp.qtdParcelas, ValorParcela: 0
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        const freshOp = resReSimul.data.opcoesPagamento?.find(o => o.qtdParcelas == targetOp.qtdParcelas);
        if (!freshOp) throw new Error("La opción ya no está disponible.");
        let idBoleto = freshOp.codigo;

        if (resReSimul.data.chamarResumoBoleto) {
            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                Crm: credor.crms[0], CodigoCarteira: carteiraId, CNPJ_CPF: userData.cpf_cnpj,
                Contrato: contratos[0], CodigoOpcao: idBoleto
            }, { headers: { 'Authorization': `Bearer ${token}` } });
            if (resResumo.data.sucesso) idBoleto = resResumo.data.identificador;
            else throw new Error("Fallo en Resumo Boleto");
        }

        const divData = JSON.parse(cachedUser.dividas_json);
        const resEmitir = await apiNegocie.post('/api/v5/emitir-boleto', {
            Crm: credor.crms[0], Carteira: carteiraId, CNPJ_CPF: userData.cpf_cnpj,
            fase: divData[0]?.fase || "", Contrato: contratos[0], Valor: freshOp.valor,
            Parcelas: freshOp.qtdParcelas, DataVencimento: freshOp.dataVencimento,
            Identificador: idBoleto, TipoContrato: null
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        if (!resEmitir.data.sucesso) throw new Error(resEmitir.data.msgRetorno || "Error al emitir boleto.");

        await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, "BOT_BOLETO_GERADO");
        const boleto = resEmitir.data;

        const mdES = `✅ **¡Acuerdo Exitoso!**\n\n📄 Código: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}\n📅 Vence: ${boleto.vcto}`;
        const mdPT = `✅ **Acordo Realizado!**\n\n📄 Linha Digitável: \`${boleto.linhaDigitavel}\`\n💰 Valor: R$ ${boleto.valorTotal}\n📅 Vencimento: ${boleto.vcto}`;

        responder(res, 200, "Boleto Generado", "Boleto Gerado", boleto, mdES, mdPT);

    } catch (error) {
        // ERROR DE EMISIÓN EN TIEMPO REAL: Se envía Email
        const tag = "Transbordo - Erro emissão de boleto";
        
        //reporte
        //await enviarReporteEmail(tag, userData, error.message);
        await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, tag, error.message);

        const errES = "Hubo un error técnico generando el boleto. He notificado al equipo.";
        const errPT = "Houve um erro técnico ao gerar o boleto. Equipe notificada.";
        responder(res, 500, "Error Emisión", "Erro Emissão", { transbordo: true, tag }, errES, errPT);
    }
}

// --- 8. SYNC BATCH OPTIMIZADO (Sin email) ---
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