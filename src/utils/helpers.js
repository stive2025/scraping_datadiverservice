/**
 * Utilidades generales para el scraper
 */

/**
 * Función de delay/pausa
 * @param {number} time - Tiempo en milisegundos
 * @returns {Promise}
 */
function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

/**
 * Función de retry con backoff
 * @param {Function} fn - Función a ejecutar
 * @param {number} retries - Número de reintentos
 * @param {number} delayMs - Delay entre reintentos
 * @returns {Promise}
 */
async function retry(fn, retries = 2, delayMs = 1000) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (i < retries) {
                await delay(delayMs);
            }
        }
    }
    throw lastErr;
}

/**
 * Convierte formato de fecha DD/MM/YYYY a YYYY-MM-DD
 * @param {string} dateStr - Fecha en formato DD/MM/YYYY
 * @returns {string|null} - Fecha en formato YYYY-MM-DD o null
 */
function convertDateFormat(dateStr) {
    if (!dateStr || dateStr.trim() === '' || dateStr === ' ') {
        return null;
    }

    const s = dateStr.trim();

    // Formato dd/mm/yyyy → yyyy-mm-dd
    const slashParts = s.split('/');
    if (slashParts.length === 3) {
        const day   = slashParts[0].padStart(2, '0');
        const month = slashParts[1].padStart(2, '0');
        const year  = slashParts[2];
        return `${year}-${month}-${day}`;
    }

    // Formato yyyy-mm-dd (ya válido, tabla Genoma tras limpiar la edad)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return s;
    }

    return null;
}

/**
 * Extrae datos de una respuesta HTTP si coincide con el endpoint
 * @param {Object} params - Parámetros
 * @param {Response} params.response - Respuesta HTTP
 * @param {string} params.url - URL de la respuesta
 * @param {string} params.endpoint - Endpoint a verificar
 * @returns {Object|undefined} - Datos extraídos o undefined
 */
async function getData({response, url, endpoint}) {
    if (url.includes(endpoint)) {
        try {
            const data = await response.json();
            return data;
        } catch (err) {
            return undefined;
        }
    }
}

module.exports = {
    delay,
    retry,
    convertDateFormat,
    getData
};