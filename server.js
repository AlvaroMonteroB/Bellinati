require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const https = require('https');
const dns = require('dns');
const sqlite3 = require('sqlite3').verbose();
const { exec } = require('child_process');
const fs = require('fs');
const nodemailer = require('nodemailer'); // 1. IMPORTAR NODEMAILER

const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// --- CONFIGURACIÓN DE E-MAIL (NODEMAILER) ---
const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Helper para enviar e-mail de reporte/transbordo
async function enviarReporteEmail(tag, dadosCliente, erroDetalhe = null) {
    const destinatario = process.env.EMAIL_DESTINATARIO;
    
    if (!process.env.EMAIL_USER || !destinatario) {
        console.warn('⚠️ Credenciais de e-mail não configuradas. Reporte não enviado.');
        return;
    }

    const htmlContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; border: 1px solid #ddd; padding: 20px;">
            <h2 style="color: #d9534f;">🚨 Alerta de Transbordo / Erro</h2>
            <p>O sistema detectou um cenário que requer atenção ou intervenção humana.</p>
            
            <div style="background-color: #f9f9f9; padding: 15px; margin-bottom: 20px; border-left: 5px solid #d9534f;">
                <strong>TAG / CENÁRIO:</strong><br>
                <span style="font-size: 18px; color: #d9534f;">${tag}</span>
            </div>

            <h3>👤 Dados do Cliente</h3>
            <ul style="list-style: none; padding: 0;">
                <li><strong>Telefone:</strong> ${dadosCliente.phone || 'N/A'}</li>
                <li><strong>CPF:</strong> ${dadosCliente.cpf || 'N/A'}</li>
                <li><strong>Nome :</strong> ${dadosCliente.nome || 'N/A'}</li>
            </ul>

            ${erroDetalhe ? `
            <h3>🛠️ Detalhes Técnicos</h3>
            <pre style="background: #eee; padding: 10px; overflow-x: auto;">${erroDetalhe}</pre>
            ` : ''}

            <p style="font-size: 12px; color: #777; margin-top: 30px;">
                Mensagem gerada automaticamente pelo Servidor de Negociação (IA).
            </p>
        </div>
    `;

    const mailOptions = {
        from: `"Sistema Negociação IA" <${process.env.EMAIL_USER}>`,
        to: destinatario,
        subject: `[${tag}] - Cliente ${dadosCliente.phone}`,
        html: htmlContent
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 E-mail de reporte enviado: ${tag} para ${destinatario}`);
    } catch (error) {
        console.error('❌ Falha ao enviar e-mail:', error.message);
    }
}

// --- CONFIGURACIÓN DE BASE DE DATOS CACHÉ ---
const db = new sqlite3.Database('./cache_negociacion.db');

db.serialize(() => {
    // 1. Crear tabla base si no existe
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

    // 2. Migración: Asegurar que existan las columnas de TAGS y ERRORES
    const colunasNovas = [
        { nome: 'last_tag', tipo: 'TEXT' },
        { nome: 'error_details', tipo: 'TEXT' }
    ];

    colunasNovas.forEach(col => {
        db.run(`ALTER TABLE user_cache ADD COLUMN ${col.nome} ${col.tipo}`, (err) => {
            // Ignoramos el error si la columna ya existe
            if (!err) {
                console.log(`✅ Columna '${col.nome}' añadida a la tabla user_cache.`);
            }
        });
    });
});

// Helper para guardar en BD con TAGS
function saveToCache(phone, cpf, credores, dividas, simulacion, tag = "IA - ACORDO", errorDetails = null) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO user_cache (phone, cpf, credores_json, dividas_json, simulacion_json, last_updated, last_tag, error_details)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        `);
        stmt.run(
            phone, 
            cpf, 
            JSON.stringify(credores || {}), 
            JSON.stringify(dividas || []), 
            JSON.stringify(simulacion || {}), 
            tag, 
            errorDetails, 
            (err) => {
                if (err) reject(err);
                else resolve();
            }
        );
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

// --- AUTH ---
async function getAuthToken(cpf_cnpj) {
    const response = await apiAuth.post('/api/Login/v5/Authentication', {
        AppId: process.env.API_APP_ID,
        AppPass: process.env.API_APP_PASS,
        Usuario: cpf_cnpj
    });
    return response.data.token || response.data.access_token;
}

// --- FUNÇÃO DE SINCRONIZAÇÃO INTELIGENTE (COM GESTÃO DE TAGS E E-MAIL) ---
async function procesarYGuardarUsuario(phone, userData) {
    try {
        console.log(`🔄 Procesando ${phone} (${userData.cpf_cnpj})...`);
        
        let token;
        try {
            token = await getAuthToken(userData.cpf_cnpj);
        } catch (e) {
            console.error(`❌ Erro Auth para ${phone}`);
            const tag = "Transbordo - Usuário não identificado";
            await saveToCache(phone, userData.cpf_cnpj, {}, [], {}, tag, e.message);
            await enviarReporteEmail(tag, { phone, ...userData }, e.message);
            return false;
        }

        // 1. Busca Credores
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const credoresData = resCredores.data;
        
        if (!credoresData.credores?.length) {
            const tag = "Transbordo - Credor não encontrado";
            console.log(`⚠️ ${tag} para ${phone}`);
            // Guardamos con la etiqueta de transbordo para que el bot sepa qué hacer
            await saveToCache(phone, userData.cpf_cnpj, credoresData, [], {}, tag, "Lista de credores vazia");
            await enviarReporteEmail(tag, { phone, ...userData });
            return true;
        }

        const credor = credoresData.credores[0];
        const carteiraInfo = credor.carteiraCrms?.[0];
        const carteiraId = carteiraInfo?.carteiraId || carteiraInfo?.id;

        // 2. Busca Deuda Detallada
        let dividasData = [];
        try {
            const bodyDivida = { financeira: credor.financeira, crms: credor.crms };
            const resDividas = await apiNegocie.post('/api/v5/busca-divida', bodyDivida, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            dividasData = resDividas.data;
        } catch (e) {
            const tag = "Transbordo - Listar dividas - Erro";
            console.error(`❌ ${tag} para ${phone}`);
            await saveToCache(phone, userData.cpf_cnpj, credoresData, [], {}, tag, e.message);
            await enviarReporteEmail(tag, { phone, ...userData }, e.message);
            return false;
        }

        // Tag de sucesso parcial (Conseguiu listar dívida)
        let currentTag = "IA - CPC"; 

        // 3. Simula Opciones
        let contratosDocs = [];
        dividasData.forEach(d => d.contratos?.forEach(c => {
            const numContrato = c.numero || c.documento;
            if (numContrato) contratosDocs.push(String(numContrato));
        }));

        let simulacionData = {};
        try {
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
            simulacionData = resSimulacion.data;

            if (!simulacionData.opcoesPagamento || simulacionData.opcoesPagamento.length === 0) {
                // Si llegamos hasta aquí pero no hay opciones, es otro tipo de transbordo
                currentTag = "Transbordo - Cliente sem opções de pagamento";
                await enviarReporteEmail(currentTag, { phone, ...userData });
            }

        } catch (e) {
            // Si falla la simulación, marcamos el error pero guardamos las deudas que ya obtuvimos
            currentTag = "Transbordo - Busca Opções de Pagamento - Erro";
            console.error(`❌ ${currentTag} para ${phone}`);
            await saveToCache(phone, userData.cpf_cnpj, credoresData, dividasData, {}, currentTag, e.message);
            await enviarReporteEmail(currentTag, { phone, ...userData }, e.message);
            return false;
        }

        // 4. Guardar Éxito (o Transbordo de Opciones)
        await saveToCache(phone, userData.cpf_cnpj, credoresData, dividasData, simulacionData, currentTag);
        console.log(`✅ ${phone} processado com tag: ${currentTag}`);
        return true;

    } catch (error) {
        console.error(`❌ Erro genérico processando ${phone}:`, error.message);
        return false;
    }
}

// --- HELPER CONTEXTO REAL ---
async function obtenerContextoDeudaReal(rawPhone) {
    const userData = simulacionDB[rawPhone]; 
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
            const numContrato = c.numero || c.documento;
            if (numContrato) contratosDocs.push(String(numContrato));
        });
    });

    return { token, cpf_cnpj: userData.cpf_cnpj, Crm: credor.crms[0], Carteira: carteiraId, fase, Contratos: contratosDocs, userData };
}

// --- HELPERS ---
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

// ==========================================
// 🛠️ ADMIN: LOGS PM2
// ==========================================
app.post('/api/admin/server-logs', (req, res) => {
    const lines = req.body.lines || 50; 
    exec('pm2 jlist', (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: "Error PM2", details: stderr });
        try {
            const processes = JSON.parse(stdout);
            const currentPmId = process.env.pm_id;
            const targetProcess = processes.find(p => p.pm_id == currentPmId) || processes[0];
            if (!targetProcess) return res.status(404).json({ error: "No PM2 process found." });

            const outLogPath = targetProcess.pm2_env.pm_out_log_path;
            const errLogPath = targetProcess.pm2_env.pm_err_log_path;
            const command = `tail -n ${lines} "${outLogPath}" && echo "\n--- ERROR LOGS ---\n" && tail -n ${lines} "${errLogPath}"`;

            exec(command, (readErr, readStdout, readStderr) => {
                if (readErr) return res.status(500).json({ error: "Error reading logs", details: readStderr });
                res.json({ logs: readStdout });
            });
        } catch (e) { res.status(500).json({ error: "Parse Error" }); }
    });
});

// ==========================================
// 🚦 DISPATCHER
// ==========================================
app.post('/api/chat-handler', async (req, res) => {
    try {
        const body = req.body;
        console.log("📨 Payload:", JSON.stringify(body));

        if (body.cpf_cnpj) return await logicBuscarCredores(req, res);
        if (body.msg) return await logicBuscarOpcoes(req, res);
        if (body.accion === "resumo") return await logicResumoBoleto(req, res);
        if (body.opt || body.accion === "emitir" || (body.Parcelas && body.DataVencimento)) {
            return await logicEmitirBoleto(req, res);
        }
        if(body.tag) {
            tag=body.tag
            var data = new Object();
            data.phone=body.function_call_username.split("--").pop()
            aux=simulacionDB[data.phone]
            data.nome=aux.nombre
            return await enviarReporteEmail(body.tag,data)
        }


        return responder(res, 400, "Error", "Erro", {}, "No entendí tu solicitud.", "Não entendi.");
    } catch (error) {
        console.error("Error handler:", error);
        return handleApiError(res, error, "Error Interno", "Erro Interno");
    }
});

// Lógica A: Buscar Credores (Com verificação de Transbordo)
async function logicBuscarCredores(req, res) {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) {
            return res.status(404).json({ error: "Usuario no sincronizado. Ejecute sync-database." });
        }

        // VERIFICAÇÃO DE TRANSBORDO / ERRO PRÉVIO
        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            const md_err = `⚠️ **Atenção:** Detectamos um problema com seu cadastro: **${cachedUser.last_tag}**.\n\nPor favor, aguarde enquanto transferimos para um atendente humano.`;
            return responder(res, 200, "Transbordo Necessário", "Transbordo Necessário", { tag: cachedUser.last_tag, transbordo: true }, md_err, md_err);
        }

        const dividasData = JSON.parse(cachedUser.dividas_json);
        const fecha = new Date(cachedUser.last_updated).toLocaleString();
        
        let md_es = `**Hola.** Tus deudas (al ${fecha}):\n\n`;
        let md_pt = `**Olá.** Suas dívidas (em ${fecha}):\n\n`;
        
        if (dividasData?.length > 0) {
            dividasData.forEach((deuda, i) => {
                md_es += `### 💰 Deuda ${i + 1}: R$ ${deuda.valor}\n`;
                md_pt += `### 💰 Dívida ${i + 1}: R$ ${deuda.valor}\n`;
                deuda.contratos?.forEach(c => {
                    md_es += `- Producto: ${c.produto}\n  - 📄 Contrato: ${c.numero || c.documento}\n  - 📅 **Días de Atraso:** ${c.diasAtraso}\n  - 💲 Valor Original: R$ ${c.valor}\n`;
                    md_pt += `- Produto: ${c.produto}\n  - 📄 Contrato: ${c.numero || c.documento}\n  - 📅 **Dias de Atraso:** ${c.diasAtraso}\n  - 💲 Valor Original: R$ ${c.valor}\n`;
                });
                md_es += `\n`; md_pt += `\n`;
            });
            md_pt += `Poderia explicar por que não pagou sua dívida?\n`; 
        } else {
            // Caso raro onde não há erro explícito mas a lista está vazia
            md_es += "No se encontraron deudas."; md_pt += "Nenhuma dívida encontrada.";
        }

        return responder(res, 200, "Deudas", "Dívidas", { detalle: dividasData }, md_es, md_pt);
    } catch (error) {
        return handleApiError(res, error, "Error datos", "Erro dados");
    }
}

// Lógica B: Buscar Opciones
async function logicBuscarOpcoes(req, res) {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return res.status(404).json({ error: "No data." });

        if (cachedUser.last_tag && cachedUser.last_tag.startsWith("Transbordo")) {
            const md_err = `⚠️ Não foi possível carregar as opções devido a um erro anterior (${cachedUser.last_tag}). Transferindo para humano...`;
            return responder(res, 200, "Erro Opções", "Erro Opções", { tag: cachedUser.last_tag, transbordo: true }, md_err, md_err);
        }

        const simData = JSON.parse(cachedUser.simulacion_json);
        let md_es = "Opciones de pago:\n\n";
        let md_pt = "Opções de pagamento:\n\n";

        if (simData.opcoesPagamento) {
            simData.opcoesPagamento.forEach((op, idx) => {
                md_es += `**Opción ${idx + 1}**: ${op.texto}\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
                md_pt += `**Opção ${idx + 1}**: ${op.texto}\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
            });
        } else {
            md_es = "No hay opciones disponibles. Transferencia a humano requerida.";
            md_pt = "Não há opções disponíveis. Transferência para humano necessária.";
        }

        return responder(res, 200, "Opciones", "Opções", simData, md_es, md_pt);
    } catch (error) {
        return handleApiError(res, error, "Error opciones", "Erro opções");
    }
}

async function logicResumoBoleto(req, res) {
    return responder(res, 200, "Endpoint Auxiliar", "Auxiliar", { msg: "Use emitir con opt" });
}

// D. Emitir Boleto (Real-time com Transbordo em Falha)
async function logicEmitirBoleto(req, res) {
    const { function_call_username, opt, Parcelas, DataVencimento } = req.body;
    
    if (!opt && !Parcelas) return responder(res, 400, "Falta Opción", "Falta Opção", {}, "Selecciona una opción.", "Selecione uma opção.");

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        console.log(`🚀 Iniciando emissão REAL para ${rawPhone}...`);

        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser || !cachedUser.simulacion_json) {
            return responder(res, 400, "Sesión Caducada", "Sessão Expirada", {}, "Recarrege.", "Recarregue.");
        }
        
        const simulacionData = JSON.parse(cachedUser.simulacion_json);
        const opciones = simulacionData.opcoesPagamento || [];
        
        let parcelasFinal, dataVencFinal, valorFinal;
        
        if (opt) {
            const index = parseInt(opt) - 1;
            if (index < 0 || index >= opciones.length) {
                return responder(res, 400, "Opción Inválida", "Opção Inválida", {}, "Opção inexistente.", "Opção inexistente.");
            }
            const opcionElegida = opciones[index];
            parcelasFinal = opcionElegida.qtdParcelas;
            dataVencFinal = opcionElegida.dataVencimento;
            valorFinal = opcionElegida.valor;
        } else {
            parcelasFinal = Parcelas;
            dataVencFinal = DataVencimento;
            const op = opciones.find(o => o.qtdParcelas == Parcelas);
            if(op) {
                valorFinal = op.valor;
            } else {
                return responder(res, 400, "Opção Não Encontrada", "Opção Não Encontrada", {}, "Qtd parcelas inválida.", "Qtd parcelas inválida.");
            }
        }

        const ctx = await obtenerContextoDeudaReal(rawPhone);

        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.Contratos,
            DataVencimento: null, 
            ValorEntrada: 0,
            QuantidadeParcela: parcelasFinal, 
            ValorParcela: 0
        };
        
        const resReSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });
        
        const opcionFresca = resReSimulacion.data.opcoesPagamento?.find(o => o.qtdParcelas == parcelasFinal);
        if (!opcionFresca) throw new Error("Opção não disponível na re-simulação.");
        
        let idParaEmitir = opcionFresca.codigo;

        if (resReSimulacion.data.chamarResumoBoleto) {
            try {
                const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                    Crm: ctx.Crm,
                    CodigoCarteira: ctx.Carteira,
                    CNPJ_CPF: ctx.cpf_cnpj,
                    Contrato: ctx.Contratos[0], 
                    CodigoOpcao: idParaEmitir
                }, { headers: { 'Authorization': `Bearer ${ctx.token}` } });

                if (resResumo.data && resResumo.data.sucesso && resResumo.data.identificador) {
                    idParaEmitir = resResumo.data.identificador;
                }
            } catch (errResumo) {
                throw new Error(`Falha no Resumo Boleto: ${errResumo.message}`);
            }
        }

        const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            CNPJ_CPF: ctx.cpf_cnpj,
            fase: ctx.fase,
            Contrato: ctx.Contratos[0],
            Valor: valorFinal,
            Parcelas: parcelasFinal,
            DataVencimento: dataVencFinal, 
            Identificador: idParaEmitir,
            TipoContrato: null
        }, { headers: { 'Authorization': `Bearer ${ctx.token}` } });

        if (!resEmision.data || !resEmision.data.sucesso || !resEmision.data.linhaDigitavel) {
            throw new Error("API retornou sucesso:false ou sem linha digitável.");
        }

        const md_es = `¡Listo! Boleto generado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimiento**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        const md_pt = `Pronto! Boleto gerado.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimento**: ${resEmision.data.vcto}\n` +
                      `**Código**: \`${resEmision.data.linhaDigitavel}\``;

        // TAG FINAL DE SUCESSO
        await saveToCache(rawPhone, ctx.cpf_cnpj, null, null, null, "IA - ACORDO");
        
        return responder(res, 201, "Boleto Emitido", "Boleto Gerado", resEmision.data, md_es, md_pt);

    } catch (error) {
        // --- MANEJO DE ERRORES DE EMISIÓN ---
        const tag = "Transbordo - Erro emissão de boleto";
        console.error(`❌ ${tag} para ${rawPhone}`);
        const userData = simulacionDB[rawPhone] || { phone: rawPhone };
        
        // Guardamos el error en BD y enviamos Email
        await saveToCache(rawPhone, userData.cpf_cnpj, {}, [], {}, tag, error.message);
        await enviarReporteEmail(tag, userData, error.message);
        
        const msgError = "Tivemos um problema técnico ao gerar seu boleto. Estou transferindo para um atendente humano finalizar.";
        return responder(res, 500, "Erro Emissão", "Erro Emissão", { error: error.message, transbordo: true }, msgError, msgError);
    }
}

app.post('/api/admin/sync-database', async (req, res) => {
    res.json({ status: "Sync started" });
    const phones = Object.keys(simulacionDB);
    for (const phone of phones) {
        await procesarYGuardarUsuario(phone, simulacionDB[phone]);
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log("Sync done");
});

app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
});