const { consoleLogger } = require('../utils/logger');
const config = require('../config');

class FamilyController {
    constructor(familyService, authService) {
        this.familyService = familyService;
        this.authService = authService;
    }

    /**
     * Prueba detallada de captura de familia
     */
    async testFamily(req, res) {
        try {
            if (!this.authService.token) {
                return res.status(401).json({ error: 'No hay token válido' });
            }
            
            const dni = req.params.name;
            consoleLogger.info('Probando captura detallada de familia', { dni });
            
            const familyData = await this.familyService.tryMultipleFamilyEndpoints(dni);
            const totalMembers = this.familyService._getTotalMembers(familyData);
            
            // Crear resumen detallado
            const summary = {
                family: this._createMemberSummary(familyData.family),
                data: this._createMemberSummary(familyData.data),
                results: this._createMemberSummary(familyData.results),
                relatives: familyData.relatives ? this._createMemberSummary(familyData.relatives) : []
            };
            
            res.json({
                success: true,
                dni,
                totalMembers,
                summary,
                rawData: familyData,
                debug: {
                    familyCount: familyData.family.length,
                    dataCount: familyData.data.length,
                    resultsCount: familyData.results.length,
                    relativesCount: familyData.relatives ? familyData.relatives.length : 0,
                    cacheUsed: this.familyService.familyCache.has(dni)
                }
            });
        } catch (error) {
            res.status(500).json({ 
                success: false, 
                error: error.message,
                dni: req.params.name
            });
        }
    }

    /**
     * Debug completo de endpoints de familia
     */
    async debugFamilyEndpoints(req, res) {
        try {
            if (!this.authService.token) {
                return res.status(401).json({ error: 'No hay token válido' });
            }
            
            const dni = req.params.name;
            const familyEndpoints = [
                `${config.datadiverservice.apiUrl}/ds/crn/client/info/family/new?dni=${dni}`,
                `${config.datadiverservice.apiUrl}/ds/crn/client/info/family?dni=${dni}`,
                `${config.datadiverservice.apiUrl}/ds/crm/client/family?dni=${dni}`,
                `${config.datadiverservice.apiUrl}/ds/crn/client/genoma?dni=${dni}`,
                `${config.datadiverservice.apiUrl}/ds/crn/client/info/relatives?dni=${dni}`,
                `${config.datadiverservice.apiUrl}/ds/crm/client/relatives?dni=${dni}`
            ];
            
            const results = [];
            
            for (const endpoint of familyEndpoints) {
                const result = await this._testSingleEndpoint(endpoint);
                results.push(result);
            }
            
            res.json({
                dni,
                timestamp: new Date().toISOString(),
                tokenValid: !!this.authService.token,
                results
            });
            
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message,
                dni: req.params.name
            });
        }
    }

    /**
     * Diagnóstico avanzado de problemas de familia
     */
    async diagnoseFamilyIssues(req, res) {
        try {
            if (!this.authService.token) {
                return res.status(401).json({ error: 'No hay token válido' });
            }
            
            const dni = req.params.name;
            consoleLogger.info('Iniciando diagnóstico avanzado de familia', { dni });
            
            // Limpiar cache para este DNI
            this.familyService.forceRetry(dni);
            
            // Intentar captura con logging detallado
            const startTime = Date.now();
            const familyData = await this.familyService.tryMultipleFamilyEndpoints(dni);
            const endTime = Date.now();
            
            const totalMembers = this.familyService._getTotalMembers(familyData);
            
            // Obtener estadísticas de cache
            const cacheStats = this.familyService.getCacheStats();
            
            // Verificar salud del token
            const tokenHealth = await this.authService.checkSessionHealth();
            
            const diagnosis = {
                dni,
                timestamp: new Date().toISOString(),
                duration: endTime - startTime + 'ms',
                success: totalMembers > 0,
                totalMembers,
                breakdown: {
                    family: familyData.family?.length || 0,
                    data: familyData.data?.length || 0,
                    results: familyData.results?.length || 0,
                    relatives: familyData.relatives?.length || 0,
                    parentesco: familyData.parentesco?.length || 0
                },
                tokenHealth,
                cacheStats,
                recommendations: []
            };
            
            // Generar recomendaciones
            if (totalMembers === 0) {
                diagnosis.recommendations.push('No se encontraron datos de familia - verificar si el DNI existe en el sistema');
                diagnosis.recommendations.push('Intentar con diferentes variaciones del DNI');
                diagnosis.recommendations.push('Verificar conectividad con DataDiverService');
            } else if (totalMembers < 2) {
                diagnosis.recommendations.push('Pocos miembros de familia encontrados - puede ser normal o indicar datos incompletos');
                diagnosis.recommendations.push('Considerar ejecutar múltiples consultas para este DNI');
            } else {
                diagnosis.recommendations.push('Captura de familia exitosa');
            }
            
            if (!tokenHealth) {
                diagnosis.recommendations.push('Token no saludable - renovar sesión');
            }
            
            res.json(diagnosis);
            
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message,
                dni: req.params.name,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * Fuerza reintento de captura de familia para un DNI específico
     */
    forceRetryFamily(req, res) {
        try {
            const dni = req.params.name;
            this.familyService.forceRetry(dni);
            
            res.json({
                success: true,
                message: `Cache y intentos fallidos limpiados para DNI ${dni}`,
                dni,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message,
                dni: req.params.name
            });
        }
    }

    /**
     * Limpiar cache de familia
     */
    clearFamilyCache(req, res) {
        const result = this.familyService.clearCache();
        res.json({ 
            success: true, 
            message: `Cache de familia limpiado. ${result.cacheSize} entradas y ${result.failedSize} intentos fallidos eliminados.`,
            ...result
        });
    }

    /**
     * Estadísticas del cache de familia
     */
    getFamilyCacheStats(req, res) {
        const stats = this.familyService.getCacheStats();
        res.json(stats);
    }

    /**
     * Crea resumen de miembros de familia
     */
    _createMemberSummary(members) {
        return members.map(m => ({
            name: m.fullname || m.name,
            dni: m.dni || m.identification,
            relationship: m.relationship || m.parentesco,
            age: m.age
        }));
    }

    /**
     * Prueba un endpoint individual
     */
    async _testSingleEndpoint(endpoint) {
        try {
            const response = await fetch(endpoint, {
                headers: this.authService.authHeaders,
                signal: AbortSignal.timeout(10000)
            });
            
            const result = {
                endpoint,
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                data: null,
                error: null
            };
            
            if (response.ok) {
                try {
                    const data = await response.json();
                    result.data = data;
                    result.dataKeys = Object.keys(data);
                    result.hasArrays = Object.entries(data).filter(([k, v]) => Array.isArray(v));
                } catch (jsonError) {
                    result.error = 'Error parsing JSON: ' + jsonError.message;
                }
            } else {
                result.error = `HTTP ${response.status}: ${response.statusText}`;
            }
            
            return result;
            
        } catch (fetchError) {
            return {
                endpoint,
                status: null,
                ok: false,
                data: null,
                error: fetchError.message
            };
        }
    }
}

module.exports = FamilyController;