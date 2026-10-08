'use strict';

/**
 * Cria as tabelas no banco apontado pelo ambiente.
 *
 * O app também cria o schema sozinho no primeiro acesso, mas rodar isso uma
 * vez depois de criar o banco no Turso evita que o primeiro visitante pague
 * esse custo — e avisa na hora se a URL ou o token estiverem errados.
 */

const { createStore, configFromEnv } = require('../src/db.js');
const { loadDotEnv } = require('../src/boot.js');

loadDotEnv();

const store = createStore(configFromEnv());

store
  .migrate()
  .then(() => {
    console.log(
      process.env.TURSO_DATABASE_URL
        ? 'Schema criado no Turso.'
        : `Schema criado em ${process.env.DB_FILE ?? './data/bolao.db'}.`,
    );
    store.close();
  })
  .catch((err) => {
    console.error('Falhou ao criar o schema:', err.message);
    process.exit(1);
  });
