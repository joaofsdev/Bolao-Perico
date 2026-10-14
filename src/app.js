'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const {
  TIMEZONE,
  BET_CLOSE_MINUTES,
  SETTLE_MINUTES,
  POINTS_EXACT,
  nowInSaoPaulo,
  saoPauloEpochMs,
  isValidDate,
  isValidTime,
  timeToMinutes,
  minutesToTime,
  checkBetWindow,
  betsAreVisible,
  isDaySettled,
  checkResultWindow,
  scoreDay,
  dayStatus,
  computeRanking,
} = require('./rules.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
/**
 * Quem está pedindo: o nome, passado por encodeURIComponent. Header HTTP só
 * carrega Latin-1, e nome pode ter qualquer letra.
 */
const USER_HEADER = 'x-bolao-usuario';

/** 2 a 20 caracteres, começando por letra ou número. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,19}$/u;

/**
 * Forma canônica de um nome digitado, ou null se não servir. NFC faz "Fábio"
 * digitado em teclados diferentes virar a mesma sequência de bytes.
 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

function nameFromHeader(req) {
  const raw = req.get(USER_HEADER);
  if (!raw) return null;
  try {
    return normalizeName(decodeURIComponent(raw));
  } catch {
    return null; // Sequência % malformada.
  }
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

/** Comparação de senha em tempo constante, sem vazar o tamanho. */
function passwordMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Monta o app Express.
 *
 * @param {object} options
 * @param {object} options.store repositório criado por createStore()
 * @param {string} options.adminPassword senha da área de admin (ADMIN_PASSWORD)
 * @param {() => Date} [options.clock] relógio injetável — os testes usam um fixo
 */
function createApp({ store, adminPassword, clock = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  /** O "agora" oficial: sempre o relógio do servidor, em America/Sao_Paulo. */
  const serverNow = () => nowInSaoPaulo(clock());

  /** Usuário identificado pelo nome no header — sem caixa, sem espaço nas pontas. */
  async function currentUser(req) {
    const name = nameFromHeader(req);
    return name ? store.findUserByName(name) : null;
  }

  async function requireUser(req, res) {
    const user = await currentUser(req);
    if (!user) {
      fail(res, 401, 'SEM_USUARIO', 'Não encontramos seu usuário. Escolha um nome para entrar.');
      return null;
    }
    return user;
  }

  /** Monta o retrato de um dia para quem está olhando (ou para ninguém). */
  async function describeDay(date, user, now) {
    const visible = betsAreVisible(date, now);

    // Agora cada consulta é um round trip até o Turso: dispara junto o que
    // não depende do resultado das outras.
    const [arrivalMinutes, dayBets, myBet, totalBets] = await Promise.all([
      store.getArrivalMinutes(date),
      visible ? store.getBetsOnDate(date) : [],
      user ? store.getBet(user.id, date) : null,
      store.countBetsOnDate(date),
    ]);

    // Antes das 10:00 nada do dia é revelado — nem a chegada, nem o vencedor.
    const revealedArrival = visible ? arrivalMinutes : null;
    const { winners, points } = scoreDay(dayBets, revealedArrival);
    const winnerIds = new Set(winners.map((bet) => bet.userId));

    return {
      date,
      today: now.date,
      timezone: TIMEZONE,
      serverNow: { date: now.date, minutes: now.minutes, seconds: now.seconds, epochMs: now.epochMs },
      betCloseEpochMs: saoPauloEpochMs(date, BET_CLOSE_MINUTES),
      settleEpochMs: saoPauloEpochMs(date, SETTLE_MINUTES),
      betCloseTime: minutesToTime(BET_CLOSE_MINUTES),
      settleTime: minutesToTime(SETTLE_MINUTES),
      betWindow: checkBetWindow(date, now),
      betsVisible: visible,
      settled: isDaySettled(date, now),
      status: dayStatus(date, now, revealedArrival),
      myBet,
      totalBets,
      bets: dayBets.map((bet) => ({
        name: bet.name,
        time: bet.time,
        isMine: Boolean(user) && bet.userId === user.id,
        isWinner: winnerIds.has(bet.userId),
        points: winnerIds.has(bet.userId) ? points : 0,
        // O tempo não volta para trás: quem apostou antes da chegada saiu.
        isEliminated: revealedArrival !== null && bet.minutes < revealedArrival,
      })),
      arrivalTime: revealedArrival === null ? null : minutesToTime(revealedArrival),
      winners: winners.map((bet) => bet.name),
      // Quanto cada vencedor leva: 2 no acerto exato, 1 por proximidade, 0 sem vencedor.
      winnerPoints: points,
      exactHit: points === POINTS_EXACT,
    };
  }

  // --- Sessão -------------------------------------------------------------

  app.get('/api/session', async (req, res) => {
    const now = serverNow();
    const user = await currentUser(req);
    res.json({
      user: user ? { name: user.name } : null,
      today: now.date,
      timezone: TIMEZONE,
      serverNow: { date: now.date, minutes: now.minutes, seconds: now.seconds, epochMs: now.epochMs },
      betCloseTime: minutesToTime(BET_CLOSE_MINUTES),
      settleTime: minutesToTime(SETTLE_MINUTES),
    });
  });

  /**
   * Entra no bolão pelo nome: se já existe, entra como esse usuário; se não,
   * cria. Devolve o nome como está gravado — quem digitar "ana" entra como
   * "Ana" —, e é ele que o navegador passa a mandar.
   */
  app.post('/api/users', async (req, res) => {
    const name = normalizeName(req.body?.name);
    if (!name) {
      return fail(
        res,
        400,
        'NOME_INVALIDO',
        'Use de 2 a 20 caracteres, começando por letra ou número. Valem letras, números, espaço, ponto, hífen e sublinhado.',
      );
    }

    const existing = await store.findUserByName(name);
    if (existing) {
      return res.json({ created: false, user: { name: existing.name } });
    }

    const created = await store.createUser(name);
    if (created) {
      return res.status(201).json({ created: true, user: { name: created.name } });
    }

    // Outra requisição criou o mesmo nome entre a busca e o INSERT: o schema
    // barrou a duplicata, e quem chegou depois entra no usuário que ficou.
    const winner = await store.findUserByName(name);
    res.json({ created: false, user: { name: winner.name } });
  });

  // --- Apostas ------------------------------------------------------------

  app.get('/api/day', async (req, res) => {
    const now = serverNow();
    const date = req.query.date ?? now.date;
    if (!isValidDate(date)) {
      return fail(res, 400, 'DATA_INVALIDA', 'Data inválida. Use o formato AAAA-MM-DD.');
    }
    const user = await currentUser(req);
    res.json(await describeDay(date, user, now));
  });

  app.post('/api/bets', async (req, res) => {
    const user = await requireUser(req, res);
    if (!user) return undefined;

    const now = serverNow();
    const { date, time } = req.body ?? {};

    if (!isValidDate(date)) {
      return fail(res, 400, 'DATA_INVALIDA', 'Data inválida. Use o formato AAAA-MM-DD.');
    }
    if (!isValidTime(time)) {
      return fail(res, 400, 'HORARIO_INVALIDO', 'Horário inválido. Use o formato HH:MM, de 00:00 a 23:59.');
    }

    // O prazo é decidido aqui, com o relógio do servidor. O que o navegador
    // acha da hora não entra na conta.
    const window = checkBetWindow(date, now);
    if (!window.ok) {
      return fail(res, 403, window.code, window.message);
    }

    if ((await store.getBet(user.id, date)) !== null) {
      return fail(
        res,
        409,
        'JA_APOSTOU',
        'Você já apostou nesse dia. A aposta é única e não pode ser trocada.',
      );
    }

    if (!(await store.placeBet(user.id, date, time))) {
      // Perdeu a corrida com outra requisição sua — o schema barrou a segunda.
      return fail(
        res,
        409,
        'JA_APOSTOU',
        'Você já apostou nesse dia. A aposta é única e não pode ser trocada.',
      );
    }

    res.status(201).json(await describeDay(date, user, serverNow()));
  });

  // --- Ranking ------------------------------------------------------------

  app.get('/api/ranking', async (_req, res) => {
    const now = serverNow();
    const [users, bets, results] = await Promise.all([
      store.getAllUsers(),
      store.getAllBets(),
      store.getAllResults(),
    ]);
    const ranking = computeRanking(users, bets, results, now);
    res.json({ ranking });
  });

  // --- Admin --------------------------------------------------------------

  // Freio simples contra tentativa de senha em força bruta, por IP.
  const attempts = new Map();
  const MAX_ATTEMPTS = 8;
  const LOCKOUT_MS = 5 * 60 * 1000;

  function throttle(ip, nowMs) {
    const entry = attempts.get(ip);
    if (!entry) return { blocked: false };
    if (nowMs - entry.last > LOCKOUT_MS) {
      attempts.delete(ip);
      return { blocked: false };
    }
    return { blocked: entry.count >= MAX_ATTEMPTS };
  }

  function registerFailure(ip, nowMs) {
    const entry = attempts.get(ip) ?? { count: 0, last: nowMs };
    entry.count += 1;
    entry.last = nowMs;
    attempts.set(ip, entry);
  }

  app.post('/api/admin/result', async (req, res) => {
    const nowMs = Date.now();
    const ip = req.ip ?? 'desconhecido';

    if (!adminPassword) {
      return fail(
        res,
        503,
        'ADMIN_SEM_SENHA',
        'A área de admin está desativada: defina ADMIN_PASSWORD no servidor.',
      );
    }
    if (throttle(ip, nowMs).blocked) {
      return fail(res, 429, 'MUITAS_TENTATIVAS', 'Muitas tentativas de senha. Espere alguns minutos.');
    }
    if (!passwordMatches(req.body?.password, adminPassword)) {
      registerFailure(ip, nowMs);
      return fail(res, 401, 'SENHA_INCORRETA', 'Senha de admin incorreta.');
    }
    attempts.delete(ip);

    const now = serverNow();
    const { date, time } = req.body ?? {};
    if (!isValidDate(date)) {
      return fail(res, 400, 'DATA_INVALIDA', 'Data inválida. Use o formato AAAA-MM-DD.');
    }
    if (!isValidTime(time)) {
      return fail(res, 400, 'HORARIO_INVALIDO', 'Horário inválido. Use o formato HH:MM, de 00:00 a 23:59.');
    }
    const window = checkResultWindow(date, now);
    if (!window.ok) {
      return fail(res, 403, window.code, window.message);
    }

    await store.setArrival(date, time);

    const dayBets = await store.getBetsOnDate(date);
    const { winners, points } = scoreDay(dayBets, timeToMinutes(time));
    res.json({
      date,
      arrivalTime: time,
      totalBets: dayBets.length,
      winners: winners.map((bet) => bet.name),
      winnerPoints: points,
      exactHit: points === POINTS_EXACT,
    });
  });

  app.use('/api', (_req, res) => fail(res, 404, 'NAO_ENCONTRADO', 'Endpoint inexistente.'));

  // --- Estáticos ----------------------------------------------------------

  // Só public/ é servida, então package.json, src/ e node_modules/ seguem
  // fora de alcance. Na Vercel esses arquivos nem chegam aqui: a CDN os
  // entrega antes de a função ser invocada.
  app.use(express.static(PUBLIC_DIR));

  // Última linha de defesa. O Express 5 encaminha para cá a promise
  // rejeitada de qualquer handler async — sem isso, uma queda do Turso
  // viraria página de erro em HTML no meio de uma chamada de API.
  app.use((err, req, res, _next) => {
    console.error('Erro não tratado:', err);
    if (res.headersSent) return;
    if (req.path.startsWith('/api')) {
      return fail(
        res,
        500,
        'ERRO_INTERNO',
        'Algo quebrou do nosso lado. Tente de novo em instantes.',
      );
    }
    res.status(500).send('Erro interno.');
  });

  return app;
}

module.exports = { createApp, normalizeName };
