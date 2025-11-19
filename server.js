require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- Configuración de Instancias de Axios ---
// URLs reales de producción
const apiAuth = axios.create({
    baseURL: 'https://bpdigital-api.bellinatiperez.com.br',
    timeout: 25000
});

const apiNegocie = axios.create({
    baseURL: 'https://api-negocie.bellinati.com.br',
    timeout: 15000
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

// Log de IP para depuración
app.use((req, res, next) => {
  const ipDesdeHeader = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : null;
  const ipReal = req.ip || ipDesdeHeader;
  console.log(`[IP-DEBUG] Ruta: ${req.path} | IP Real del Cliente: ${ipReal}`);
  next();
});

// --- Helpers de Respuesta ---
const responder = (res, statusCode, title, rawData) => {
    const message = rawData.mensaje || rawData.msgRetorno || 'Operación completada.';
    const response = {
        raw: {
            status: statusCode >= 400 ? 'error' : 'exito',
            ...rawData
        },
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
        console.error('API Response Error Data:', error.response.data);
        statusCode = error.response.status;
        mensaje = error.response.data.msgRetorno || error.response.data.message || 'Error de la API de negociación.';
        if (error.response.data.errors) {
            mensaje += ` Detalles: ${JSON.stringify(error.response.data.errors)}`;
        }
    } else if (error.request) {
        console.error('API No Response:', error.request);
        statusCode = 504;
        mensaje = 'No se recibió respuesta de la API de negociación. El servicio puede estar temporalmente caído o bloqueado por firewall.';
    } else {
        mensaje = error.message;
    }
    return responder(res, statusCode, title, { mensaje });
}

// --- 1. Base de Datos Simulada (ÚNICA PARTE DUMMY) ---
// Aquí es donde conectarías tu MySQL/Postgres/MongoDB real.
async function getUserDataFromDB(rawPhone) {
    console.log(`Buscando datos en BD para el teléfono: ${rawPhone}`);
    
    // DATOS SIMULADOS DE LA BD
    const simulacionDB = {
        "42154393888":{cpf_cnpj:"42154393888",nombre:"Alvaro Montero"},//"525510609610": { cpf_cnpj: "08921114882", nombre: "Alvaro Montero" },
        "98765432100": { cpf_cnpj: "98765432100", nombre: "Usuario de Prueba 2" },
        "02604738554":{cpf_cnpj:"02604738554",nombre:"Alvaro Montero"},
        "default": { cpf_cnpj: "02637364238", nombre: "Usuario Default" } // CPF de la documentación
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
    const authUrl = '/api/Login/v5/Authentication';
    const body = {
        AppId: process.env.API_APP_ID,
        AppPass: process.env.API_APP_PASS,
        Usuario: cpf_cnpj
    };

    try {
        const response = await apiAuth.post(authUrl, body);
        const token = response.data.token || response.data.access_token;
        if (token) return token;
        if (typeof response.data === 'string' && response.data.length > 50) return response.data;
        throw new Error('No se pudo extraer el token de la respuesta de autenticación.');
    } catch (error) {
        console.error('Error DETALLADO al obtener token de autenticación:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
        throw error; // Re-lanzar para manejo global
    }
}

// --- 3. Helper de Reconstrucción de Contexto ---
// Este helper "reconstruye" el estado técnico (IDs, Contratos) desde cero
// usando solo el teléfono, para que el LLM no tenga que recordar nada.
async function obtenerContextoDeuda(function_call_username) {
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    // A. Identificar Usuario
    const userData = await getUserDataFromDB(rawPhone);
    if (!userData || !userData.cpf_cnpj) throw new Error("Usuario no encontrado en BD.");
    const cpf_cnpj = userData.cpf_cnpj;

    // B. Obtener Token Fresco
    const token = await getAuthToken(cpf_cnpj);

    // C. Buscar Acreedores Reales
    const resCredores = await apiNegocie.get('/api/v5/busca-credores', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!resCredores.data.credores || resCredores.data.credores.length === 0) {
        throw new Error("No se encontraron acreedores activos para este usuario.");
    }

    // NOTA: Seleccionamos el PRIMER acreedor automáticamente.
    const credor = resCredores.data.credores[0];
    
    // --- DEBUG: Inspeccionar estructura para evitar error de "Carteira undefined" ---
    console.log("DEBUG - Estructura del Acreedor:", JSON.stringify(credor, null, 2));
    
    // Intentamos obtener el ID de la cartera. Probamos 'carteiraId' (correcto) y 'carteirald' (posible typo OCR)
    const carteiraInfo = credor.carteiraCrms && credor.carteiraCrms[0];
    const carteiraId = carteiraInfo ? (carteiraInfo.carteiraId || carteiraInfo.carteirald || carteiraInfo.id) : null;

    if (!carteiraId) {
        console.error("ERROR CRÍTICO: No se pudo encontrar el ID de la Cartera en la respuesta del acreedor.");
        throw new Error("Error técnico: ID de cartera no disponible.");
    }

    // D. Buscar Detalle de Deudas (para obtener contratos)
    const bodyDivida = { financeira: credor.financeira, crms: credor.crms };
    const resDividas = await apiNegocie.post('/api/v5/busca-divida', bodyDivida, {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    const dividas = resDividas.data;
    if (!dividas || dividas.length === 0) {
        throw new Error("El acreedor no tiene deudas detalladas disponibles.");
    }

    // Extraer lista de contratos de la primera deuda
    const contratos = dividas[0].contratos.map(c => c.documento || c.numero);
    
    return {
        token,
        cpf_cnpj,
        Crm: credor.crms[0], 
        Carteira: carteiraId, // Usamos el ID corregido
        Contratos: contratos,
        ContratoPrincipal: contratos[0]
    };
}


// --- Rutas de la API (Endpoints Stateless) ---

app.get('/', (req, res) => {
    responder(res, 200, "API Stateless de Negociación", { status: 'OK', mode: 'REAL_API' });
});

// --- Endpoint 1: Identificación y Consulta ---
// Valida identidad y devuelve deuda real.
app.post('/api/negociacao/buscar-credores', async (req, res) => {
    const { function_call_username, cpf_cnpj } = req.body;
    if (!function_call_username || !cpf_cnpj) return responder(res, 400, "Error", { mensaje: "Faltan datos requeridos." });

    let rawPhone = function_call_username.includes("--") ? function_call_username.split("--").pop() : function_call_username;

    try {
        // 1. Validación vs DB Simulada
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData) return responder(res, 404, "Error", { mensaje: "Usuario no encontrado en registros." });

        // Normalizar para comparar (solo números)
        const cpfCleanInput = String(cpf_cnpj).replace(/\D/g,'');
        const cpfCleanDB = String(userData.cpf_cnpj).replace(/\D/g,'');

        if (cpfCleanDB !== cpfCleanInput) {
            return responder(res, 403, "Error de Identidad", { mensaje: "El documento proporcionado no coincide con el registrado para este teléfono." });
        }

        // 2. Consulta Real a API
        const token = await getAuthToken(userData.cpf_cnpj);
        const resCredores = await apiNegocie.get('/api/v5/busca-credores', { headers: { 'Authorization': `Bearer ${token}` }});

        if (!resCredores.data.credores || resCredores.data.credores.length === 0) {
            return responder(res, 404, "Sin Deudas", { mensaje: "Validación correcta. No se encontraron deudas pendientes." });
        }

        // 3. Enriquecimiento de Datos (Iterar acreedores para obtener montos reales)
        const credoresDetalle = await Promise.all(resCredores.data.credores.map(async (c) => {
            try {
                const resD = await apiNegocie.post('/api/v5/busca-divida', 
                    { financeira: c.financeira, crms: c.crms }, 
                    { headers: { 'Authorization': `Bearer ${token}` }}
                );
                return { ...c, dividas: resD.data };
            } catch (e) {
                return { ...c, dividas: [], error: "No se pudo cargar detalle" };
            }
        }));

        // 4. Generar Resumen Markdown
        let md = `Confirmado. Hemos encontrado las siguientes deudas:\n\n`;
        credoresDetalle.forEach(c => {
            if(c.dividas && c.dividas.length > 0) {
                c.dividas.forEach(d => {
                    md += `- **${c.financeira}**: R$ ${d.valor} (Atraso: ${d.contratos[0]?.diasAtraso || '?'} días)\n`;
                });
            } else {
                md += `- **${c.financeira}**: Deuda encontrada pero sin detalle de monto disponible.\n`;
            }
        });

        return responder(res, 200, "Deudas Encontradas", { credores: credoresDetalle, mensaje: md });

    } catch (error) {
        return handleApiError(res, error, "Error al buscar deudas");
    }
});

// --- Endpoint 2: Simulación (Stateless) ---
// El usuario pide condiciones, el server reconstruye y consulta.
app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    const { function_call_username, DataVencimento, QuantidadeParcela, ValorEntrada } = req.body;
    
    if (!function_call_username) return responder(res, 400, "Error", { mensaje: "Falta function_call_username" });

    try {
        // 1. Reconstruir Contexto (Auth -> IDs)
        const ctx = await obtenerContextoDeuda(function_call_username);

        // 2. Llamada Real a Simulación
        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.Contratos,
            DataVencimento: DataVencimento || null,
            ValorEntrada: ValorEntrada || 0,
            QuantidadeParcela: QuantidadeParcela || 0,
            ValorParcela: 0
        };

        // DEBUG: Ver qué estamos enviando antes de que falle
        console.log("Enviando body a simulacion:", JSON.stringify(bodySimulacion, null, 2));

        const response = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        // 3. Formatear Opciones para el Usuario
        let md = "Aquí están las opciones de pago disponibles:\n\n";
        if (response.data.opcoesPagamento) {
            response.data.opcoesPagamento.forEach((op, idx) => {
                md += `**Opción ${idx + 1}**: ${op.texto}\n`;
                md += `- Total a pagar: R$ ${op.valorTotalComCustas || op.valor}\n`;
                if (op.desconto > 0) md += `- ¡Ahorras R$ ${op.desconto}!\n`;
                md += `\n`;
            });
        } else {
            md = "No se encontraron opciones de pago con esos parámetros.";
        }

        return responder(res, 200, "Opciones Calculadas", { ...response.data, mensaje: md });

    } catch (error) {
        return handleApiError(res, error, "Error al simular opciones");
    }
});

// --- Endpoint 3: Emisión de Boleto (Stateless Inteligente) ---
// El usuario elige parcelas, el server reconstruye, simula, valida requisitos y emite.
app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    const { function_call_username, Parcelas, DataVencimento } = req.body;

    if (!function_call_username || !Parcelas) return responder(res, 400, "Error", { mensaje: "Se requiere usuario y número de parcelas." });

    try {
        // 1. Reconstruir Contexto
        const ctx = await obtenerContextoDeuda(function_call_username);

        // 2. Re-Simular para obtener Identificador válido
        const bodySimulacion = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            Contratos: ctx.Contratos,
            DataVencimento: DataVencimento || null, 
            QuantidadeParcela: Parcelas, // Filtramos por lo que quiere el usuario
            ValorEntrada: 0,
            ValorParcela: 0
        };

        const resSimulacion = await apiNegocie.post('/api/v5/busca-opcao-pagamento', bodySimulacion, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        // 3. Encontrar la opción deseada en la simulación
        const opcionElegida = resSimulacion.data.opcoesPagamento.find(op => op.qtdParcelas == Parcelas);

        if (!opcionElegida) {
            return responder(res, 400, "Opción No Disponible", { mensaje: `No pude generar una opción válida con ${Parcelas} cuotas para esa fecha.` });
        }

        let identificadorFinal = opcionElegida.codigo;
        const valorFinal = opcionElegida.valor;

        // 4. Manejo Automático de "Resumo Boleto" (Si la API lo requiere)
        // La documentación dice que si 'chamarResumoBoleto' es true, hay que llamar a ese endpoint intermedio.
        if (resSimulacion.data.chamarResumoBoleto) {
            console.log("La API requiere paso intermedio Resumo Boleto. Ejecutando...");
            
            const bodyResumo = {
                Crm: ctx.Crm,
                CodigoCarteira: ctx.Carteira,
                CNPJ_CPF: ctx.cpf_cnpj,
                Contrato: ctx.ContratoPrincipal,
                CodigoOpcao: opcionElegida.codigo
            };

            const resResumo = await apiNegocie.post('/api/v5/resumo-boleto', bodyResumo, {
                headers: { 'Authorization': `Bearer ${ctx.token}` }
            });

            if (resResumo.data.sucesso && resResumo.data.identificador) {
                identificadorFinal = resResumo.data.identificador; // Actualizamos con el ID definitivo
            } else {
                throw new Error("Falló el paso intermedio de resumen de boleto.");
            }
        }

        // 5. Emisión Real del Boleto
        const bodyEmision = {
            Crm: ctx.Crm,
            Carteira: ctx.Carteira,
            CNPJ_CPF: ctx.cpf_cnpj,
            fase: "",
            Contrato: ctx.ContratoPrincipal,
            Valor: valorFinal,
            Parcelas: Parcelas,
            DataVencimento: opcionElegida.dataVencimento || DataVencimento,
            Identificador: identificadorFinal,
            TipoContrato: null
        };

        const resEmision = await apiNegocie.post('/api/v5/emitir-boleto', bodyEmision, {
            headers: { 'Authorization': `Bearer ${ctx.token}` }
        });

        // Construir mensaje de éxito
        const md = `¡Listo! Boleto generado exitosamente.\n\n` +
                   `**Valor**: R$ ${resEmision.data.valorTotal || valorFinal}\n` +
                   `**Vencimiento**: ${resEmision.data.vcto}\n` +
                   `**Código de Barras**: \`${resEmision.data.linhaDigitavel}\`\n\n` +
                   `Puedes copiar el código de barras para pagar en tu banco.`;

        return responder(res, 201, "Boleto Emitido", { ...resEmision.data, mensaje: md });

    } catch (error) {
        return handleApiError(res, error, "Error al emitir boleto");
    }
});

// Exportar para Vercel
module.exports = app;
app.listen(PORT, () => {
    console.log(`Servidor de Herramientas de Negociación (v2) corriendo en el puerto ${PORT}`);
});