require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- Configuración de Instancias de Axios ---
const apiAuth = axios.create({
    baseURL: 'https://bpdigital-api.bellinatiperez.com.br',
    timeout: 100000
});

const apiNegocie = axios.create({
    baseURL: 'https://api-negocie.bellinati.com.br',
    timeout: 100000
});

// --- Middlewares ---
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Demasiadas solicitudes desde esta IP, por favor intente más tarde.'
}));

app.use((req, res, next) => {
  const ipReal = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
  console.log(`[IP-DEBUG] Ruta: ${req.path} | IP Cliente: ${ipReal}`);
  next();
});

// --- Helpers de Respuesta ---
const responder = (res, statusCode, title, rawData) => {
    const message = rawData.mensaje || rawData.msgRetorno || 'Operación completada.';
    const response = {
        raw: { status: statusCode >= 400 ? 'error' : 'exito', ...rawData },
        markdown: `**${title}**\n\n${message}`,
        type: "markdown",
        desc: `**${title}**\n\n${message}`
    };
    res.status(statusCode).json(response);
};

function handleApiError(res, error, title) {
    console.error(`[${title}] Error:`, error.message);
    let statusCode = 500;
    let mensaje = 'Ocurrió un error inesperado en el servidor.';

    if (error.response) {
        console.error('API Data:', error.response.data);
        statusCode = error.response.status;
        mensaje = error.response.data.msgRetorno || error.response.data.message || 'Error de la API de negociación.';
    } else if (error.request) {
        statusCode = 504;
        mensaje = 'La API de negociación no respondió a tiempo (Timeout/Firewall).';
    } else {
        mensaje = error.message;
    }
    return responder(res, statusCode, title, { mensaje });
}

// --- 1. Base de Datos Simulada ---
async function getUserDataFromDB(rawPhone) {
    console.log(`Buscando datos en BD para el teléfono: ${rawPhone}`);
    
    // DATOS SIMULADOS DE LA BD (Teléfono -> CPF)
    const simulacionDB = {
        "42154393888": { cpf_cnpj: "42154393888", nombre: "Alvaro Montero" },
        "98765432100": { cpf_cnpj: "98765432100", nombre: "Usuario de Prueba 2" },
        "02604738554": { cpf_cnpj: "02604738554", nombre: "Alvaro Montero" },
        "06212643342": { cpf_cnpj: "06212643342", nombre: "Usuario Test 062" },
        "52116745888": { cpf_cnpj: "52116745888", nombre: "Usuario Test 521" },
        "12144201684": { cpf_cnpj: "12144201684", nombre: "Usuario Test 121" },
        "46483299885": { cpf_cnpj: "46483299885", nombre: "Usuario Test 464" },
        "26776559856": { cpf_cnpj: "26776559856", nombre: "Usuario Test 267" },
        "04513675020": { cpf_cnpj: "04513675020", nombre: "Usuario Test 045" },
        "02637364238": { cpf_cnpj: "02637364238", nombre: "Usuario Test 0263" },
        "06430897052": { cpf_cnpj: "06430897052", nombre: "Usuario Test 064" },
        "10173421997": { cpf_cnpj: "10173421997", nombre: "Usuario Test 101" },
        "04065282330": { cpf_cnpj: "04065282330", nombre: "Usuario Test 040" },
        "09241820918": { cpf_cnpj: "09241820918", nombre: "Usuario Test 092" },
        "63618955308": { cpf_cnpj: "63618955308", nombre: "Usuario Test 636" },
        "default": { cpf_cnpj: "02637364238", nombre: "Usuario Default" }
    };
    
    const userData = simulacionDB[rawPhone] || simulacionDB["default"];
    
    if (!userData) {
        console.warn(`No se encontró usuario en la simulación de BD para: ${rawPhone}`);
        return null;
    }
    return Promise.resolve(userData);
}

// --- 2. Autenticación Real ---
async function getAuthToken(cpf_cnpj) {
    try {
        const response = await apiAuth.post('/api/Login/v5/Authentication', {
            AppId: process.env.API_APP_ID,
            AppPass: process.env.API_APP_PASS,
            Usuario: cpf_cnpj
        });
        const token = response.data.token || response.data.access_token;
        if (!token && typeof response.data === 'string') return response.data;
        if (!token) throw new Error('Token no encontrado en respuesta de auth.');
        return token;
    } catch (error) {
        console.error('Error Auth Detallado:', error.message);
        if(error.response) console.error('Auth Status:', error.response.status);
        throw error;
    }
}

// --- 3. RECONSTRUCTOR DE CONTEXTO (EL CEREBRO) ---
// Ejecuta toda la cadena: Auth -> Credores -> Divida
// Recupera los datos frescos necesarios para cualquier operación subsiguiente.
async function obtenerContextoDeuda(function_call_username) {
    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    // A. LOGIN
    const userData = await getUserDataFromDB(rawPhone);
    if (!userData || !userData.cpf_cnpj) throw new Error("Usuario no encontrado en BD.");
    const cpf_cnpj = userData.cpf_cnpj;
    
    // Paso 1: Autenticación
    const token = await getAuthToken(cpf_cnpj);

    // Paso 2: Busca Credores (Obtener Crm y Carteira)
    const resCredores = await apiNegocie.get('/api/v5/busca-credores', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resCredores.data.credores || resCredores.data.credores.length === 0) {
        throw new Error("No se encontraron acreedores activos.");
    }

    // Tomamos el primer acreedor disponible
    const credor = resCredores.data.credores[0];
    
    // Extracción segura del ID de cartera
    const carteiraInfo = credor.carteiraCrms && credor.carteiraCrms[0];
    const carteiraId = carteiraInfo ? (carteiraInfo.carteiraId || carteiraInfo.carteirald || carteiraInfo.id) : null;

    if (!carteiraId) throw new Error("ID de cartera no disponible en Busca Credores.");

    // Paso 3: Busca Divida (Obtener Contratos y Fase)
    const bodyDivida = { financeira: credor.financeira, crms: credor.crms };
    const resDividas = await apiNegocie.post('/api/v5/busca-divida', bodyDivida, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const dividas = resDividas.data;
    if (!dividas || dividas.length === 0) {
        throw new Error("El acreedor no tiene deudas detalladas en Busca Divida.");
    }

    // --- RECOLECCIÓN DE CONTRATOS ---
    // IMPORTANTE: 'Contratos' para simulación debe ser Array de Strings (Documentos), NO IDs.
    
    let contratosDocs = []; // Array de Strings (ej: ["29027...", "29028..."])
    let fase = ""; 

    dividas.forEach(deuda => {
        if (!fase && deuda.fase) fase = deuda.fase; // Capturar fase si aún no tenemos

        if (deuda.contratos && Array.isArray(deuda.contratos)) {
            deuda.contratos.forEach(c => {
                // Usamos el documento/numero para ambos casos (Simulación y Emisión) según documentación
                const doc = c.numero;
                if (doc) {
                    contratosDocs.push(String(doc)); // Aseguramos que sea String
                }
            });
        }
    });

    console.log(`DEBUG CONTEXTO RECUPERADO - Fase: ${fase}, Carteira: ${carteiraId}, Total Contratos (Docs): ${contratosDocs.length}`);

    return {
        token,
        cpf_cnpj,
        financeira: credor.financeira, // Nombre para reportes
        Crm: credor.crms[0], 
        Carteira: carteiraId,
        fase: fase,
        ContratosSimulacion: contratosDocs, // Ahora es Array de Strings (Documentos)
        ContratoEmision: contratosDocs[0]   // String (Principal)
    };
}




// --- Rutas de la API ---

app.get('/', (req, res) => {
    responder(res, 200, "API Stateless de Negociación", { status: 'OK', mode: 'REAL_API_TEST_LIST' });
});

// --- PASO 1: Identificación ---
// Muestra al usuario qué deudas tiene (con formato Markdown bonito)
app.post('/api/negociacao/buscar-credores', async (req, res) => {
    const { function_call_username, cpf_cnpj } = req.body;
    if (!function_call_username || !cpf_cnpj) return responder(res, 400, "Error", { mensaje: "Faltan datos." });

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData) return responder(res, 404, "Error", { mensaje: "Usuario no encontrado." });
        
        if (String(userData.cpf_cnpj).replace(/\D/g,'') !== String(cpf_cnpj).replace(/\D/g,'')) {
            return responder(res, 403, "Error", { mensaje: "Identidad no verificada." });
        }

        // Reconstruimos contexto para obtener credenciales y datos base
        const ctx = await obtenerContextoDeuda(function_call_username);

        // Llamada explícita a busca-divida para obtener el detalle visual para el usuario
        const resDividas = await apiNegocie.post('/api/v5/busca-divida', 
            { financeira: ctx.financeira || "Itaú", crms: [ctx.Crm] }, 
             { headers: { 'Authorization': `Bearer ${ctx.token}` }}
        );
        
        // --- VISUALIZACIÓN DE DEUDAS ---
        let md = `**Identidad verificada.** Se han encontrado las siguientes deudas con **${ctx.financeira || 'la entidad'}**:\n\n`;
        
        const deudas = resDividas.data;
        if (deudas && deudas.length > 0) {
            deudas.forEach((deuda, i) => {
                md += `### Deuda ${i + 1}: Total R$ ${deuda.valor}\n`;
                if (deuda.contratos && deuda.contratos.length > 0) {
                    deuda.contratos.forEach(contrato => {
                        md += `- **Producto**: ${contrato.produto}\n`;
                        md += `  - **Contrato**: ${contrato.documento || contrato.numero}\n`;
                        md += `  - **Valor Original**: R$ ${contrato.valor}\n`;
                        md += `  - **Días de Atraso**: ${contrato.diasAtraso}\n`;
                    });
                }
                md += `\n`;
            });
        } else {
             md += "No se encontraron detalles específicos de contratos.\n";
        }

        if(ctx.fase) md += `> Fase de negociación: ${ctx.fase}\n`;
        
        return responder(res, 200, "Deudas Encontradas", { mensaje: md, detalle: resDividas.data });

    } catch (error) {
        return handleApiError(res, error, "Error al buscar deudas");
    }
});

// --- PASO 2: Simulación (Stateless & Robust) ---
// Reconstruye todo el contexto y luego llama a la API de simulación
app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    const { function_call_username, DataVencimento, QuantidadeParcela, ValorEntrada } = req.body;
    if (!function_call_username) return responder(res, 400, "Error", { mensaje: "Falta usuario." });

    try {
        // 1. Recuperar Credenciales y Datos de API (Auth -> Credores -> Divida)
        console.log("Obteniendo contexto")
        const ctx = await obtenerContextoDeuda(function_call_username);
        console.log("contexto obtenido");
        // 2. Construir Body usando los datos FRESCOS y REALES
        // NOTA: Contratos ahora es Array de Strings (Documentos)
        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.ContratosSimulacion, 
            DataVencimento: DataVencimento || null,
            ValorEntrada: ValorEntrada || 0,
            QuantidadeParcela: QuantidadeParcela || 0,
            ValorParcela: 0
        };


        console.log("Simulando con:", JSON.stringify(bodySimulacion));

        // 3. Llamada Real a Busca Opcao Pagamento
        const response = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        // 4. Formatear respuesta
        let md = "Opciones de pago disponibles:\n\n";
        if (response.data.opcoesPagamento) {
            response.data.opcoesPagamento.forEach((op, idx) => {
                md += `**${idx + 1}. ${op.texto}**\n`;
                md += `- Total: R$ ${op.valorTotalComCustas || op.valor}\n`;
                if (op.desconto > 0) md += `- Descuento: R$ ${op.desconto}\n`;
                md += `\n`;
            });
        } else {
            md = "No se encontraron opciones para esos parámetros.";
        }

        return responder(res, 200, "Opciones Calculadas", { ...response.data, mensaje: md });

    } catch (error) {
        return handleApiError(res, error, "Error al simular");
    }
});

// --- PASO 3: Emisión (Stateless & Robust) ---
app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    const { function_call_username, Parcelas, DataVencimento } = req.body;
    if (!function_call_username || !Parcelas) return responder(res, 400, "Error", { mensaje: "Faltan datos." });

    try {
        // 1. Recuperar Todo el Contexto de Nuevo
        const ctx = await obtenerContextoDeuda(function_call_username);
        
        // 2. Re-Simular para obtener el Identificador válido para ESTA sesión
        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.ContratosSimulacion,
            DataVencimento: DataVencimento || null, 
            QuantidadeParcela: Parcelas,
            ValorEntrada: 0,
            ValorParcela: 0
        };

        const resSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        const opcionElegida = resSimulacion.data.opcoesPagamento?.find(op => op.qtdParcelas == Parcelas);
        if (!opcionElegida) return responder(res, 400, "Error", { mensaje: "Opción no válida." });
        
        let identificadorFinal = opcionElegida.codigo;
        const valorFinal = opcionElegida.valor;

        // 3. Paso Intermedio: Resumo Boleto (Si la API lo exige)
        if (resSimulacion.data.chamarResumoBoleto) {
            console.log("Paso Intermedio: Resumo Boleto");
            const bodyResumo = {
                Crm: ctx.Crm,
                CodigoCarteira: ctx.Carteira,
                CNPJ_CPF: ctx.cpf_cnpj,
                Contrato: ctx.ContratoEmision, // String Documento
                CodigoOpcao: opcionElegida.codigo
            };
            console.log("Resumen de boleto");
            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', bodyResumo, {
                headers: { 'Authorization': `Bearer ${ctx.token}` }
            });
            if (resResumo.data.sucesso && resResumo.data.identificador) {
                identificadorFinal = resResumo.data.identificador;
            } else {
                throw new Error("Falló Resumo Boleto.");
            }
        }

        // 4. Emitir Boleto Final
        const bodyEmision = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            CNPJ_CPF: ctx.cpf_cnpj,
            fase: ctx.fase,
            Contrato: ctx.ContratoEmision, // String Documento
            Valor: valorFinal,
            Parcelas: Parcelas,
            DataVencimento: opcionElegida.dataVencimento || DataVencimento,
            Identificador: identificadorFinal,
            TipoContrato: null
        };

        const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', bodyEmision, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        const md = `¡Boleto generado!\n\n` +
                   `Valor: R$ ${resEmision.data.valorTotal || valorFinal}\n` +
                   `Vence: ${resEmision.data.vcto}\n` +
                   `Código: \`${resEmision.data.linhaDigitavel}\``;

        return responder(res, 201, "Boleto Emitido", { ...resEmision.data, mensaje: md });

    } catch (error) {
        return handleApiError(res, error, "Error al emitir boleto");
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;