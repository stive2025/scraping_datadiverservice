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

            // Realizar scraping con reintentos automáticos transparentes
            const rawData = await this.scrapingService.scrapeData(dni, '/title');
            
            // Transformar a formato estructurado
            const structuredData = DataTransformService.transformToStructuredFormat(rawData);
            
            const responseTime = Date.now() - startTime;
            consoleLogger.info('✅ Consulta completada exitosamente', {
                dni,
                endpoint: '/title',
                responseTime: responseTime + 'ms'
            });

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

            // Realizar scraping con reintentos automáticos transparentes
            const rawData = await this.scrapingService.scrapeData(dni, '/client');
            
            // Transformar a formato estructurado
            const structuredData = DataTransformService.transformToStructuredFormat(rawData);
            
            const responseTime = Date.now() - startTime;
            consoleLogger.info('✅ Consulta estructurada completada exitosamente', {
                dni,
                endpoint: '/client',
                responseTime: responseTime + 'ms'
            });

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