'use strict';

const path = require('node:path');

const { createStore, configFromEnv } = require('./db.js');
const { createApp } = require('./app.js');

/**
 * Montagem compartilhada pelos dois pontos de entrada: o servidor local
 * (src/server.js) e a função serverless da Vercel (api/index.js).
 */

/** Carrega o .env da raiz, se houver. Variáveis do ambiente vencem o arquivo. */
function loadDotEnv() {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {
    // Sem .env na raiz — é o caso normal em produção.
  }
}

/** Monta store e app a partir do ambiente. */
function buildApp() {
  loadDotEnv();
  const store = createStore(configFromEnv());
  const app = createApp({ store, adminPassword: process.env.ADMIN_PASSWORD });
  return { app, store };
}

module.exports = { buildApp, loadDotEnv };
