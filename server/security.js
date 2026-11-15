'use strict';
const crypto = require('node:crypto');

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

// Beskytter mod DNS rebinding: en fremmed side kan ikke få browseren til at tale med os under et andet værtsnavn.
function hostOk(req, port) {
  return allowedHosts(port).has(String(req.headers.host || '').toLowerCase());
}

// Beskytter mod at andre websites sender kommandoer til os via din browser (CSRF).
function originOk(req, port) {
  const origin = req.headers.origin;
  if (!origin) return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// Nøglen sendes i en header på hver forespørgsel – ikke i en cookie. Browsere sender cookies til ALLE porte på
// 127.0.0.1, så en anden lokal webside ville få nøglen med. En header sendes kun, når Control Towers egen side beder om det.
function bearer(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}

function authed(req, token) {
  return safeEqual(bearer(req), token);
}

// En WebSocket kan ikke sende headers fra browseren, så dér gives nøglen med som "underprotokol".
function wsAuthed(req, token) {
  const parts = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
  const item = parts.find((p) => p.startsWith('ct.'));
  return parts.includes('ct') && !!item && safeEqual(item.slice(3), token);
}

function securityHeaders(port) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      // xterm.js indsætter selv stilark, derfor er inline-styles tilladt – men aldrig inline-scripts.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

module.exports = { newToken, safeEqual, hostOk, originOk, bearer, authed, wsAuthed, securityHeaders };
