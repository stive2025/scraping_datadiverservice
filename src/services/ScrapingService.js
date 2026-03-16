const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');

/**
 * ScrapingService — obtiene datos de clientes via API HTTP directa.
 *
 * Ya no usa Puppeteer ni navegación browser. Llama a HttpService que hace
 * requests directos a la API de DataDiverService con Bearer token.
 *
 * Mantiene: cache de resultados, deduplicación in-flight, validación de cédula.
 */
class ScrapingService {
    constructor(authService, httpService, keepAliveService = null, familyService = null) {
        this.authService = authService;
        this.httpService = httpService;
        this.keepAliveService = keepAliveService;
        this.familyService = familyService;
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageResponseTime: 0,
            cacheHits: 0
        };
        this.lastRequestTime = Date.now();
        this._inFlight = new Map();
        this._resultCache = new Map();
    }

    /**
     * Punto de entrada principal. Aplica cache y deduplicación antes de consultar la API.
     */
    async scrapeData(dni, endpoint = '/title', maxRetries = 2) {
        this.stats.totalRequests++;
        this.lastRequestTime = Date.now();

        if (this.keepAliveService) {
            this.keepAliveService.updateLastRequestTime();
        }

        const dniStr = String(dni || '').trim();
        if (!/^\d{10}$/.test(dniStr)) {
            logger.warn('Cédula rechazada: no tiene 10 dígitos', { dni: dniStr });
            return { __invalid: true, dni: dniStr };
        }

        // Verificar cache
        const cached = this._resultCache.get(dniStr);
        if (cached) {
            const ttl = cached.notFound ? (2 * 60 * 1000) : config.cache.resultTTL;
            if (Date.now() - cached.timestamp < ttl) {
                this.stats.cacheHits++;
                this.stats.successfulRequests++;
                logger.debug('Resultado servido desde cache', { dni: dniStr });
                consoleLogger.queryStart(dniStr);
                consoleLogger.queryComplete(dniStr, 0, !cached.notFound);
                return cached.data;
            }
        }

        // Deduplicación in-flight: si este DNI ya está siendo consultado, esperar el mismo resultado
        if (this._inFlight.has(dniStr)) {
            logger.debug('DNI ya en proceso, esperando resultado compartido', { dni: dniStr });
            return this._inFlight.get(dniStr);
        }

        const promise = this._fetchData(dniStr, maxRetries)
            .then(data => {
                if (data && data.info_general && Object.keys(data.info_general).length > 0) {
                    this._resultCache.set(dniStr, { data, timestamp: Date.now(), notFound: false });
                    this._cleanResultCache();
                }
                return data;
            })
            .catch(err => {
                logger.warn('Error en consulta (no cacheado)', { dni: dniStr, error: err.message });
                throw err;
            })
            .finally(() => {
                this._inFlight.delete(dniStr);
            });

        this._inFlight.set(dniStr, promise);
        return promise;
    }

    /**
     * Consulta todos los endpoints de la API en paralelo y construye el rawData
     * en el formato que espera DataTransformService.
     */
    async _fetchData(dni, maxRetries) {
        const startTime = Date.now();
        consoleLogger.queryStart(dni);

        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Ejecutar consulta principal y familia en paralelo
                const [apiData, extendedFamily] = await Promise.all([
                    this.httpService.fetchAll(dni),
                    this.familyService
                        ? this.familyService.tryMultipleFamilyEndpoints(dni).catch(err => {
                            logger.warn('FamilyService falló, usando solo datos del endpoint general', { dni, error: err.message });
                            return { family: [], data: [], results: [], relatives: [], parentesco: [] };
                        })
                        : Promise.resolve({ family: [], data: [], results: [], relatives: [], parentesco: [] })
                ]);

                // Si el endpoint principal no devolvió datos → DNI no existe
                if (!apiData.general) {
                    this.stats.successfulRequests++;
                    const responseTime = Date.now() - startTime;
                    this._updateAverageResponseTime(responseTime);
                    consoleLogger.queryComplete(dni, responseTime, false);
                    logger.info('DNI no encontrado via API', { dni });
                    return { __notFound: true, dni };
                }

                // Combinar familia de todas las fuentes:
                // 1. apiData.general.family   → campo family del endpoint general/new
                // 2. apiData.family            → endpoint family/new o family (directo via HttpService)
                // 3. extendedFamily            → FamilyService (intenta múltiples endpoints adicionales)
                const generalFamily  = apiData.general.family || [];
                const httpFamily     = this._extractFamilyArray(apiData.family);
                const info_family = {
                    family:     [...generalFamily, ...httpFamily, ...(extendedFamily.family    || [])],
                    data:       extendedFamily.data      || [],
                    results:    extendedFamily.results   || [],
                    relatives:  extendedFamily.relatives || [],
                    parentesco: extendedFamily.parentesco|| []
                };

                logger.info('Familia combinada', {
                    dni,
                    generalFamilyCount:  generalFamily.length,
                    httpFamilyCount:     httpFamily.length,
                    extendedFamilyCount: extendedFamily.family?.length || 0,
                    totalBeforeDedup:    info_family.family.length
                });

                // Construir rawData en formato esperado por DataTransformService
                const rawData = {
                    info_general: {
                        ...apiData.general,
                        id: apiData.general.id || null
                    },
                    info_contacts: this._mapContactData(apiData.contact),
                    info_family
                };

                this.stats.successfulRequests++;
                const responseTime = Date.now() - startTime;
                this._updateAverageResponseTime(responseTime);
                consoleLogger.queryComplete(dni, responseTime, true);

                return rawData;

            } catch (err) {
                lastError = err;
                if (attempt < maxRetries) {
                    logger.warn('Error en consulta API, reintentando', {
                        dni, error: err.message, attempt: attempt + 1
                    });
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        }

        this.stats.failedRequests++;
        const responseTime = Date.now() - startTime;
        consoleLogger.queryComplete(dni, responseTime, false);
        logger.error('Error en consulta tras reintentos', { dni, error: lastError.message });
        throw lastError;
    }

    /**
     * Mapea la respuesta del endpoint /contact al formato { phones, emails, address }
     * que espera DataTransformService.
     */
    /**
     * Extrae el array de miembros de familia de la respuesta del endpoint /family o /family/new.
     * La API puede devolver { family: [...] }, { data: [...] }, o directamente un array.
     */
    _extractFamilyArray(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        // Buscar en las claves más comunes
        for (const key of ['family', 'data', 'results', 'relatives', 'parentesco']) {
            if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
        }
        return [];
    }

    _mapContactData(contact) {
        if (!contact) return { phones: [], emails: [], address: [] };

        // Algunos endpoints envuelven la respuesta en .data o .result
        const c = contact.data || contact.result || contact;

        return {
            phones:  this._toArray(c.phones   || c.telefonos       || c.phone_numbers   || []),
            emails:  this._toArray(c.emails   || c.correos         || c.email_addresses || []),
            address: this._toArray(c.address  || c.addresses       || c.direcciones     || [])
        };
    }

    _toArray(val) {
        return Array.isArray(val) ? val : [];
    }

    /**
     * Valida cédula ecuatoriana: 10 dígitos, provincia 01-24, dígito verificador Módulo 10.
     */
    _isValidEcuadorianCedula(dni) {
        if (!/^\d{10}$/.test(dni)) return false;

        const province = parseInt(dni.substring(0, 2), 10);
        if (province < 1 || province > 24) return false;

        const thirdDigit = parseInt(dni[2], 10);

        if (thirdDigit <= 5) {
            const coeff = [2, 1, 2, 1, 2, 1, 2, 1, 2];
            let sum = 0;
            for (let i = 0; i < 9; i++) {
                let val = parseInt(dni[i], 10) * coeff[i];
                if (val >= 10) val -= 9;
                sum += val;
            }
            const check = (10 - (sum % 10)) % 10;
            return check === parseInt(dni[9], 10);
        }

        return thirdDigit === 6 || thirdDigit === 9;
    }

    _updateAverageResponseTime(responseTime) {
        const total = this.stats.successfulRequests + this.stats.failedRequests;
        this.stats.averageResponseTime = total > 1
            ? Math.round((this.stats.averageResponseTime * (total - 1) + responseTime) / total)
            : responseTime;
    }

    _cleanResultCache() {
        const now = Date.now();
        for (const [key, val] of this._resultCache.entries()) {
            const ttl = val.notFound ? (2 * 60 * 1000) : config.cache.resultTTL;
            if (now - val.timestamp > ttl) {
                this._resultCache.delete(key);
            }
        }
    }

    get statistics() {
        const total = this.stats.successfulRequests + this.stats.failedRequests;
        return {
            ...this.stats,
            successRate:         total > 0 ? ((this.stats.successfulRequests / total) * 100).toFixed(1) + '%' : 'N/A',
            averageResponseTime: this.stats.averageResponseTime + 'ms',
            cacheSize:           this._resultCache.size
        };
    }
}

module.exports = ScrapingService;
