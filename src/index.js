const Application = require('./app');
const { logger } = require('./utils/logger');

// Manejo global de errores no capturados
process.on('uncaughtException', (err) => {
    logger.error('Excepción no capturada', { 
        error: err.message, 
        stack: err.stack 
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Rechazo no manejado en promesa', { 
        reason: reason?.message || reason,
        stack: reason?.stack
    });
    process.exit(1);
});

// Iniciar aplicación
async function main() {
    try {
        const app = new Application();
        await app.start();
    } catch (error) {
        logger.error('Error fatal iniciando aplicación', { 
            error: error.message, 
            stack: error.stack 
        });
        process.exit(1);
    }
}

main();