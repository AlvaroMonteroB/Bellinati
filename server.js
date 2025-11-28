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

// --- HELPER PARA OBTENER CONTEXTO REAL (TOKEN Y CRM) ---
// Se usa para obtener credenciales frescas antes de emitir
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
// 🚦 MAIN HANDLER / DISPATCHER
// =========================================================================
app.post('/api/chat-handler', async (req, res) => {
    try {
        const body = req.body;
        console.log("📨 Payload:", JSON.stringify(body, null, 2));

        // 1. Identificación
        if (body.cpf_cnpj) {
            return await logicBuscarCredores(req, res);
        }

        // 2. Solicitud de Opciones (Lectura)
        if (body.msg) {
            return await logicBuscarOpcoes(req, res);
        }

        // 3. Solicitud de Resumo (Explícito)
        if (body.accion === "resumo") {
            return await logicResumoBoleto(req, res);
        }

        // 4. EMISIÓN POR SELECCIÓN (La nueva lógica 'opt')
        // Si llega 'opt', sabemos que el usuario eligió una opción del menú
        if (body.opt || body.accion === "emitir" || (body.Parcelas && body.DataVencimento)) {
            console.log("➡️ Solicitud de Emisión");
            return await logicEmitirBoleto(req, res);
        }

        console.warn("⚠️ Intención no clara.");
        return responder(res, 400, "Error", "Erro", {}, "No entendí tu solicitud.", "Não entendi.");

    } catch (error) {
        console.error("Error handler:", error);
        return handleApiError(res, error, "Error Interno", "Erro Interno");
    }
});


// =========================================================================
// 🧠 LÓGICA DE NEGOCIO
// =========================================================================

// A. Buscar Credores (Caché)
async function logicBuscarCredores(req, res) {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) {
            return res.status(404).json({ error: "Usuario no sincronizado. Ejecute sync-database." });
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
                    md_es += `- Producto: ${c.produto}\n  - Días Atraso: ${c.diasAtraso}\n`;
                    md_pt += `- Produto: ${c.produto}\n  - Dias Atraso: ${c.diasAtraso}\n`;
                });
                md_es += `\n`; md_pt += `\n`;
            });
            md_pt += `Poderia explicar por que não pagou sua dívida?\n`; 
        } else {
            md_es += "No se encontraron deudas."; md_pt += "Nenhuma dívida encontrada.";
        }

        return responder(res, 200, "Deudas", "Dívidas", { detalle: dividasData }, md_es, md_pt);
    } catch (error) {
        return handleApiError(res, error, "Error datos", "Erro dados");
    }
}

// B. Buscar Opciones (Caché)
async function logicBuscarOpcoes(req, res) {
    const { function_call_username } = req.body;
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const cachedUser = await getFromCache(rawPhone);
        if (!cachedUser) return res.status(404).json({ error: "No data." });

        const simData = JSON.parse(cachedUser.simulacion_json);
        let md_es = "Opciones de pago:\n\n";
        let md_pt = "Opções de pagamento:\n\n";

        simData.opcoesPagamento?.forEach((op, idx) => {
            md_es += `**Opción ${idx + 1}**: ${op.texto}\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
            md_pt += `**Opção ${idx + 1}**: ${op.texto}\n- Total: R$ ${op.valorTotalComCustas || op.valor}\n\n`;
        });

        return responder(res, 200, "Opciones", "Opções", simData, md_es, md_pt);
    } catch (error) {
        return handleApiError(res, error, "Error opciones", "Erro opções");
    }
}

// C. Resumo Boleto (Auxiliar)
async function logicResumoBoleto(req, res) {
    // ... (Este endpoint se mantiene por si se quiere llamar explícitamente, 
    // pero la lógica principal ahora vive en Emitir) ...
    // Se puede implementar similar a emitir si es necesario.
    return responder(res, 200, "Endpoint Auxiliar", "Auxiliar", { msg: "Use emitir con opt" });
}

// D. Emitir Boleto (INTELIGENTE: Basado en Selección 'opt')
async function logicEmitirBoleto(req, res) {
    const { function_call_username, opt, Parcelas } = req.body;
    
    // Necesitamos 'opt' O bien 'Parcelas' manuales.
    if (!opt && !Parcelas) return responder(res, 400, "Falta Opción", "Falta Opção", {}, "Selecciona una opción (ej: 1, 2).", "Selecione uma opção.");

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        // 1. OBTENER CONTEXTO TÉCNICO (Credenciales frescas)
        const ctx = await obtenerContextoDeudaReal(rawPhone);

        let idFinal = "";
        let valorFinal = 0;
        let parcelasFinal = 0;
        let dataVencFinal = "";

        // 2. RECUPERAR OPCIÓN SELECCIONADA
        if (opt) {
            // A. Recuperar simulación de la CACHÉ (Lo que vio el usuario)
            const cachedUser = await getFromCache(rawPhone);
            if (!cachedUser || !cachedUser.simulacion_json) {
                return responder(res, 400, "Sesión Caducada", "Sessão Expirada", {}, "Por favor, pide ver las opciones de nuevo.", "Solicite as opções novamente.");
            }
            
            const simulacionData = JSON.parse(cachedUser.simulacion_json);
            const opciones = simulacionData.opcoesPagamento || [];
            
            // Validar índice (Asumimos que el usuario envía "1" para el índice 0)
            const index = parseInt(opt) - 1;
            if (index < 0 || index >= opciones.length) {
                return responder(res, 400, "Opción Inválida", "Opção Inválida", {}, "Esa opción no existe.", "Essa opção não existe.");
            }

            const opcionElegida = opciones[index];
            console.log(`✅ Usuario eligió opción ${opt}:`, opcionElegida.texto);

            // B. Preparar datos base
            idFinal = opcionElegida.codigo;
            valorFinal = opcionElegida.valor;
            parcelasFinal = opcionElegida.qtdParcelas;
            dataVencFinal = opcionElegida.dataVencimento;

            // C. VERIFICAR SI REQUIERE 'RESUMO BOLETO' (Usando la bandera de la simulación guardada)
            if (simulacionData.chamarResumoBoleto === true) {
                console.log("🔄 La opción requiere paso intermedio (Resumo). Ejecutando...");
                
                try {
                    const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', {
                        Crm: ctx.Crm,
                        CodigoCarteira: ctx.Carteira,
                        CNPJ_CPF: ctx.cpf_cnpj,
                        Contrato: ctx.Contratos[0], // Contrato principal
                        CodigoOpcao: opcionElegida.codigo // El código de la opción seleccionada
                    }, { headers: { 'Authorization': `Bearer ${ctx.token}` } });

                    // Si devuelve ID nuevo, lo usamos. Si es 204 o vacío, mantenemos el original.
                    if (resResumo.data && resResumo.data.identificador) {
                        idFinal = resResumo.data.identificador;
                        console.log("✅ ID actualizado por Resumo Boleto.");
                    }
                } catch (errResumo) {
                    console.warn("⚠️ Error en Resumo Boleto (o 204), intentando emitir con ID original:", errResumo.message);
                    // Continuamos con idFinal original
                }
            }

        } else {
            // Fallback: Si enviaron 'Parcelas' manuales en vez de 'opt' (comportamiento antiguo)
            // Aquí tendrías que re-simular. Por brevedad, asumimos el flujo 'opt' es el principal ahora.
            return responder(res, 400, "Use 'opt'", "Use 'opt'", {}, "Por favor selecciona por número de opción.", "Selecione pelo número da opção.");
        }

        // 3. EMITIR BOLETO FINAL
        console.log(`🚀 Emitiendo boleto... ID: ${idFinal}, Valor: ${valorFinal}`);
        payload={Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            CNPJ_CPF: ctx.cpf_cnpj,
            fase: ctx.fase,
            Contrato: ctx.Contratos[0],
            Valor: valorFinal,
            Parcelas: parcelasFinal,
            DataVencimento: dataVencFinal,
            Identificador: idFinal,
            TipoContrato: null};
            console.log(payload);
        
        const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', {
            payload
        }, { headers: { 'Authorization': `Bearer ${ctx.token}` } });

        // 4. RESPUESTA FINAL BILINGÜE
        const md_es = `¡Listo! Boleto generado con éxito.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimiento**: ${resEmision.data.vcto}\n` +
                      `**Código de Barras**: \`${resEmision.data.linhaDigitavel}\`\n\n` +
                      `Copia el código para pagar en tu aplicación bancaria.`;

        const md_pt = `Pronto! Boleto gerado com sucesso.\n\n` +
                      `**Valor**: R$ ${resEmision.data.valorTotal}\n` +
                      `**Vencimento**: ${resEmision.data.vcto}\n` +
                      `**Código de Barras**: \`${resEmision.data.linhaDigitavel}\`\n\n` +
                      `Copie o código para pagar no seu aplicativo bancário.`;

        return responder(res, 201, "Boleto Emitido", "Boleto Gerado", resEmision.data, md_es, md_pt);

    } catch (error) {
        return handleApiError(res, error, "Error al emitir", "Erro ao emitir");
    }
}

// Endpoint Admin
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