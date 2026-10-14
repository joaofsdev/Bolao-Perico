'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');

const { createStore } = require('../src/db.js');
const { createApp } = require('../src/app.js');
const { saoPauloEpochMs, timeToMinutes } = require('../src/rules.js');

const ADMIN_PASSWORD = 'senha-de-teste';
const HOJE = '2026-10-07';
const AMANHA = '2026-10-08';
const ONTEM = '2026-10-06';

/**
 * Sobe uma instância do app com banco em memória e relógio controlado.
 * O relógio é o do "servidor" — é ele que decide todos os prazos.
 */
async function startApp({ password = ADMIN_PASSWORD, url = ':memory:' } = {}) {
  const store = createStore({ url });
  const clock = { current: new Date(saoPauloEpochMs(HOJE, timeToMinutes('07:00'))) };
  const app = createApp({ store, adminPassword: password, clock: () => clock.current });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** `user` é o nome, mandado do jeito que o navegador manda. */
  const call = async (method, pathname, { body, user, headers: extra } = {}) => {
    const headers = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (user) headers['x-bolao-usuario'] = encodeURIComponent(user);
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    call,
    /** Move o relógio do servidor para "HH:MM" de uma data (fuso de São Paulo). */
    setNow(date, time) {
      clock.current = new Date(saoPauloEpochMs(date, timeToMinutes(time)));
    },
    /** Cria o usuário e devolve o nome com que ele passa a ser identificado. */
    async join(name) {
      const res = await call('POST', '/api/users', { body: { name } });
      assert.equal(res.status, 201, `falhou ao criar ${name}: ${JSON.stringify(res.body)}`);
      return res.body.user.name;
    },
    /** Todos os usuários do banco — o ranking só mostra quem apostou. */
    async userNames() {
      return (await store.getAllUsers()).map((u) => u.name);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

/** Roda o corpo com um app novo e sempre fecha o servidor no fim. */
function withApp(name, fn, options) {
  test(name, async () => {
    const app = await startApp(options);
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Usuário
// ---------------------------------------------------------------------------

withApp('nome novo cria o usuário', async (app) => {
  const res = await app.call('POST', '/api/users', { body: { name: 'Ana' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.created, true);
  assert.deepEqual(res.body.user, { name: 'Ana' });
  assert.equal(res.body.token, undefined, 'não existe mais token');

  const session = await app.call('GET', '/api/session', { user: 'Ana' });
  assert.equal(session.body.user.name, 'Ana');
  assert.equal(session.body.today, HOJE, 'o servidor informa o dia dele, não o do navegador');
});

withApp('nome existente entra como o mesmo usuário, sem caixa e sem espaço nas pontas', async (app) => {
  await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: 'Ana' });

  for (const tentativa of ['Ana', 'ana', 'ANA', '  AnA  ']) {
    const entrada = await app.call('POST', '/api/users', { body: { name: tentativa } });
    assert.equal(entrada.status, 200, `"${tentativa}" deveria entrar, não criar`);
    assert.equal(entrada.body.created, false);
    assert.equal(entrada.body.user.name, 'Ana', 'devolve o nome como foi gravado');

    // O header também é comparado sem caixa e sem espaço nas pontas.
    const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: tentativa });
    assert.equal(dia.body.myBet, '08:45', `"${tentativa}" deveria ver a aposta da Ana`);
  }

  assert.deepEqual(await app.userNames(), ['Ana'], 'continua existindo uma Ana só');
});

withApp('o mesmo nome em outro computador continua com uma aposta por dia', async (app) => {
  // Computador do trabalho.
  await app.call('POST', '/api/users', { body: { name: 'Ana' } });
  const primeira = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: 'Ana' });
  assert.equal(primeira.status, 201);

  // Celular: não tem nada guardado, só digita o nome.
  const entrada = await app.call('POST', '/api/users', { body: { name: 'ana' } });
  assert.equal(entrada.status, 200);
  const nome = entrada.body.user.name;

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: nome });
  assert.equal(dia.body.myBet, '08:45');

  const segunda = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:30' }, user: nome });
  assert.equal(segunda.status, 409);
  assert.equal(segunda.body.error.code, 'JA_APOSTOU');
});

withApp('duas entradas simultâneas com o mesmo nome novo criam um usuário só', async (app) => {
  const respostas = await Promise.all([
    app.call('POST', '/api/users', { body: { name: 'Ana' } }),
    app.call('POST', '/api/users', { body: { name: 'ana' } }),
  ]);
  assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 201]);
  assert.equal(
    respostas[0].body.user.name,
    respostas[1].body.user.name,
    'os dois entram no mesmo usuário',
  );

  assert.equal((await app.userNames()).length, 1);
});

withApp('nomes com acento identificam o usuário', async (app) => {
  await app.join('Fábio');

  const aposta = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: 'fábio' });
  assert.equal(aposta.status, 201);

  // "á" como "a" + acento combinante, do jeito que alguns teclados mandam.
  const decomposto = 'Fábio';
  const entrada = await app.call('POST', '/api/users', { body: { name: decomposto } });
  assert.equal(entrada.status, 200);
  assert.equal(entrada.body.user.name, 'Fábio');

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: decomposto });
  assert.equal(dia.body.myBet, '08:45');
});

withApp('nomes malformados são recusados', async (app) => {
  for (const nome of ['', 'A', ' ', '!!!', 'nome com (parênteses)', 'x'.repeat(21), 42, null]) {
    const res = await app.call('POST', '/api/users', { body: { name: nome } });
    assert.equal(res.status, 400, `deveria recusar ${JSON.stringify(nome)}`);
    assert.equal(res.body.error.code, 'NOME_INVALIDO');
  }
});

withApp('não existe endpoint para trocar o nome', async (app) => {
  const user = await app.join('Ana');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await app.call(method, '/api/users', { body: { name: 'Ana Maria' }, user });
    assert.equal(res.status, 404, `${method} /api/users não deveria existir`);
  }
  const res = await app.call('PATCH', '/api/session', { body: { name: 'Ana Maria' }, user });
  assert.equal(res.status, 404);

  // Entrar com outro nome cria outro usuário; a Ana continua Ana.
  await app.call('POST', '/api/users', { body: { name: 'Ana Maria' } });
  assert.deepEqual(await app.userNames(), ['Ana', 'Ana Maria']);
});

withApp('sem nome não dá para apostar', async (app) => {
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'SEM_USUARIO');
});

withApp('nome que ninguém criou não aposta nem é criado pelo caminho', async (app) => {
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: 'Zé' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'SEM_USUARIO');

  const session = await app.call('GET', '/api/session', { user: 'Zé' });
  assert.equal(session.body.user, null);

  assert.deepEqual(await app.userNames(), [], 'só a tela de nome cria usuário');
});

withApp('token e header malformado não identificam ninguém', async (app) => {
  await app.join('Ana');
  for (const headers of [
    { 'x-bolao-token': 'qualquer-coisa' },
    { 'x-bolao-usuario': '%E0%A4%A' }, // escape % quebrado
  ]) {
    const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, headers });
    assert.equal(res.status, 401, `deveria recusar ${JSON.stringify(headers)}`);
    assert.equal(res.body.error.code, 'SEM_USUARIO');
  }
});

test('usuários e apostas de um banco da versão com token continuam valendo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolao-'));
  const url = pathToFileURL(path.join(dir, 'antigo.db')).href;

  // Banco como a versão anterior deixava: cada usuário com seu token.
  const antigo = createClient({ url });
  await antigo.executeMultiple(`
    CREATE TABLE users (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      name_lower  TEXT    NOT NULL UNIQUE,
      token       TEXT    NOT NULL UNIQUE,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE bets (
      id          INTEGER PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      bet_date    TEXT    NOT NULL,
      bet_minutes INTEGER NOT NULL CHECK (bet_minutes BETWEEN 0 AND 1439),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, bet_date)
    );
    CREATE TABLE results (
      bet_date        TEXT    PRIMARY KEY,
      arrival_minutes INTEGER NOT NULL CHECK (arrival_minutes BETWEEN 0 AND 1439),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, name, name_lower, token) VALUES (1, 'Ana', 'ana', 'tokenAntigoDaAna');
    INSERT INTO bets (user_id, bet_date, bet_minutes) VALUES (1, '${HOJE}', 525);
  `);
  antigo.close();

  const app = await startApp({ url });
  try {
    const entrada = await app.call('POST', '/api/users', { body: { name: 'ana' } });
    assert.equal(entrada.status, 200, 'a Ana já existia');
    assert.equal(entrada.body.user.name, 'Ana');

    const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: 'Ana' });
    assert.equal(dia.body.myBet, '08:45', 'a aposta antiga continua lá');

    const repetida = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:00' }, user: 'Ana' });
    assert.equal(repetida.status, 409);

    // Gente nova entra no banco antigo sem tropeçar na coluna token.
    assert.equal(await app.join('Bruno'), 'Bruno');
    assert.equal(await app.join('Carla'), 'Carla');
    assert.deepEqual(await app.userNames(), ['Ana', 'Bruno', 'Carla']);
  } finally {
    await app.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // No Windows o libSQL só solta o arquivo quando o processo termina;
      // fica para a limpeza do diretório temporário do sistema.
    }
  }
});

// ---------------------------------------------------------------------------
// Prazo da aposta, validado no servidor
// ---------------------------------------------------------------------------

withApp('aposta no dia atual é aceita antes das 10:00', async (app) => {
  const user = await app.join('Ana');
  app.setNow(HOJE, '09:59');
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user });
  assert.equal(res.status, 201);
  assert.equal(res.body.myBet, '08:45');
});

withApp('aposta no dia atual é bloqueada a partir das 10:00', async (app) => {
  const user = await app.join('Ana');
  app.setNow(HOJE, '10:00');
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PRAZO_ENCERRADO');
  assert.match(res.body.error.message, /10:00/);
});

withApp('aposta em data passada é bloqueada', async (app) => {
  const user = await app.join('Ana');
  const res = await app.call('POST', '/api/bets', { body: { date: ONTEM, time: '08:45' }, user });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'DATA_PASSADA');
});

withApp('aposta em data futura é aceita mesmo depois das 10:00', async (app) => {
  const user = await app.join('Ana');
  app.setNow(HOJE, '22:00');
  const res = await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:15' }, user });
  assert.equal(res.status, 201);
  assert.equal(res.body.myBet, '09:15');
});

withApp('aposta em sábado ou domingo é recusada', async (app) => {
  const user = await app.join('Ana');
  // HOJE é quarta: 10/10 é sábado e 11/10, domingo.
  for (const date of ['2026-10-10', '2026-10-11']) {
    const res = await app.call('POST', '/api/bets', { body: { date, time: '09:00' }, user });
    assert.equal(res.status, 403, date);
    assert.equal(res.body.error.code, 'FIM_DE_SEMANA');
  }
});

withApp('a aposta é única por data e não pode ser trocada nem apagada', async (app) => {
  const user = await app.join('Ana');
  assert.equal((await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user })).status, 201);

  const repetida = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:00' }, user });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.body.error.code, 'JA_APOSTOU');

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await app.call(method, '/api/bets', { body: { date: HOJE, time: '09:00' }, user });
    assert.equal(res.status, 404, `${method} /api/bets não deveria existir`);
  }

  // Depois de tudo, a aposta original continua de pé.
  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user });
  assert.equal(dia.body.myBet, '08:45');
});

withApp('duas apostas simultâneas do mesmo usuário: só uma entra', async (app) => {
  const user = await app.join('Ana');
  const respostas = await Promise.all([
    app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:40' }, user }),
    app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:40' }, user }),
  ]);
  const criadas = respostas.filter((r) => r.status === 201);
  const recusadas = respostas.filter((r) => r.status === 409);
  assert.equal(criadas.length, 1, 'exatamente uma aposta deveria entrar');
  assert.equal(recusadas.length, 1);
});

withApp('horário e data malformados são recusados', async (app) => {
  const user = await app.join('Ana');
  const horarioRuim = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '25:00' }, user });
  assert.equal(horarioRuim.status, 400);
  assert.equal(horarioRuim.body.error.code, 'HORARIO_INVALIDO');

  const dataRuim = await app.call('POST', '/api/bets', { body: { date: '07/10/2026', time: '08:45' }, user });
  assert.equal(dataRuim.status, 400);
  assert.equal(dataRuim.body.error.code, 'DATA_INVALIDA');
});

// ---------------------------------------------------------------------------
// Visibilidade: ninguém copia a aposta do outro
// ---------------------------------------------------------------------------

withApp('apostas dos outros só aparecem depois das 10:00', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, user: bruno });

  app.setNow(HOJE, '09:59');
  const antes = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(antes.body.betsVisible, false);
  assert.deepEqual(antes.body.bets, [], 'nenhuma aposta alheia antes das 10:00');
  assert.equal(antes.body.totalBets, 2, 'a contagem aparece, os horários não');
  assert.equal(antes.body.myBet, '08:45', 'a própria aposta sempre aparece');

  app.setNow(HOJE, '10:00');
  const depois = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(depois.body.betsVisible, true);
  assert.deepEqual(
    depois.body.bets.map((b) => [b.name, b.time]),
    [['Ana', '08:45'], ['Bruno', '09:10']],
  );
});

withApp('apostas de um dia futuro ficam escondidas', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '08:45' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:10' }, user: bruno });

  const dia = await app.call('GET', `/api/day?date=${AMANHA}`, { user: ana });
  assert.equal(dia.body.betsVisible, false);
  assert.deepEqual(dia.body.bets, []);
  assert.equal(dia.body.totalBets, 2);
});

// ---------------------------------------------------------------------------
// Resultado e vencedor
// ---------------------------------------------------------------------------

withApp('o exemplo do enunciado roda ponta a ponta', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  const carla = await app.join('Carla');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:55' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, user: bruno });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, user: carla });

  app.setNow(HOJE, '10:30');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.winners, ['Bruno']);
  assert.equal(admin.body.winnerPoints, 1, 'ganhou por proximidade');
  assert.equal(admin.body.exactHit, false);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(dia.body.arrivalTime, '08:56');
  assert.equal(dia.body.status, 'com_resultado');
  assert.deepEqual(dia.body.winners, ['Bruno']);
  assert.equal(dia.body.winnerPoints, 1);
  assert.equal(dia.body.exactHit, false);
  assert.deepEqual(
    dia.body.bets.map((b) => [b.name, b.points]),
    [['Ana', 0], ['Bruno', 1], ['Carla', 0]],
  );

  const porNome = Object.fromEntries(dia.body.bets.map((b) => [b.name, b]));
  assert.equal(porNome.Ana.isEliminated, true, 'Ana apostou antes da chegada');
  assert.equal(porNome.Ana.isWinner, false);
  assert.equal(porNome.Bruno.isWinner, true);
  assert.equal(porNome.Carla.isEliminated, false);
  assert.equal(porNome.Carla.isWinner, false);
});

withApp('empate no horário vencedor premia os dois', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, user: bruno });

  app.setNow(HOJE, '10:30');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });
  assert.deepEqual(admin.body.winners.sort(), ['Ana', 'Bruno']);
  assert.equal(admin.body.winnerPoints, 1, 'cada empatado leva o ponto cheio');
});

withApp('acerto exato vale 2 pontos, e empatados na mosca levam os 2', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  const carla = await app.join('Carla');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:56' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:56' }, user: bruno });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, user: carla });

  app.setNow(HOJE, '10:30');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });
  assert.deepEqual(admin.body.winners.sort(), ['Ana', 'Bruno']);
  assert.equal(admin.body.winnerPoints, 2);
  assert.equal(admin.body.exactHit, true);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: carla });
  assert.equal(dia.body.exactHit, true);
  assert.deepEqual(
    dia.body.bets.map((b) => [b.name, b.isWinner, b.points]),
    [['Ana', true, 2], ['Bruno', true, 2], ['Carla', false, 0]],
  );

  const { body } = await app.call('GET', '/api/ranking');
  assert.deepEqual(body.ranking, [
    { name: 'Ana', points: 2, wins: 1, totalBets: 1 },
    { name: 'Bruno', points: 2, wins: 1, totalBets: 1 },
    { name: 'Carla', points: 0, wins: 0, totalBets: 1 },
  ]);
});

withApp('todas as apostas antes da chegada: dia sem vencedor', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:40' }, user: ana });

  app.setNow(HOJE, '10:45');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '09:00' },
  });
  assert.deepEqual(admin.body.winners, []);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(dia.body.status, 'com_resultado');
  assert.deepEqual(dia.body.winners, []);
  assert.equal(dia.body.bets[0].isEliminated, true);
});

withApp('meio-dia sem chegada registrada: dia sem vencedor', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: ana });

  app.setNow(HOJE, '11:59');
  const antes = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(antes.body.status, 'aguardando_chegada');
  assert.equal(antes.body.settled, false);

  app.setNow(HOJE, '12:00');
  const depois = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(depois.body.status, 'sem_resultado');
  assert.equal(depois.body.settled, true);
  assert.deepEqual(depois.body.winners, []);
});

withApp('registrar a chegada antes das 10:00 fecha as apostas e revela o dia', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:10' }, user: ana });

  app.setNow(HOJE, '08:15');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:05' },
  });
  assert.equal(admin.status, 200);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: bruno });
  assert.equal(dia.body.arrivalTime, '08:05', 'a chegada aparece na hora, sem esperar as 10:00');
  assert.equal(dia.body.status, 'com_resultado');
  assert.equal(dia.body.betsVisible, true);
  assert.deepEqual(dia.body.winners, ['Ana']);
  assert.equal(dia.body.betWindow.ok, false);

  const tarde = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:05' }, user: bruno });
  assert.equal(tarde.status, 403);
  assert.equal(tarde.body.error.code, 'CHEGADA_REGISTRADA');

  // O dia seguinte segue aberto.
  const amanha = await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '08:30' }, user: bruno });
  assert.equal(amanha.status, 201);
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

withApp('admin exige a senha certa', async (app) => {
  const errada = await app.call('POST', '/api/admin/result', {
    body: { password: 'chute', date: HOJE, time: '08:56' },
  });
  assert.equal(errada.status, 401);
  assert.equal(errada.body.error.code, 'SENHA_INCORRETA');

  const vazia = await app.call('POST', '/api/admin/result', { body: { date: HOJE, time: '08:56' } });
  assert.equal(vazia.status, 401);
});

withApp('sem ADMIN_PASSWORD a área de admin fica desativada', async (app) => {
  const res = await app.call('POST', '/api/admin/result', {
    body: { password: '', date: HOJE, time: '08:56' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'ADMIN_SEM_SENHA');
}, { password: '' });

withApp('admin não registra chegada de dia futuro', async (app) => {
  const res = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: AMANHA, time: '08:56' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'DATA_FUTURA');
});

withApp('admin pode corrigir uma chegada já registrada', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:50' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, user: bruno });

  app.setNow(HOJE, '10:45');
  const primeiro = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '09:05' },
  });
  assert.deepEqual(primeiro.body.winners, ['Bruno']);

  const corrigido = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:45' },
  });
  assert.deepEqual(corrigido.body.winners, ['Ana']);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { user: ana });
  assert.equal(dia.body.arrivalTime, '08:45');
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

withApp('ranking ordena por pontos e mostra vitórias e apostas', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.join('Carla'); // entrou e nunca apostou

  // Dia 1: chegou 08:56 -> Bruno (08:57) ganha por proximidade, +1.
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:55' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, user: bruno });
  app.setNow(HOJE, '10:30');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });

  // Dia 2: chegou 09:00 -> Bruno (09:00) acerta na mosca, +2.
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:30' }, user: ana });
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:00' }, user: bruno });
  app.setNow(AMANHA, '10:35');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: AMANHA, time: '09:00' },
  });

  const { body } = await app.call('GET', '/api/ranking');
  // Carla entrou mas nunca apostou: não aparece no ranking.
  assert.deepEqual(body.ranking, [
    { name: 'Bruno', points: 3, wins: 2, totalBets: 2 },
    { name: 'Ana', points: 0, wins: 0, totalBets: 2 },
  ]);
  assert.deepEqual(await app.userNames(), ['Ana', 'Bruno', 'Carla'], 'mas continua cadastrada');
});

withApp('ranking conta a vitória assim que a chegada é registrada', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, user: ana });

  app.setNow(HOJE, '08:10');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:40' },
  });

  const revelado = await app.call('GET', '/api/ranking');
  assert.deepEqual(revelado.body.ranking, [{ name: 'Ana', points: 1, wins: 1, totalBets: 1 }]);
});
