'use strict';

/**
 * Preenche o banco com um bolão de brincadeira, para olhar a tela sem
 * esperar três dias de atrasos do Perico.
 *
 *   npm run seed            # recusa se já existir gente no banco
 *   npm run seed -- --force # apaga tudo e recria
 *
 * Respeita o ambiente: sem TURSO_DATABASE_URL popula o arquivo local.
 */

const { createStore, configFromEnv } = require('../src/db.js');
const { loadDotEnv } = require('../src/boot.js');
const { nowInSaoPaulo, addDays } = require('../src/rules.js');

loadDotEnv();

const force = process.argv.includes('--force');
const store = createStore(configFromEnv());

async function main() {
  if ((await store.getAllUsers()).length > 0) {
    if (!force) {
      console.error('O banco já tem usuários. Use "npm run seed -- --force" para recriar.');
      process.exit(1);
    }
    await store.reset();
  }

  const hoje = nowInSaoPaulo().date;
  const ontem = addDays(hoje, -1);
  const anteontem = addDays(hoje, -2);
  const amanha = addDays(hoje, 1);

  const nomes = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio'];
  const ids = new Map();
  for (const nome of nomes) {
    const user = await store.createUser(nome);
    ids.set(nome, user.id);
  }

  const dias = [
    { date: anteontem, arrival: '09:03', bets: { Ana: '08:50', Bruno: '09:05', Carla: '09:05', Diego: '09:40' } },
    { date: ontem, arrival: '08:41', bets: { Ana: '08:45', Bruno: '08:35', Carla: '09:10', Elisa: '08:41' } },
    // Hoje já tem resultado: é o dia que mostra a fita inteira.
    { date: hoje, arrival: '08:56', bets: { Ana: '08:55', Bruno: '08:57', Carla: '09:10', Diego: '08:40', Elisa: '08:57' } },
    // Amanhã ainda está escondido: só a contagem aparece.
    { date: amanha, bets: { Ana: '08:48', Carla: '09:00' } },
  ];

  for (const dia of dias) {
    for (const [nome, horario] of Object.entries(dia.bets)) {
      await store.placeBet(ids.get(nome), dia.date, horario);
    }
    if (dia.arrival) await store.setArrival(dia.date, dia.arrival);
  }

  console.log(`${nomes.length} apostadores, dias: ${dias.map((d) => d.date).join(', ')}`);
  console.log('Fábio entrou e nunca apostou — serve para ver o fim do ranking.');
  store.close();
}

main().catch((err) => {
  console.error('Falhou ao popular:', err.message);
  process.exit(1);
});
