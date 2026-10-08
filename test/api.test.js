'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
async function startApp({ password = ADMIN_PASSWORD } = {}) {
  const store = createStore({ url: ':memory:' });
  const clock = { current: new Date(saoPauloEpochMs(HOJE, timeToMinutes('07:00'))) };
  const app = createApp({ store, adminPassword: password, clock: () => clock.current });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, pathname, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers['x-bolao-token'] = token;
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
    async join(name) {
      const res = await call('POST', '/api/users', { body: { name } });
      assert.equal(res.status, 201, `falhou ao criar ${name}: ${JSON.stringify(res.body)}`);
      return res.body.token;
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

withApp('entrar com um nome devolve um token', async (app) => {
  const res = await app.call('POST', '/api/users', { body: { name: 'Ana' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.name, 'Ana');
  assert.ok(res.body.token.length > 20, 'token precisa ser longo');

  const session = await app.call('GET', '/api/session', { token: res.body.token });
  assert.equal(session.body.user.name, 'Ana');
  assert.equal(session.body.today, HOJE, 'o servidor informa o dia dele, não o do navegador');
});

withApp('nome é único ignorando maiúsculas e minúsculas', async (app) => {
  await app.join('Ana');
  for (const tentativa of ['Ana', 'ana', 'ANA', '  AnA  ']) {
    const res = await app.call('POST', '/api/users', { body: { name: tentativa } });
    assert.equal(res.status, 409, `deveria recusar "${tentativa}"`);
    assert.equal(res.body.error.code, 'NOME_EM_USO');
  }
});

withApp('nomes malformados são recusados', async (app) => {
  for (const nome of ['', 'A', ' ', '!!!', 'nome com (parênteses)', 'x'.repeat(21), 42, null]) {
    const res = await app.call('POST', '/api/users', { body: { name: nome } });
    assert.equal(res.status, 400, `deveria recusar ${JSON.stringify(nome)}`);
    assert.equal(res.body.error.code, 'NOME_INVALIDO');
  }
});

withApp('não existe endpoint para trocar o nome', async (app) => {
  const token = await app.join('Ana');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await app.call(method, '/api/users', { body: { name: 'Ana Maria' }, token });
    assert.equal(res.status, 404, `${method} /api/users não deveria existir`);
  }
  const res = await app.call('PATCH', '/api/session', { body: { name: 'Ana Maria' }, token });
  assert.equal(res.status, 404);
});

withApp('sem token não dá para apostar', async (app) => {
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'SEM_USUARIO');
});

// ---------------------------------------------------------------------------
// Prazo da aposta, validado no servidor
// ---------------------------------------------------------------------------

withApp('aposta no dia atual é aceita antes das 08:30', async (app) => {
  const token = await app.join('Ana');
  app.setNow(HOJE, '08:29');
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token });
  assert.equal(res.status, 201);
  assert.equal(res.body.myBet, '08:45');
});

withApp('aposta no dia atual é bloqueada a partir das 08:30', async (app) => {
  const token = await app.join('Ana');
  app.setNow(HOJE, '08:30');
  const res = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'PRAZO_ENCERRADO');
  assert.match(res.body.error.message, /08:30/);
});

withApp('aposta em data passada é bloqueada', async (app) => {
  const token = await app.join('Ana');
  const res = await app.call('POST', '/api/bets', { body: { date: ONTEM, time: '08:45' }, token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'DATA_PASSADA');
});

withApp('aposta em data futura é aceita mesmo depois das 08:30', async (app) => {
  const token = await app.join('Ana');
  app.setNow(HOJE, '22:00');
  const res = await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:15' }, token });
  assert.equal(res.status, 201);
  assert.equal(res.body.myBet, '09:15');
});

withApp('a aposta é única por data e não pode ser trocada nem apagada', async (app) => {
  const token = await app.join('Ana');
  assert.equal((await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token })).status, 201);

  const repetida = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:00' }, token });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.body.error.code, 'JA_APOSTOU');

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const res = await app.call(method, '/api/bets', { body: { date: HOJE, time: '09:00' }, token });
    assert.equal(res.status, 404, `${method} /api/bets não deveria existir`);
  }

  // Depois de tudo, a aposta original continua de pé.
  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { token });
  assert.equal(dia.body.myBet, '08:45');
});

withApp('duas apostas simultâneas do mesmo usuário: só uma entra', async (app) => {
  const token = await app.join('Ana');
  const respostas = await Promise.all([
    app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:40' }, token }),
    app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:40' }, token }),
  ]);
  const criadas = respostas.filter((r) => r.status === 201);
  const recusadas = respostas.filter((r) => r.status === 409);
  assert.equal(criadas.length, 1, 'exatamente uma aposta deveria entrar');
  assert.equal(recusadas.length, 1);
});

withApp('horário e data malformados são recusados', async (app) => {
  const token = await app.join('Ana');
  const horarioRuim = await app.call('POST', '/api/bets', { body: { date: HOJE, time: '25:00' }, token });
  assert.equal(horarioRuim.status, 400);
  assert.equal(horarioRuim.body.error.code, 'HORARIO_INVALIDO');

  const dataRuim = await app.call('POST', '/api/bets', { body: { date: '07/10/2026', time: '08:45' }, token });
  assert.equal(dataRuim.status, 400);
  assert.equal(dataRuim.body.error.code, 'DATA_INVALIDA');
});

// ---------------------------------------------------------------------------
// Visibilidade: ninguém copia a aposta do outro
// ---------------------------------------------------------------------------

withApp('apostas dos outros só aparecem depois das 08:30', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, token: bruno });

  app.setNow(HOJE, '08:29');
  const antes = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(antes.body.betsVisible, false);
  assert.deepEqual(antes.body.bets, [], 'nenhuma aposta alheia antes das 08:30');
  assert.equal(antes.body.totalBets, 2, 'a contagem aparece, os horários não');
  assert.equal(antes.body.myBet, '08:45', 'a própria aposta sempre aparece');

  app.setNow(HOJE, '08:30');
  const depois = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(depois.body.betsVisible, true);
  assert.deepEqual(
    depois.body.bets.map((b) => [b.name, b.time]),
    [['Ana', '08:45'], ['Bruno', '09:10']],
  );
});

withApp('apostas de um dia futuro ficam escondidas', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '08:45' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:10' }, token: bruno });

  const dia = await app.call('GET', `/api/day?date=${AMANHA}`, { token: ana });
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
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:55' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, token: bruno });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, token: carla });

  app.setNow(HOJE, '09:00');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.winners, ['Bruno']);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(dia.body.arrivalTime, '08:56');
  assert.equal(dia.body.status, 'com_resultado');
  assert.deepEqual(dia.body.winners, ['Bruno']);

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
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, token: bruno });

  app.setNow(HOJE, '09:00');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });
  assert.deepEqual(admin.body.winners.sort(), ['Ana', 'Bruno']);
});

withApp('todas as apostas antes da chegada: dia sem vencedor', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:40' }, token: ana });

  app.setNow(HOJE, '09:30');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '09:00' },
  });
  assert.deepEqual(admin.body.winners, []);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(dia.body.status, 'com_resultado');
  assert.deepEqual(dia.body.winners, []);
  assert.equal(dia.body.bets[0].isEliminated, true);
});

withApp('meio-dia sem chegada registrada: dia sem vencedor', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token: ana });

  app.setNow(HOJE, '11:59');
  const antes = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(antes.body.status, 'aguardando_chegada');
  assert.equal(antes.body.settled, false);

  app.setNow(HOJE, '12:00');
  const depois = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(depois.body.status, 'sem_resultado');
  assert.equal(depois.body.settled, true);
  assert.deepEqual(depois.body.winners, []);
});

withApp('chegada registrada antes das 08:30 não vaza o resultado', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:10' }, token: ana });

  app.setNow(HOJE, '08:15');
  const admin = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:05' },
  });
  assert.equal(admin.status, 200);

  // Bruno ainda pode apostar — e não pode descobrir que já deu 08:05.
  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { token: bruno });
  assert.equal(dia.body.arrivalTime, null, 'a chegada fica escondida até as 08:30');
  assert.deepEqual(dia.body.winners, []);
  assert.equal(dia.body.status, 'apostas_abertas');

  app.setNow(HOJE, '08:30');
  const revelado = await app.call('GET', `/api/day?date=${HOJE}`, { token: bruno });
  assert.equal(revelado.body.arrivalTime, '08:05');
  assert.deepEqual(revelado.body.winners, ['Ana']);
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
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:50' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '09:10' }, token: bruno });

  app.setNow(HOJE, '09:30');
  const primeiro = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '09:05' },
  });
  assert.deepEqual(primeiro.body.winners, ['Bruno']);

  const corrigido = await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:45' },
  });
  assert.deepEqual(corrigido.body.winners, ['Ana']);

  const dia = await app.call('GET', `/api/day?date=${HOJE}`, { token: ana });
  assert.equal(dia.body.arrivalTime, '08:45');
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

withApp('ranking ordena por vitórias e mostra o total de apostas', async (app) => {
  const ana = await app.join('Ana');
  const bruno = await app.join('Bruno');
  await app.join('Carla'); // entrou e nunca apostou

  // Dia 1: chegou 08:56 -> Bruno (08:57) ganha.
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:55' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:57' }, token: bruno });
  app.setNow(HOJE, '09:00');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:56' },
  });

  // Dia 2: chegou 09:00 -> Bruno (09:00) ganha de novo.
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:30' }, token: ana });
  await app.call('POST', '/api/bets', { body: { date: AMANHA, time: '09:00' }, token: bruno });
  app.setNow(AMANHA, '09:05');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: AMANHA, time: '09:00' },
  });

  const { body } = await app.call('GET', '/api/ranking');
  assert.deepEqual(body.ranking, [
    { name: 'Bruno', wins: 2, totalBets: 2 },
    { name: 'Ana', wins: 0, totalBets: 2 },
    { name: 'Carla', wins: 0, totalBets: 0 },
  ]);
});

withApp('ranking não conta vitória de dia ainda não revelado', async (app) => {
  const ana = await app.join('Ana');
  await app.call('POST', '/api/bets', { body: { date: HOJE, time: '08:45' }, token: ana });

  app.setNow(HOJE, '08:10');
  await app.call('POST', '/api/admin/result', {
    body: { password: ADMIN_PASSWORD, date: HOJE, time: '08:40' },
  });

  const escondido = await app.call('GET', '/api/ranking');
  assert.deepEqual(escondido.body.ranking, [{ name: 'Ana', wins: 0, totalBets: 1 }]);

  app.setNow(HOJE, '08:30');
  const revelado = await app.call('GET', '/api/ranking');
  assert.deepEqual(revelado.body.ranking, [{ name: 'Ana', wins: 1, totalBets: 1 }]);
});
