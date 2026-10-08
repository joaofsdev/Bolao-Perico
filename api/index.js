'use strict';

/**
 * Ponto de entrada na Vercel: o mesmo app Express, exportado como função
 * serverless. O vercel.json manda todo /api/* para cá; os estáticos de
 * public/ são servidos pela CDN e nunca chegam a invocar esta função.
 */

const { buildApp } = require('../src/boot.js');

const { app } = buildApp();

module.exports = app;
