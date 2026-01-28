const { logger, consoleLogger } = require('../utils/logger');
const config = require('../config');
const { delay } = require('../utils/helpers');

class FamilyService {
    constructor(authService) {
        this.authService = authService;
        this.familyCache = new Map();
        this.failedAttempts = new Map(); // Rastrear intentos fallidos
    }

    /**
     * Intenta múltiples endpoints para obtener datos de familia con estrategia de doble consulta
     */
    async tryMultipleFamilyEndpoints(dni) {
        // Verificar cache primero
        const cacheKey = dni;
        const cached = this.familyCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < config.cache.familyTTL) {
            logger.debug('Usando datos de familia desde cache', { dni, cacheAge: Date.now() - cached.timestamp });
            return cached.data;
        }

        // Verificar si hemos fallado recientemente con este DNI
        const failedAttempt = this.failedAttempts.get(dni);
        if (failedAttempt && (Date.now() - failedAttempt.timestamp) < 60000) { // 1 minuto
            logger.debug('DNI falló recientemente, aplicando estrategia de doble consulta', { dni });
        }

        let combinedFamilyData = { family: [], data: [], results: [], relatives: [], parentesco: [] };
        let totalMembers = 0;

        // ESTRATEGIA DE DOBLE CONSULTA
        // Primera consulta: Activar carga de datos en DataDiverService
        logger.info('Iniciando estrategia de doble consulta para familia', { dni });
        
        const firstAttemptData = await this._performFamilyCapture(dni, 1);
        const firstAttemptMembers = this._getTotalMembers(firstAttemptData);
        
        logger.info('Primera consulta completada', { 
            dni, 
            membersFound: firstAttemptMembers 
        });

        // Si la primera consulta obtuvo pocos o ningún resultado, hacer segunda consulta
        if (firstAttemptMembers < 2) {
            logger.info('Pocos miembros en primera consulta, esperando y reintentando', { dni });
            
            // Esperar para que DataDiverService procese los datos
            await delay(2000); // Reducido de 3s a 2s para optimizar velocidad
            
            // Segunda consulta: Obtener datos completos
            const secondAttemptData = await this._performFamilyCapture(dni, 2);
            const secondAttemptMembers = this._getTotalMembers(secondAttemptData);
            
            logger.info('Segunda consulta completada', { 
                dni, 
                membersFound: secondAttemptMembers,
                improvement: secondAttemptMembers - firstAttemptMembers
            });

            // Usar los datos de la consulta que obtuvo más resultados
            if (secondAttemptMembers > firstAttemptMembers) {
                combinedFamilyData = secondAttemptData;
                totalMembers = secondAttemptMembers;
                logger.info('Usando datos de segunda consulta (mejores resultados)', { dni });
            } else {
                // Combinar ambos resultados
                combinedFamilyData = this._combineMultipleFamilyData([firstAttemptData, secondAttemptData]);
                totalMembers = this._getTotalMembers(combinedFamilyData);
                logger.info('Combinando datos de ambas consultas', { dni, totalMembers });
            }
        } else {
            // Primera consulta fue exitosa
            combinedFamilyData = firstAttemptData;
            totalMembers = firstAttemptMembers;
            logger.info('Primera consulta fue exitosa', { dni, totalMembers });
        }

        // Si aún no tenemos suficientes datos, intentar tercera consulta con delay más largo
        if (totalMembers < 1) {
            logger.info('Datos insuficientes, intentando tercera consulta con delay extendido', { dni });
            
            await delay(3000); // Reducido de 5s a 3s para optimizar velocidad
            
            const thirdAttemptData = await this._performFamilyCapture(dni, 3);
            const thirdAttemptMembers = this._getTotalMembers(thirdAttemptData);
            
            if (thirdAttemptMembers > totalMembers) {
                combinedFamilyData = thirdAttemptData;
                totalMembers = thirdAttemptMembers;
                logger.info('Tercera consulta exitosa', { dni, totalMembers });
            }
        }

        // Eliminar duplicados finales
        this._removeDuplicates(combinedFamilyData);
        totalMembers = this._getTotalMembers(combinedFamilyData);

        logger.info('Estrategia de doble consulta completada', {
            dni,
            finalTotalMembers: totalMembers,
            familyCount: combinedFamilyData.family.length,
            dataCount: combinedFamilyData.data.length,
            resultsCount: combinedFamilyData.results.length,
            relativesCount: combinedFamilyData.relatives.length,
            parentescoCount: combinedFamilyData.parentesco ? combinedFamilyData.parentesco.length : 0
        });

        // Guardar en cache si obtuvimos datos
        if (totalMembers > 0) {
            this.familyCache.set(cacheKey, {
                data: combinedFamilyData,
                timestamp: Date.now()
            });
            
            // Limpiar intento fallido si existía
            this.failedAttempts.delete(dni);
            
            this._cleanOldCache();
            
            consoleLogger.info('Familia capturada con estrategia de doble consulta', {
                dni,
                totalMembers,
                cached: true
            });
        } else {
            // Registrar intento fallido
            this.failedAttempts.set(dni, {
                timestamp: Date.now(),
                attempts: 3 // Indicar que se hicieron múltiples intentos
            });
            
            logger.warn('Estrategia de doble consulta no obtuvo resultados', { dni });
        }
        
        return combinedFamilyData;
    }

    /**
     * Realiza una captura completa de familia (todos los endpoints)
     */
    async _performFamilyCapture(dni, attemptNumber) {
        // Endpoints principales con más variaciones
        const primaryEndpoints = [
            `${config.datadiverservice.apiUrl}/ds/crn/client/info/family/new?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crn/client/info/family?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crm/client/family?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crn/client/genoma?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crn/client/info/relatives?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crm/client/relatives?dni=${dni}`
        ];

        // Endpoints alternativos para casos difíciles
        const alternativeEndpoints = [
            `${config.datadiverservice.apiUrl}/ds/crn/client/family?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crm/client/info/family?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crn/client/relatives/new?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crm/client/genoma?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crn/client/info/parentesco?dni=${dni}`,
            `${config.datadiverservice.apiUrl}/ds/crm/client/parentesco?dni=${dni}`
        ];

        let combinedFamilyData = { family: [], data: [], results: [], relatives: [], parentesco: [] };
        let successfulEndpoints = 0;
        let totalAttempts = 0;
        let hasValidToken = true;

        // En el primer intento, usar solo endpoints principales para activar carga
        // En intentos posteriores, usar todos los endpoints
        const endpointsToUse = attemptNumber === 1 ? primaryEndpoints : [...primaryEndpoints, ...alternativeEndpoints];
        
        logger.debug('Iniciando captura de familia', { 
            dni, 
            attemptNumber, 
            endpointsCount: endpointsToUse.length 
        });

        for (const endpoint of endpointsToUse) {
            if (!hasValidToken) break;
            
            totalAttempts++;
            try {
                logger.debug('Intentando endpoint de familia', { 
                    endpoint, 
                    dni, 
                    attempt: totalAttempts, 
                    captureAttempt: attemptNumber 
                });
                
                const response = await this._fetchWithRetry(endpoint, dni, 1); // Reducido de 2 a 1 reintento para velocidad
                
                if (response.status === 401 || response.status === 403) {
                    logger.warn('Token expirado en endpoint de familia', { endpoint, dni, status: response.status });
                    hasValidToken = false;
                    break;
                }
                
                if (response.ok) {
                    const data = await response.json();
                    successfulEndpoints++;
                    
                    logger.debug('Datos obtenidos del endpoint', { 
                        endpoint, 
                        dni,
                        attemptNumber,
                        dataKeys: Object.keys(data),
                        hasData: !!data && Object.keys(data).length > 0
                    });
                    
                    this._combineData(combinedFamilyData, data);
                } else {
                    logger.debug('Respuesta no exitosa del endpoint', { 
                        endpoint, 
                        dni, 
                        attemptNumber,
                        status: response.status,
                        statusText: response.statusText
                    });
                }
                
                // Pausa optimizada para velocidad
                const pauseTime = attemptNumber === 1 ? 150 : 300; // Reducido: 200→150, 400→300
                await delay(pauseTime);
                
            } catch (error) {
                logger.debug('Error en endpoint de familia', { 
                    endpoint, 
                    dni, 
                    attemptNumber,
                    error: error.message,
                    attempt: totalAttempts
                });
                
                if (error.name === 'AbortError') {
                    continue;
                }
            }
        }

        logger.debug('Captura de familia completada', {
            dni,
            attemptNumber,
            successfulEndpoints,
            totalAttempts,
            membersFound: this._getTotalMembers(combinedFamilyData)
        });

        return combinedFamilyData;
    }

    /**
     * Combina múltiples conjuntos de datos de familia
     */
    _combineMultipleFamilyData(familyDataSets) {
        const combined = { family: [], data: [], results: [], relatives: [], parentesco: [] };
        
        familyDataSets.forEach((familyData, index) => {
            logger.debug('Combinando conjunto de datos', { 
                index, 
                members: this._getTotalMembers(familyData) 
            });
            
            const keys = ['family', 'data', 'results', 'relatives', 'parentesco'];
            keys.forEach(key => {
                if (familyData[key] && Array.isArray(familyData[key])) {
                    combined[key].push(...familyData[key]);
                }
            });
        });
        
        // Eliminar duplicados después de combinar
        this._removeDuplicates(combined);
        
        return combined;
    }

    /**
     * Fetch con reintentos automáticos y token sincronizado
     */
    async _fetchWithRetry(endpoint, dni, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Obtener headers frescos para cada intento
                const headers = await this.authService.getFreshAuthHeaders();
                
                const response = await fetch(endpoint, {
                    headers: {
                        ...headers,
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    },
                    signal: AbortSignal.timeout(10000) // Reducido de 15s a 10s para velocidad
                });
                
                return response;
                
            } catch (error) {
                lastError = error;
                logger.debug('Intento fallido en fetch', { 
                    endpoint, 
                    dni, 
                    attempt, 
                    maxRetries, 
                    error: error.message 
                });
                
                if (attempt < maxRetries) {
                    // Espera exponencial: 500ms, 1s, 2s
                    const waitTime = 500 * Math.pow(2, attempt - 1);
                    await delay(waitTime);
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Intenta capturar datos navegando directamente a páginas específicas
     */
    async _tryNavigationBasedCapture(dni) {
        // Esta función se implementaría si necesitamos navegación directa
        // Por ahora retornamos null para mantener la compatibilidad
        logger.debug('Navegación directa no implementada aún', { dni });
        return null;
    }

    /**
     * Combina datos de diferentes estructuras con más variaciones
     */
    _combineData(combinedData, data) {
        // Combinar datos de estructuras conocidas
        const knownKeys = ['family', 'data', 'results', 'relatives', 'parentesco'];
        
        knownKeys.forEach(key => {
            if (data[key] && Array.isArray(data[key])) {
                if (!combinedData[key]) combinedData[key] = [];
                combinedData[key].push(...data[key]);
                logger.debug(`Agregados datos de ${key}`, { count: data[key].length });
            }
        });
        
        // Si data es directamente un array
        if (Array.isArray(data)) {
            combinedData.family.push(...data);
            logger.debug('Agregados datos directos como array', { count: data.length });
        }
        
        // Buscar propiedades que puedan contener familia con nombres variados
        const familyKeywords = [
            'familia', 'parientes', 'relatives', 'relations', 'members', 'miembros',
            'padres', 'parents', 'hijos', 'children', 'hermanos', 'siblings',
            'esposa', 'esposo', 'spouse', 'conyuge', 'pareja'
        ];
        
        for (const [key, value] of Object.entries(data)) {
            if (Array.isArray(value) && value.length > 0 && !knownKeys.includes(key)) {
                const keyLower = key.toLowerCase();
                const seemsFamilyKey = familyKeywords.some(keyword => keyLower.includes(keyword));
                
                if (seemsFamilyKey) {
                    combinedData.family.push(...value);
                    logger.debug('Agregados datos de clave familiar detectada', { 
                        key, 
                        count: value.length 
                    });
                } else {
                    // Verificar si el contenido parece datos de familia
                    const firstItem = value[0];
                    if (firstItem && this._seemsFamilyData(firstItem)) {
                        combinedData.family.push(...value);
                        logger.debug('Agregados datos de propiedad que parece familiar', { 
                            key, 
                            count: value.length 
                        });
                    }
                }
            }
        }
    }

    /**
     * Verifica si un objeto parece contener datos de familia
     */
    _seemsFamilyData(item) {
        const familyFields = [
            'fullname', 'dni', 'name', 'relationship', 'parentesco', 'relation',
            'age', 'gender', 'dateOfBirth', 'civilStatus', 'nombre', 'cedula',
            'identificacion', 'edad', 'genero', 'sexo', 'fechaNacimiento'
        ];
        
        const itemKeys = Object.keys(item);
        const matchingFields = familyFields.filter(field => itemKeys.includes(field));
        
        // Si tiene al menos 2 campos que parecen de familia, probablemente lo es
        return matchingFields.length >= 2;
    }

    /**
     * Elimina duplicados basados en múltiples criterios
     */
    _removeDuplicates(combinedData) {
        const seenIdentifiers = new Set();
        const keys = ['family', 'data', 'results', 'relatives', 'parentesco'];
        
        keys.forEach(key => {
            if (!combinedData[key]) return;
            
            combinedData[key] = combinedData[key].filter(member => {
                // Múltiples formas de identificar duplicados
                const memberDni = member.dni || member.identification || member.cedula || member.identificacion;
                const memberName = member.fullname || member.name || member.nombre;
                const memberAge = member.age || member.edad;
                const memberGender = member.gender || member.genero || member.sexo;
                
                // Crear identificador compuesto
                const identifiers = [
                    memberDni,
                    memberName,
                    memberDni && memberName ? `${memberDni}-${memberName}` : null,
                    memberName && memberAge ? `${memberName}-${memberAge}` : null,
                    memberName && memberGender ? `${memberName}-${memberGender}` : null
                ].filter(Boolean);
                
                // Si algún identificador ya existe, es duplicado
                const isDuplicate = identifiers.some(id => seenIdentifiers.has(id));
                
                if (!isDuplicate) {
                    identifiers.forEach(id => seenIdentifiers.add(id));
                    return true;
                }
                
                return false;
            });
        });
    }

    /**
     * Obtiene el total de miembros de familia
     */
    _getTotalMembers(combinedData) {
        return (combinedData.family?.length || 0) + 
               (combinedData.data?.length || 0) + 
               (combinedData.results?.length || 0) + 
               (combinedData.relatives?.length || 0) +
               (combinedData.parentesco?.length || 0);
    }

    /**
     * Limpia cache antiguo y intentos fallidos
     */
    _cleanOldCache() {
        const now = Date.now();
        
        // Limpiar cache de familia
        for (const [key, value] of this.familyCache.entries()) {
            if (now - value.timestamp > config.cache.familyTTL) {
                this.familyCache.delete(key);
            }
        }
        
        // Limpiar intentos fallidos antiguos (más de 5 minutos)
        for (const [key, value] of this.failedAttempts.entries()) {
            if (now - value.timestamp > 300000) {
                this.failedAttempts.delete(key);
            }
        }
    }

    /**
     * Limpia todo el cache
     */
    clearCache() {
        const cacheSize = this.familyCache.size;
        const failedSize = this.failedAttempts.size;
        
        this.familyCache.clear();
        this.failedAttempts.clear();
        
        return { cacheSize, failedSize };
    }

    /**
     * Obtiene estadísticas del cache
     */
    getCacheStats() {
        const stats = {
            cache: {
                size: this.familyCache.size,
                entries: []
            },
            failedAttempts: {
                size: this.failedAttempts.size,
                entries: []
            }
        };
        
        for (const [dni, data] of this.familyCache.entries()) {
            stats.cache.entries.push({
                dni,
                timestamp: new Date(data.timestamp).toISOString(),
                age: Date.now() - data.timestamp,
                totalMembers: this._getTotalMembers(data.data)
            });
        }
        
        for (const [dni, data] of this.failedAttempts.entries()) {
            stats.failedAttempts.entries.push({
                dni,
                timestamp: new Date(data.timestamp).toISOString(),
                age: Date.now() - data.timestamp,
                attempts: data.attempts
            });
        }
        
        return stats;
    }

    /**
     * Fuerza reintento para un DNI específico
     */
    forceRetry(dni) {
        this.familyCache.delete(dni);
        this.failedAttempts.delete(dni);
        logger.info('Cache y intentos fallidos limpiados para DNI', { dni });
    }
}

module.exports = FamilyService;