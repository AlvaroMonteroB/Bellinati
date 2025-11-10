require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
// Confiar en el primer proxy (si se despliega detrás de uno, como Heroku, Vercel, etc.)
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- Configuración de Instancias de Axios ---

// Instancia para la API de Autenticación
const apiAuth = axios.create({
    baseURL: process.env.API_AUTH_URL,
    timeout: 10000 // 10 segundos de timeout
});

// Instancia para la API de Negociación
const apiNegocie = axios.create({
    baseURL: process.env.API_NEGOCIE_URL,
    timeout: 15000 // 15 segundos de timeout
});

// --- Middlewares ---
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // Límite de 100 solicitudes por IP
    message: 'Demasiadas solicitudes desde esta IP, por favor intente más tarde.'
}));

// --- Helper de Respuesta Estandarizada (Adaptado de tu referencia) ---
/**
 * Envía una respuesta estandarizada para el LLM.
 * @param {object} res - El objeto de respuesta de Express.
 * @param {number} statusCode - Código de estado HTTP.
 * @param {string} title - Título para la respuesta markdown.
 * @param {object} rawData - Objeto con los datos crudos y/o mensaje.
 */
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
/**
 * Maneja errores de Axios y los formatea usando el helper `responder`.
 */
function handleApiError(res, error, title) {
    console.error(`[${title}] Error:`, error.message);
    let statusCode = 500;
    let mensaje = 'Ocurrió un error inesperado en el servidor.';

    if (error.response) {
        // La solicitud se hizo y el servidor de la API respondió con un error
        console.error('API Response Error Data:', error.response.data);
        statusCode = error.response.status;
        mensaje = error.response.data.msgRetorno || error.response.data.message || 'Error de la API de negociación.';
        
        // Captura de errores de validación si existen
        if (error.response.data.errors) {
            mensaje += ` Detalles: ${JSON.stringify(error.response.data.errors)}`;
        }
    } else if (error.request) {
        // La solicitud se hizo pero no se recibió respuesta
        console.error('API No Response:', error.request);
        statusCode = 504; // Gateway Timeout
        mensaje = 'No se recibió respuesta de la API de negociación. El servicio puede estar temporalmente caído.';
    } else {
        // Error al configurar la solicitud
        mensaje = error.message;
    }

    return responder(res, statusCode, title, { mensaje });
}

// --- Helper de Autenticación de API ---
/**
 * Obtiene un token de autenticación para un CPF/CNPJ específico.
 * @param {string} cpf_cnpj - El CPF o CNPJ del cliente. [cite: 19]
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
        
        // La documentación no especifica el campo del token en la respuesta.
        // Asumiremos campos comunes como 'token' o 'access_token'.
        const token = response.data.token || response.data.access_token;

        if (token) {
            return token;
        }

        // Fallback si la respuesta es solo el token (poco probable)
        if (typeof response.data === 'string' && response.data.length > 50) {
            return response.data;
        }

        console.error('Formato de token desconocido en la respuesta de autenticación:', response.data);
        throw new Error('No se pudo extraer el token de la respuesta de autenticación.');
        
    } catch (error) {
        console.error('Error al obtener token de autenticación:', error.response ? error.response.data : error.message);
        throw new Error('Fallo al autenticar con la API. Verifique las credenciales y el CPF/CNPJ.');
    }
}


// --- Rutas de la API (Herramientas para el LLM) ---

app.get('/', (req, res) => {
    responder(res, 200, "API de Herramientas de Negociación", {
        version: '1.0.0',
        status: 'Operacional',
        endpoints: {
            '/api/negociacao/buscar-credores': 'POST - Busca acreedores para un CPF/CNPJ.',
            '/api/negociacao/buscar-dividas': 'POST - Busca deudas para un acreedor.',
            '/api/negociacao/buscar-acordos': 'POST - Busca acuerdos existentes.',
            '/api/negociacao/buscar-opcoes-pagamento': 'POST - Simula opciones de pago.',
            '/api/negociacao/resumo-boleto': 'POST - (Paso intermedio) Obtiene resumen si es necesario.',
            '/api/negociacao/emitir-boleto': 'POST - Emite el boleto para una opción seleccionada.',
            '/api/negociacao/emitir-segunda-via': 'POST - Emite segunda vía de un acuerdo existente.',
            '/api/negociacao/cancelar-acordo': 'POST - Cancela un acuerdo existente.',
        }
    });
});

/**
 * HERRAMIENTA 1: Buscar Credores
 * [cite: 97, 102]
 * Corresponde al paso "Verificação de identidade"  del flujo.
 */
app.post('/api/negociacao/buscar-credores', async (req, res) => {
    const { cpf_cnpj } = req.body;
    if (!cpf_cnpj) {
        return responder(res, 400, "Error de Validación", { mensaje: 'El campo "cpf_cnpj" es obligatorio.' });
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
        const response = await apiNegocie.get('/api/v5/busca-credores', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.data.credores || response.data.credores.length === 0) {
            return responder(res, 404, "Sin Resultados", { 
                mensaje: "No se encontraron deudas disponibles para negociación para este CPF/CNPJ.",
                ...response.data
            }); 
        }
        
        return responder(res, 200, "Credores Encontrados", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Buscar Credores");
    }
});

/**
 * HERRAMIENTA 2: Buscar Dívidas
 * [cite: 135, 136]
 * Corresponde al paso "Informa valor da dívida"  del flujo.
 */
app.post('/api/negociacao/buscar-dividas', async (req, res) => {
    const { cpf_cnpj, financeira, crms } = req.body;
    if (!cpf_cnpj || !financeira || !crms) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "cpf_cnpj", "financeira" y "crms" son obligatorios.' }); 
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
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
 * [cite: 201, 203]
 */
app.post('/api/negociacao/buscar-acordos', async (req, res) => {
    const { cpf_cnpj, financeira, crms } = req.body;
    if (!cpf_cnpj || !financeira || !crms) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "cpf_cnpj", "financeira" y "crms" son obligatorios.' }); 
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
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
 * [cite: 297, 298]
 * Corresponde a "Apresenta oferta pagamento total" [cite: 835] y "Apresenta oferta parcelada"[cite: 849].
 */
app.post('/api/negociacao/buscar-opcoes-pagamento', async (req, res) => {
    // Extraer todos los campos necesarios del body [cite: 317]
    const { cpf_cnpj, Crm, Carteira, Contratos, DataVencimento, ValorEntrada, QuantidadeParcela, ValorParcela } = req.body;
    if (!cpf_cnpj || Crm === undefined || Carteira === undefined || !Contratos) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Los campos "cpf_cnpj", "Crm", "Carteira" y "Contratos" son obligatorios.' });
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
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
 * HERRAMIENTA 5a: Resumo Boleto (Paso intermedio obligatorio si "chamarResumoBoleto" es true)
 * [cite: 530, 532]
 */
app.post('/api/negociacao/resumo-boleto', async (req, res) => {
    const { cpf_cnpj, Crm, CodigoCarteira, Contrato, CodigoOpcao } = req.body;
    if (!cpf_cnpj || Crm === undefined || CodigoCarteira === undefined || !Contrato || !CodigoOpcao) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Campos obligatorios: "cpf_cnpj", "Crm", "CodigoCarteira", "Contrato", "CodigoOpcao".' });
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
        const body = {
            Crm,
            CodigoCarteira,
            CNPJ_CPF: cpf_cnpj,
            Contrato,
            CodigoOpcao
        }; 
        
        const response = await apiNegocie.post('/api/v5/resumo-boleto', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        }); 

        // Esta respuesta incluye el nuevo 'identificador' [cite: 555]
        return responder(res, 200, "Resumo do Boleto Gerado", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Gerar Resumo do Boleto");
    }
});

/**
 * HERRAMIENTA 5b: Emitir Boleto (Paso final de la negociación)
 * [cite: 588, 589]
 * Corresponde a "Confirma pagamento".
 */
app.post('/api/negociacao/emitir-boleto', async (req, res) => {
    const { cpf_cnpj, Crm, Carteira, Contrato, Valor, Parcelas, DataVencimento, Identificador, fase } = req.body;
    if (!cpf_cnpj || Crm === undefined || Carteira === undefined || !Contrato || Valor === undefined || Parcelas === undefined || !DataVencimento || !Identificador) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Faltan campos obligatorios para emitir el boleto.' }); 
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
        const body = {
            Crm,
            Carteira,
            CNPJ_CPF: cpf_cnpj,
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
 * [cite: 629, 635]
 */
app.post('/api/negociacao/emitir-segunda-via', async (req, res) => {
    // Este endpoint requiere muchos campos del acuerdo original [cite: 638-648]
    const { cpf_cnpj, Crm, CodigoCarteira, Id, Contrato, DataVencimento, ValorBoleto, TipoBoleto } = req.body;
    if (!cpf_cnpj || Crm === undefined || CodigoCarteira === undefined || !Id || !Contrato || !DataVencimento || ValorBoleto === undefined || !TipoBoleto) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Faltan campos obligatorios para emitir la segunda vía.' });
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
        const body = {
            ...req.body, // Pasa todos los campos recibidos
            CNPJ_CPF: cpf_cnpj,
            Fase: req.body.Fase || ""
        };
        
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
 * [cite: 285, 287]
 * Solo usar si 'permiteCancelamento' es true en 'busca-acordo'[cite: 286].
 */
app.post('/api/negociacao/cancelar-acordo', async (req, res) => {
    const { cpf_cnpj, idAcordo, crm } = req.body;
    if (!cpf_cnpj || !idAcordo || crm === undefined) {
        return responder(res, 400, "Error de Validación", { mensaje: 'Campos "cpf_cnpj", "idAcordo" y "crm" son obligatorios.' }); 
    }

    try {
        const token = await getAuthToken(cpf_cnpj);
        const body = { idAcordo, crm }; 
        
        const response = await apiNegocie.post('/api/v5/cancela-acordo', body, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        return responder(res, 200, "Cancelamento de Acordo", response.data);

    } catch (error) {
        return handleApiError(res, error, "Erro ao Cancelar Acordo");
    }
});


// --- Manejadores de Errores Globales (de tu referencia) ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    responder(res, 500, "Error Interno Grave", {
        mensaje: "Ocurrió un error inesperado en el servidor."
    });
});

app.use( (req, res) => {
    responder(res, 404, "Endpoint no Encontrado", {
        mensaje: `La ruta ${req.method} ${req.originalUrl} no existe en esta API.`
    });
});

// --- Iniciar Servidor ---

app.listen(PORT, () => {
    console.log(`Servidor de Herramientas de Negociación corriendo en el puerto ${PORT}`);
});