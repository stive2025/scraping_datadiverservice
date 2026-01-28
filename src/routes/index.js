const express = require('express');
const ScrapingController = require('../controllers/ScrapingController');
const SystemController = require('../controllers/SystemController');
const FamilyController = require('../controllers/FamilyController');

function createRoutes(services) {
    const router = express.Router();
    
    // Inicializar controladores
    const scrapingController = new ScrapingController(services.scrapingService);
    const systemController = new SystemController(services);
    const familyController = new FamilyController(services.familyService, services.authService);

    // ============================================
    // RUTAS DE SCRAPING
    // ============================================
    router.get('/title/:name', (req, res) => scrapingController.getTitle(req, res));
    router.get('/client/:name', (req, res) => scrapingController.getClient(req, res));

    // ============================================
    // RUTAS DE SISTEMA
    // ============================================
    router.get('/ping', (req, res) => systemController.ping(req, res));
    router.get('/sessions', (req, res) => systemController.getSessions(req, res));
    router.get('/system-status', (req, res) => systemController.getSystemStatus(req, res));
    router.get('/health-check', (req, res) => systemController.getHealthCheck(req, res));
    router.post('/refresh-token', (req, res) => systemController.refreshToken(req, res));
    router.post('/force-idle-activity', (req, res) => systemController.forceIdleActivity(req, res));
    router.get('/shutdown', (req, res) => systemController.shutdown(req, res));

    // ============================================
    // RUTAS DE FAMILIA
    // ============================================
    router.get('/test-family/:name', (req, res) => familyController.testFamily(req, res));
    router.get('/debug-family-endpoints/:name', (req, res) => familyController.debugFamilyEndpoints(req, res));
    router.get('/diagnose-family/:name', (req, res) => familyController.diagnoseFamilyIssues(req, res));
    router.post('/clear-family-cache', (req, res) => familyController.clearFamilyCache(req, res));
    router.post('/force-retry-family/:name', (req, res) => familyController.forceRetryFamily(req, res));
    router.get('/family-cache-stats', (req, res) => familyController.getFamilyCacheStats(req, res));

    return router;
}

module.exports = createRoutes;