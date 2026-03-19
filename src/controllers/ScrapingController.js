const { consoleLogger } = require('../utils/logger');
const DataTransformService = require('../services/DataTransformService');

class ScrapingController {
    constructor(scrapingService) {
        this.scrapingService = scrapingService;
    }

    /**
     * Endpoint para consulta en formato original con manejo transparente de errores
     */
    async getTitle(req, res) {
        const dni = req.params.name;
        const startTime = Date.now();
        
        try {
            consoleLogger.info('🔍 Nueva consulta recibida', { 
                dni, 
                endpoint: '/title'
            });

            const rawData = await this.scrapingService.scrapeData(dni, '/title');

            if (rawData && rawData.__invalid) {
                return res.status(400).json({
                    success: false,
                    found: false,
                    dni,
                    message: 'Cédula inválida — debe tener exactamente 10 dígitos numéricos'
                });
            }

            if (rawData && rawData.__notFound) {
                return res.status(404).json({
                    success: false,
                    found: false,
                    dni,
                    message: 'Cédula no encontrada en DataDiverService'
                });
            }

            const structuredData = DataTransformService.transformToStructuredFormat(rawData);
            res.json(structuredData);

        } catch (error) {
            const responseTime = Date.now() - startTime;

            // Solo devolver error si realmente no se pudo completar tras todos los reintentos
            consoleLogger.error('❌ Error en consulta tras reintentos automáticos', {
                dni,
                endpoint: '/title',
                error: error.message,
                responseTime: responseTime + 'ms'
            });

            // Devolver error genérico sin mencionar sesión (ya se manejó internamente)
            res.status(500).json({ 
                success: false, 
                error: 'Error procesando consulta, intente nuevamente',
                dni: dni
            });
        }
    }

    /**
     * Endpoint para consulta en formato estructurado con manejo transparente de errores
     */
    async getClient(req, res) {
        const dni = req.params.name;
        const startTime = Date.now();
        
        try {
            consoleLogger.info('🔍 Nueva consulta estructurada recibida', { 
                dni, 
                endpoint: '/client'
            });

            const rawData = await this.scrapingService.scrapeData(dni, '/client');

            if (rawData && rawData.__invalid) {
                return res.status(400).json({
                    success: false,
                    found: false,
                    dni,
                    message: 'Cédula inválida — debe tener exactamente 10 dígitos numéricos'
                });
            }

            if (rawData && rawData.__notFound) {
                return res.status(404).json({
                    success: false,
                    found: false,
                    dni,
                    message: 'Cédula no encontrada en DataDiverService'
                });
            }

            const structuredData = DataTransformService.transformToStructuredFormat(rawData);
            res.json(structuredData);

        } catch (error) {
            const responseTime = Date.now() - startTime;

            // Solo devolver error si realmente no se pudo completar tras todos los reintentos
            consoleLogger.error('❌ Error en consulta estructurada tras reintentos automáticos', {
                dni,
                endpoint: '/client',
                error: error.message,
                responseTime: responseTime + 'ms'
            });

            // Devolver error genérico sin mencionar sesión (ya se manejó internamente)
            res.status(500).json({ 
                success: false, 
                error: 'Error procesando consulta, intente nuevamente',
                dni: dni
            });
        }
    }
}

module.exports = ScrapingController;