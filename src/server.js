'use strict';

const { buildApp } = require('./boot.js');

const { app, store } = buildApp();
const PORT = Number(process.env.PORT ?? 3000);

const server = app.listen(PORT, () => {
  console.log(`Bolão do Perico em http://localhost:${PORT}`);
  console.log(
    process.env.TURSO_DATABASE_URL
      ? 'Banco: Turso (TURSO_DATABASE_URL)'
      : `Banco: ${process.env.DB_FILE ?? './data/bolao.db'}`,
  );
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('Aviso: ADMIN_PASSWORD não definida — a área de admin fica desativada.');
  }
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
