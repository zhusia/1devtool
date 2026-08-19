"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRemoteServer = createRemoteServer;
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
/**
 * Create the HTTP + socket.io server infrastructure for remote control.
 *
 * Returns the express app, raw HTTP server, and socket.io server so
 * RemoteServer can wire up pairing endpoints, auth middleware, and
 * event handlers.
 */
function createRemoteServer(port) {
    const expressApp = (0, express_1.default)();
    // --- Security headers ---
    expressApp.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws: wss:; frame-src *");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });
    // --- CORS for native app clients ---
    // The web UI is served from /ui (same-origin), but the native iOS/Android app
    // loads from capacitor://localhost / https://localhost and calls /api/* and
    // socket.io cross-origin. The socket.io server already allows origin:'*'; the
    // HTTP API must match so pairing (POST /api/pair) isn't blocked by the browser.
    // The endpoint is protected by the one-time cryptographic pairing secret, not
    // by origin, so '*' here doesn't weaken pairing. application/json bodies make
    // POST /api/pair a non-simple request, so its OPTIONS preflight must succeed.
    expressApp.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });
    // --- JSON body parsing for API endpoints ---
    expressApp.use(express_1.default.json({ limit: '1mb' }));
    // --- Root redirect to remote UI ---
    expressApp.get('/', (_req, res) => {
        res.redirect('/ui/');
    });
    // --- Localhost proxy: /proxy/:port/* → http://localhost:{port}/* ---
    // Lets the phone view dev servers running on the desktop (e.g. localhost:3000).
    // Only proxies to 127.0.0.1 — never to external hosts.
    expressApp.use('/proxy', (req, res, next) => {
        // Parse port from URL: /proxy/3000/path → port=3000, path=/path
        const match = req.url.match(/^\/(\d+)(\/.*)?$/);
        if (!match) {
            res.status(400).json({ error: 'Usage: /proxy/{port}/{path}' });
            return;
        }
        const port = parseInt(match[1], 10);
        if (port < 1024 || port > 65535) {
            res.status(400).json({ error: 'Port must be between 1024 and 65535' });
            return;
        }
        const targetPath = match[2] || '/';
        // Remove CSP headers for proxied content (dev servers set their own)
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Frame-Options');
        const fullPath = targetPath + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
        const fwdHeaders = { ...req.headers, host: `localhost:${port}` };
        delete fwdHeaders['accept-encoding'];
        // Try IPv6 (::1) first — macOS resolves localhost to ::1 by default,
        // and many dev servers (serve, Vite, Next) only bind to IPv6.
        // Fall back to IPv4 (127.0.0.1) if IPv6 fails.
        function doProxy(hostname, fallback) {
            const proxyReq = http_1.default.request({
                hostname,
                port,
                path: fullPath,
                method: req.method,
                headers: fwdHeaders,
                timeout: 30_000,
            }, (proxyRes) => {
                const location = proxyRes.headers['location'];
                if (location) {
                    proxyRes.headers['location'] = location
                        .replace(`http://localhost:${port}`, `/proxy/${port}`)
                        .replace(`http://127.0.0.1:${port}`, `/proxy/${port}`)
                        .replace(`http://[::1]:${port}`, `/proxy/${port}`);
                }
                const contentType = proxyRes.headers['content-type'] || '';
                const isHtml = contentType.includes('text/html');
                if (isHtml) {
                    // Buffer HTML and rewrite root-relative URLs to route through proxy.
                    // /assets/x.css → /proxy/3000/assets/x.css etc.
                    const chunks = [];
                    proxyRes.on('data', (chunk) => chunks.push(chunk));
                    proxyRes.on('end', () => {
                        let html = Buffer.concat(chunks).toString('utf-8');
                        const prefix = `/proxy/${port}`;
                        // Rewrite root-relative URLs in HTML attributes
                        // Matches: src="/ href="/ action="/ srcset="/ and single-quote variants
                        html = html.replace(/((?:src|href|action|srcset|poster|data)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}/`);
                        // Rewrite url(/) in inline styles and <style> blocks
                        html = html.replace(/url\(\s*["']?\//g, `url(${prefix}/`);
                        // Rewrite fetch/XMLHttpRequest calls with root-relative paths in scripts
                        // Handles: fetch("/api/...") and fetch('/api/...')
                        html = html.replace(/(fetch\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}/`);
                        // Inject a small script that patches fetch and XMLHttpRequest
                        // to rewrite root-relative URLs at runtime (catches dynamic JS)
                        const patchScript = `<script>
(function(){
  var P="${prefix}";
  var _f=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith(P))u=P+u;
    return _f.call(this,u,o);
  };
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==="string"&&u.startsWith("/")&&!u.startsWith(P))u=P+u;
    return _o.apply(this,arguments);
  };
  function rw(u){return typeof u==="string"&&u.startsWith("/")&&!u.startsWith(P)?P+u:u;}
  var _ps=history.pushState.bind(history);
  history.pushState=function(s,t,u){return _ps(s,t,u?rw(u):u);};
  var _rs=history.replaceState.bind(history);
  history.replaceState=function(s,t,u){return _rs(s,t,u?rw(u):u);};
  var _loc=Object.getOwnPropertyDescriptor(window,'location')||{};
  document.addEventListener("click",function(e){
    var a=e.target;while(a&&a.tagName!=="A")a=a.parentElement;
    if(!a||!a.href)return;
    var h=a.getAttribute("href");
    if(h&&h.startsWith("/")&&!h.startsWith(P)&&!h.startsWith("//")&&!h.startsWith("/#")){
      e.preventDefault();
      window.location.href=P+h;
    }
  },true);
  window.addEventListener("message",function(e){
    if(!e.data)return;
    if(e.data.type==="1dt-get-scroll"){
      var se=document.scrollingElement||document.documentElement||document.body;
      var y=window.scrollY||window.pageYOffset||se.scrollTop||0;
      e.source.postMessage({type:"1dt-scroll",scrollY:y},"*");
    }
    if(e.data.type==="1dt-capture"){
      var src=e.source;
      if(window.__h2c){doCapture(src);return;}
      var s=document.createElement("script");
      s.src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      s.onload=function(){window.__h2c=window.html2canvas;doCapture(src);};
      s.onerror=function(){src.postMessage({type:"1dt-screenshot",error:"Failed to load capture library"},"*");};
      document.head.appendChild(s);
    }
  });
  function doCapture(src){
    var w=window.innerWidth,h=window.innerHeight;
    window.__h2c(document.body,{
      width:w,height:h,
      x:window.scrollX||0,y:window.scrollY||0,
      scrollX:0,scrollY:0,
      windowWidth:w,windowHeight:h,
      useCORS:true,allowTaint:true,
      backgroundColor:null,logging:false
    }).then(function(c){
      src.postMessage({type:"1dt-screenshot",imageData:c.toDataURL("image/png")},"*");
    }).catch(function(err){
      src.postMessage({type:"1dt-screenshot",error:err.message||"Capture failed"},"*");
    });
  }
})();
</script>`;
                        // Insert patch script at end of <head> (before </head>)
                        if (html.includes('</head>')) {
                            html = html.replace('</head>', patchScript + '</head>');
                        }
                        else if (html.includes('</HEAD>')) {
                            html = html.replace('</HEAD>', patchScript + '</HEAD>');
                        }
                        else {
                            html = patchScript + html;
                        }
                        delete proxyRes.headers['content-length'];
                        delete proxyRes.headers['content-encoding'];
                        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                        res.end(html);
                    });
                }
                else {
                    // Non-HTML: stream directly
                    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
                    proxyRes.pipe(res);
                }
            });
            proxyReq.on('error', (err) => {
                if (fallback && !res.headersSent) {
                    doProxy(fallback); // try the other address family
                }
                else if (!res.headersSent) {
                    res.status(502).json({ error: `Cannot reach localhost:${port}`, detail: err.message });
                }
            });
            proxyReq.on('timeout', () => {
                proxyReq.destroy();
                if (!res.headersSent) {
                    res.status(504).json({ error: `Timeout connecting to localhost:${port}` });
                }
            });
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                req.pipe(proxyReq);
            }
            else {
                proxyReq.end();
            }
        }
        doProxy('::1', '127.0.0.1');
    });
    // --- POST /api/pair placeholder ---
    // The actual logic is wired up in RemoteServer.handlePair() via
    // expressApp.post('/api/pair', ...) after creation
    // This route is defined here as documentation; RemoteServer replaces it
    // --- Static file serving for remote UI + SPA fallback ---
    const staticDir = getStaticDir();
    const staticMiddleware = express_1.default.static(staticDir, {
        maxAge: 0, // No cache during development — assets have content hashes anyway
        etag: true,
        index: 'index.html',
    });
    // Serve static assets under /ui, with SPA fallback to index.html
    // for any /ui path that doesn't match a static file.
    // Uses middleware instead of wildcard routes (Express v5 path-to-regexp v8
    // does not support *, +, or ? modifiers in route patterns).
    expressApp.use('/ui', (req, res, next) => {
        staticMiddleware(req, res, () => {
            // Static file not found — serve index.html for SPA client-side routing
            const indexPath = path_1.default.join(staticDir, 'index.html');
            res.sendFile(indexPath, (err) => {
                if (err)
                    next(err);
            });
        });
    });
    // --- Health check endpoint ---
    expressApp.get('/api/health', (_req, res) => {
        res.json({ ok: true, version: getAppVersion() });
    });
    // --- Create HTTP server ---
    const server = http_1.default.createServer(expressApp);
    // --- Create socket.io server ---
    const io = new socket_io_1.Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
        // MUST exceed the largest upload the terminal handlers accept
        // (REMOTE_UPLOAD_MAX_BYTES in handlers/terminal.ts) AFTER base64 inflation
        // (~4/3×) plus the JSON envelope. engine.io passes this to ws as
        // `maxPayload`: a single packet larger than this makes ws close the WHOLE
        // connection (code 1009, "message too big"). When that happens mid-upload
        // the ack never fires (the attachment chip spins forever) AND the dropped,
        // reconnecting socket makes the next terminal:submit see authenticated=false
        // ("nothing sent to terminal"). 48MB comfortably covers the 25MB file cap
        // (~33MB on the wire). See docs/common-errors/remote/upload-oversized-disconnects-socket.md
        maxHttpBufferSize: 48 * 1024 * 1024, // 48MB — keep > upload cap × 4/3
        pingTimeout: 30_000,
        pingInterval: 10_000,
        transports: ['websocket', 'polling'],
    });
    // --- WebSocket proxy for HMR (Vite, webpack-dev-server) ---
    // Must be after server creation. Socket.io also uses 'upgrade' but only
    // handles paths starting with /socket.io/. Our handler only handles /proxy/.
    server.on('upgrade', (req, socket, head) => {
        const match = req.url?.match(/^\/proxy\/(\d+)(\/.*)?$/);
        if (!match)
            return; // not a proxy request — let socket.io handle it
        const targetPort = parseInt(match[1], 10);
        if (targetPort < 1024 || targetPort > 65535) {
            socket.destroy();
            return;
        }
        const targetPath = (match[2] || '/');
        const qs = req.url?.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
        const net = require('net');
        const proxySocket = net.createConnection({ host: '127.0.0.1', port: targetPort }, () => {
            const headerLines = Object.entries(req.headers)
                .filter(([k]) => k.toLowerCase() !== 'host')
                .map(([k, v]) => `${k}: ${v}`);
            headerLines.unshift(`Host: localhost:${targetPort}`);
            proxySocket.write(`${req.method} ${targetPath}${qs} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
            if (head.length > 0)
                proxySocket.write(head);
            socket.pipe(proxySocket);
            proxySocket.pipe(socket);
        });
        proxySocket.on('error', () => socket.destroy());
        socket.on('error', () => proxySocket.destroy());
    });
    return { app: expressApp, server, io };
}
/**
 * Resolve the directory for remote UI static files.
 * In production, the UI is bundled at dist/remote-ui/.
 * In development, falls back to a placeholder path.
 */
function getStaticDir() {
    const candidates = [];
    try {
        const appPath = electron_1.app.getAppPath();
        candidates.push(path_1.default.join(appPath, 'dist', 'remote-ui'), path_1.default.resolve(appPath, '..', '..', 'remote-ui'), path_1.default.resolve(appPath, '..', '..', '..', 'dist', 'remote-ui'));
    }
    catch {
        // App may not be ready in some test paths; fall through to __dirname candidates.
    }
    candidates.push(path_1.default.resolve(__dirname, '..', '..', '..', '..', 'dist', 'remote-ui'), path_1.default.resolve(__dirname, '..', '..', '..', 'remote-ui'));
    const match = candidates.find((candidate) => fs_1.default.existsSync(path_1.default.join(candidate, 'index.html')));
    if (match) {
        return match;
    }
    return candidates[0];
}
/**
 * Get the application version string.
 */
function getAppVersion() {
    try {
        return electron_1.app.getVersion();
    }
    catch {
        return '0.0.0';
    }
}
