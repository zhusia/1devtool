"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDeviceServer = startDeviceServer;
/**
 * Device federation HTTP + Socket.IO server. Deliberately its OWN small stack
 * rather than a namespace on the phone Remote server: the plan's §4.1 gate
 * means this must be startable/stoppable independent of whether phone Remote
 * is enabled, and the phone server carries static UI + proxy surface this
 * peer-to-peer door must not expose. Only two HTTP routes exist:
 * POST /api/device-pair and GET /api/device-health. Everything else is the
 * authenticated /device Socket.IO namespace, wired by the service.
 */
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const socket_io_1 = require("socket.io");
async function startDeviceServer(opts) {
    const app = (0, express_1.default)();
    app.disable('x-powered-by');
    app.use(express_1.default.json({ limit: '64kb' }));
    app.get('/api/device-health', (_req, res) => {
        res.json({ ok: true });
    });
    app.post('/api/device-pair', (req, res) => {
        try {
            const result = opts.handlePairRequest(req.body, req.socket.remoteAddress || '');
            res.status(result.status).json(result.body);
        }
        catch {
            res.status(500).json({ error: { code: 'DEVICE_INTERNAL', message: 'Pairing failed' } });
        }
    });
    const httpServer = http_1.default.createServer(app);
    const io = new socket_io_1.Server(httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        maxHttpBufferSize: 8 * 1024 * 1024,
        pingTimeout: 30_000,
        pingInterval: 10_000,
        transports: ['websocket'],
    });
    const nsp = io.of('/device');
    const port = await listenWithFallback(httpServer, opts.preferredPort, '0.0.0.0');
    return {
        port,
        httpServer,
        io,
        nsp,
        close: async () => {
            nsp.disconnectSockets(true);
            io.close();
            await new Promise((resolve) => {
                httpServer.close(() => resolve());
                setTimeout(() => resolve(), 3000);
            });
        },
    };
}
/** Same EADDRINUSE walk-forward policy as RemoteServer.listenWithFallback. */
function listenWithFallback(server, startPort, host, maxAttempts = 20) {
    return new Promise((resolve, reject) => {
        let port = startPort;
        let attempts = 0;
        const cleanup = () => {
            server.off('error', onError);
            server.off('listening', onListening);
        };
        const onError = (err) => {
            if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
                attempts++;
                port++;
                setImmediate(() => server.listen(port, host));
                return;
            }
            cleanup();
            reject(err.code === 'EADDRINUSE' ? new Error(`No free device port in range ${startPort}–${port}.`) : err);
        };
        const onListening = () => {
            cleanup();
            server.on('error', () => { });
            resolve(port);
        };
        server.on('error', onError);
        server.on('listening', onListening);
        server.listen(port, host);
    });
}
