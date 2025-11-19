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
// MODIFICADO: URLs hardcoded como se solicitó
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

// --- Helper de Respuesta Estandarizada ---
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

// --- Helper de Manejo de Errores de API ---
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
        mensaje = 'No se recibió respuesta de la API de negociación. El servicio puede estar temporalmente caído.';
    } else {
        mensaje = error.message;
    }
    return responder(res, statusCode, title, { mensaje });
}

// --- NUEVO: Helper de Consulta a Base de Datos (Placeholder) ---
/**
 * Simula la búsqueda de datos de usuario en tu base de datos usando el número de teléfono.
 * @param {string} rawPhone - El número de teléfono del usuario.
 * @returns {Promise<object|null>} - Un objeto con los datos del usuario (ej. cpf_cnpj) o null si no se encuentra.
 */
async function getUserDataFromDB(rawPhone) {
    console.log(`Buscando datos en BD para el teléfono: ${rawPhone}`);
    
    // --- INICIO DEL PLACEHOLDER ---
    // Aquí debes implementar la lógica real de tu base de datos.
    // Ejemplo: const user = await TuModeloDeDB.findOne({ where: { telefono: rawPhone } });
    // if (!user) { return null; }
    // return { cpf_cnpj: user.cpf_cnpj, nombre: user.nombre };
    
    // Por ahora, simulamos una respuesta exitosa con un CPF/CNPJ de prueba.
    // ¡REEMPLAZA ESTO CON TU LÓGICA DE BASE DE DATOS!
    const simulacionDB = {
        "525510609610":{cpf_cnpj:"42154393888",nombre:"Alvaro Montero"},//"525510609610": { cpf_cnpj: "08921114882", nombre: "Alvaro Montero" },
        "5491112345678": { cpf_cnpj: "98765432100", nombre: "Usuario de Prueba 2" },
        "default": { cpf_cnpj: "66993490587", nombre: "Usuario Default" } // CPF de la documentación
    };

    const userData = simulacionDB[rawPhone] || simulacionDB["default"];
    
    if (!userData) {
        console.warn(`No se encontró usuario en la simulación de BD para: ${rawPhone}`);
        return null;
    }

    console.log(`Usuario encontrado (simulado): ${userData.nombre} con CPF/CNPJ: ${userData.cpf_cnpj}`);
    return Promise.resolve(userData);
    // --- FIN DEL PLACEHOLDER ---
}


// --- Helper de Autenticación de API (Sin cambios) ---
/**
 * Obtiene un token de autenticación para un CPF/CNPJ específico.
 * @param {string} cpf_cnpj - El CPF o CNPJ del cliente.
 * @returns {Promise<string>} - El token de acceso.
 */
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

        if (token) {
            return token;
        }
        if (typeof response.data === 'string' && response.data.length > 50) {
            return response.data;
        }

        console.error('Formato de token desconocido en la respuesta de autenticación:', response.data);
        throw new Error('No se pudo extraer el token de la respuesta de autenticación.');
        
    } catch (error) {
        console.error('Error DETALLADO al obtener token de autenticación:');
        if (error.response) {
            // El servidor respondió con un status code (ej. 403, 500)
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else if (error.request) {
            // La solicitud se hizo pero no hubo respuesta (ej. timeout, IP bloqueada por firewall)
            console.error('La solicitud se hizo pero no se recibió respuesta (Timeout o Firewall)');
        } else {
            // Algo más falló al configurar la solicitud
            console.error('Error de configuración de Axios:', error.message);
        }
        
        // IMPORTANTE: Re-lanzamos el error *original* de axios
        // para que handleApiError pueda leer 'error.response' correctamente.
        throw error;
    }
}


// --- Rutas de la API (Herramientas para el LLM) ---

app.get('/', (req, res) => {
    responder(res, 200, "API de Herramientas de Negociación", {
        version: '2.0.0 (Auth por Teléfono)',
        status: 'Operacional',
        // ... (endpoints)
    });
});

/**
 * HERRAMIENTA 1: Buscar Credores
 */
app.post('/api/negociacao/buscar-credores', async (req, res) => {
    // 1. Extraer rawPhone y CPF proporcionado
    const { function_call_username, cpf_cnpj } = req.body;
    if (!function_call_username || !cpf_cnpj) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "function_call_username" y "cpf_cnpj" son obligatorios.' });
    }
    
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    // --- NUEVA LÓGICA DE VALIDACIÓN ---
    try {
        // 2. Buscar datos de usuario (CPF) desde la BD usando el teléfono
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Comparar CPF de la BD con el CPF proporcionado por el usuario
        const cpf_cnpj_db = userData.cpf_cnpj;
        const cpf_cnpj_provided = cpf_cnpj;
        
        // Normalizar (quitar puntos, guiones, etc.) antes de comparar
        const normalize = (str) => String(str).replace(/[.-]/g, '');

        if (normalize(cpf_cnpj_db) !== normalize(cpf_cnpj_provided)) {
            console.warn(`Fallo de validación. BD: ${normalize(cpf_cnpj_db)}, Proporcionado: ${normalize(cpf_cnpj_provided)}`);
            return responder(res, 403, "Validación Fallida", { 
                mensaje: "O número do CPF fornecido não corresponde aos nossos registros para este número de telefone. O devedor e o usuário não parecem ser a mesma pessoa." 
            });
        }
        // --- FIN DE LA NUEVA LÓGICA ---

        // 4. Si la validación es exitosa, obtener token de API (usando el CPF validado de la BD)
        const token = await getAuthToken(cpf_cnpj_db);
        
        // 5. Llamar a la API de negocio
        const response = await apiNegocie.get('/api/v5/busca-credores', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.data.credores || response.data.credores.length === 0) {
            return responder(res, 404, "Sin Resultados", { 
                mensaje: "Validación exitosa, pero no se encontraron deudas disponibles para negociación para este CPF/CNPJ.",
                ...response.data
            });
        }

        console.log(`Encontrados ${response.data.credores.length} acreedores. Buscando deudas detalladas...`);
        
        const credoresEnriquecidos = await Promise.all(response.data.credores.map(async (credor) => {
            try {
                const bodyDivida = {
                    financeira: credor.financeira,
                    crms: credor.crms
                };

                // Llamada interna a busca-divida
                const responseDivida = await apiNegocie.post('/api/v5/busca-divida', bodyDivida, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                // Retornamos el credor original + una nueva propiedad 'dividas'
                return {
                    ...credor,
                    dividas: responseDivida.data // Aquí viene el detalle de las deudas (monto, contratos, etc.)
                };

            } catch (err) {
                console.error(`Error al obtener deudas para ${credor.financeira}:`, err.message);
                // Si falla la búsqueda de deuda, devolvemos el credor pero con lista vacía y error
                return {
                    ...credor,
                    dividas: [],
                    errorDetalle: "No se pudo obtener el detalle de la deuda."
                };
            }
        }));

        let reportText = `Se han encontrado ${credoresEnriquecidos.length} acreedores con deudas pendientes:\n\n`;

        credoresEnriquecidos.forEach((credor, index) => {
            reportText += `### ${index + 1}. Acreedor: ${credor.financeira || 'Desconocido'}\n`;
            
            if (credor.errorDetalle) {
                reportText += `- *Error consultando deudas:* ${credor.errorDetalle}\n`;
            } else if (!credor.dividas || credor.dividas.length === 0) {
                reportText += `- *No se encontraron deudas detalladas activas.*\n`;
            } else {
                // Iteramos sobre las deudas (dividas) encontradas para este acreedor
                credor.dividas.forEach((divida) => {
                    reportText += `- **Deuda Total Agrupada:** R$ ${divida.valor} (ID: ${divida.id})\n`;
                    
                    if (divida.contratos && divida.contratos.length > 0) {
                        reportText += `  **Detalle de Contratos:**\n`;
                        divida.contratos.forEach(contrato => {
                            reportText += `  - Producto: ${contrato.produto}\n`;
                            reportText += `    Contrato: ${contrato.numero || contrato.documento || 'N/A'}\n`;
                            reportText += `    Valor Original: R$ ${contrato.valor}\n`;
                            reportText += `    Días de Atraso: ${contrato.diasAtraso}\n`;
                        });
                    } else {
                        reportText += `  - (Sin detalle de contratos individuales)\n`;
                    }
                    reportText += `\n`;
                });
            }
            reportText += `---\n`;
        });

        // Construir respuesta final enriquecida
        const responseData = {
            ...response.data,
            credores: credoresEnriquecidos,
            // Aquí inyectamos el texto generado para que el helper responder lo use en el campo 'markdown'
            mensaje: reportText 
        };
        
        
        
        return responder(res, 200, "Credores y Deudas Encontrados", responseData);

    } catch (error) {
        // Manejar errores de getUserDataFromDB, getAuthToken o handleApiError
        return handleApiError(res, error, "Erro ao Buscar Credores");
    }
        

    
    
});

/**
 * HERRAMIENTA 2: Buscar Dívidas
 */
app.post('/api/negociacao/buscar-dividas', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, financeira, crms } = req.body;
    if (!function_call_username || !financeira || !crms) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "function_call_username", "financeira" y "crms" son obligatorios.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);

        // 4. Llamar a la API de negocio
        const body = { financeira, crms };
        const response = await apiNegocie.post('/api/v5/busca-divida', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Dívidas Encontradas", { dividas: response.data, mensaje: "Dívidas retornadas com sucesso." });

    } catch (error) {
        return handleApiError(res, error, "Erro ao Buscar Dívidas");
    }
});

/**
 * HERRAMIENTA 3: Buscar Acordos (Existentes)
 */
app.post('/api/negociacao/buscar-acordos', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, financeira, crms } = req.body;
    if (!function_call_username || !financeira || !crms) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "function_call_username", "financeira" y "crms" son obligatorios.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);

        // 4. Llamar a la API de negocio
        const body = { financeira, crms };
        const response = await apiNegocie.post('/api/v5/busca-acordo', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Acordos Encontrados", { acordos: response.data, mensaje: "Acordos existentes retornados." });

    } catch (error) {
        return handleApiError(res, error, "Erro ao Buscar Acordos");
    }
});

/**
 * HERRAMIENTA 4: Buscar Opções de Pagamento
 */
app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, Crm, Carteira, Contratos, DataVencimento, ValorEntrada, QuantidadeParcela, ValorParcela } = req.body;
    if (!function_call_username || Crm === undefined || Carteira === undefined || !Contratos) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "function_call_username", "Crm", "Carteira" y "Contratos" son obligatorios.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);
        
        // 4. Llamar a la API de negocio
        const body = {
            Crm,
            Carteira,
            Contratos,
            DataVencimento: DataVencimento || null,
            ValorEntrada: ValorEntrada || 0,
            QuantidadeParcela: QuantidadeParcela || 0,
            ValorParcela: ValorParcela || 0
        };
        
        const response = await apiNegocie.post('/api/v5/busca-opcao-pagamento', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Opções de Pagamento Calculadas", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Calcular Opções");
    }
});

/**
 * HERRAMIENTA 5a: Resumo Boleto
 */
app.post('/api/negociacao/resumo-boleto', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, Crm, CodigoCarteira, Contrato, CodigoOpcao } = req.body;
    if (!function_call_username || Crm === undefined || CodigoCarteira === undefined || !Contrato || !CodigoOpcao) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Campos obligatorios: "function_call_username", "Crm", "CodigoCarteira", "Contrato", "CodigoOpcao".' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);

        // 4. Llamar a la API de negocio (usando el CPF de la BD)
        const body = {
            Crm,
            CodigoCarteira,
            CNPJ_CPF: userData.cpf_cnpj, // Usamos el CPF de la BD
            Contrato,
            CodigoOpcao
        };
        
        const response = await apiNegocie.post('/api/v5/resumo-boleto', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Resumo do Boleto Gerado", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Gerar Resumo do Boleto");
    }
});

/**
 * HERRAMIENTA 5b: Emitir Boleto
 */
app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, Crm, Carteira, Contrato, Valor, Parcelas, DataVencimento, Identificador, fase } = req.body;
    if (!function_call_username || Crm === undefined || Carteira === undefined || !Contrato || Valor === undefined || Parcelas === undefined || !DataVencimento || !Identificador) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Faltan campos obligatorios para emitir el boleto.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);

        // 4. Llamar a la API de negocio (usando el CPF de la BD)
        const body = {
            Crm,
            Carteira,
            CNPJ_CPF: userData.cpf_cnpj, // Usamos el CPF de la BD
            fase: fase || "",
            Contrato,
            Valor,
            Parcelas,
            DataVencimento,
            Identificador,
            TipoContrato: null
        };
        
        const response = await apiNegocie.post('/api/v5/emitir-boleto', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 201, "Boleto Emitido com Sucesso", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Emitir Boleto");
    }
});

/**
 * HERRAMIENTA 6: Emitir Segunda Via
 */
app.post('/api/negociacao/emitir-segunda-via', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, Crm, CodigoCarteira, Id, Contrato, DataVencimento, ValorBoleto, TipoBoleto } = req.body;
    if (!function_call_username || Crm === undefined || CodigoCarteira === undefined || !Id || !Contrato || !DataVencimento || ValorBoleto === undefined || !TipoBoleto) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Faltan campos obligatorios para emitir la segunda vía.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);
        
        // 4. Llamar a la API de negocio (usando el CPF de la BD)
        const body = {
            ...req.body,
            CNPJ_CPF: userData.cpf_cnpj, // Usamos el CPF de la BD
            Fase: req.body.Fase || ""
        };
        // No es necesario eliminar function_call_username del body,
        // la API de destino ignorará los campos extra.
        
        const response = await apiNegocie.post('/api/v5/emitir-boleto-segunda-via', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Segunda Via de Boleto Emitida", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Emitir Segunda Via");
    }
});

/**
 * HERRAMIENTA 7: Cancelar Acordo
 */
app.post('/api/negociacao/cancelar-acordo', async (req, res) => {
    // 1. Extraer rawPhone y otros datos
    const { function_call_username, idAcordo, crm } = req.body;
    if (!function_call_username || !idAcordo || crm === undefined) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Campos "function_call_username", "idAcordo" y "crm" son obligatorios.' });
    }
    let rawPhone = function_call_username;
    if (function_call_username.includes("--")) {
        rawPhone = function_call_username.split("--").pop();
    }

    try {
        // 2. Buscar datos de usuario (CPF)
        const userData = await getUserDataFromDB(rawPhone);
        if (!userData || !userData.cpf_cnpj) {
            return responder(res, 404, "Usuario no Encontrado", { mensaje: 'No se encontraron datos de usuario para el teléfono proporcionado.' });
        }

        // 3. Obtener token de API
        const token = await getAuthToken(userData.cpf_cnpj);

        // 4. Llamar a la API de negocio
        const body = { idAcordo, crm };
        const response = await apiNegocie.post('/api/v5/cancela-acordo', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Cancelamento de Acordo", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Cancelar Acordo");
    }
});


// --- Manejadores de Errores Globales ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    responder(res, 500, "Error Interno Grave", {
        mensaje: "Ocurrió un error inesperado en el servidor."
    });
});

app.use((req, res) => {
    responder(res, 404, "Endpoint no Encontrado", {
        mensaje: `La ruta ${req.method} ${req.originalUrl} no existe en esta API.`
    });
});

// --- Iniciar Servidor ---
//ELIMINAMOS ESTO:
app.listen(PORT, () => {
    console.log(`Servidor de Herramientas de Negociación (v2) corriendo en el puerto ${PORT}`);
});


// AÑADIMOS ESTO para Vercel:
// Exportar la app para que Vercel la pueda usar como una función serverless
module.exports = app;