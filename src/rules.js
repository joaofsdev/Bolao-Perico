'use strict';

/**
 * Regras do Bolão do Perico.
 *
 * Tudo aqui é função pura: recebe data/hora já normalizadas e devolve decisão.
 * Nenhuma função deste arquivo lê o relógio por conta própria — quem chama
 * passa o "agora" do servidor (America/Sao_Paulo). Isso mantém as regras
 * testáveis e garante que o navegador nunca participe da validação.
 */

const TIMEZONE = 'America/Sao_Paulo';

/** Apostas do dia fecham às 08:30 em ponto. */
const BET_CLOSE_MINUTES = 8 * 60 + 30;
/** O bolão do dia encerra ao meio-dia. */
const SETTLE_MINUTES = 12 * 60;

/** Acertar o horário exato da chegada. */
const POINTS_EXACT = 2;
/** Ganhar pela aposta posterior mais próxima da chegada. */
const POINTS_CLOSEST = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const zonedParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partsOf(instant) {
  const out = {};
  for (const { type, value } of zonedParts.formatToParts(instant)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return out;
}

/** O instante `agora` visto de São Paulo: data ISO + minutos/segundos do dia. */
function nowInSaoPaulo(instant = new Date()) {
  const p = partsOf(instant);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    minutes: p.hour * 60 + p.minute,
    seconds: p.second,
    epochMs: instant.getTime(),
  };
}

/** Deslocamento do fuso (em minutos) no instante dado. Imune a horário de verão. */
function offsetMinutes(instant) {
  const p = partsOf(instant);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asIfUTC - Math.floor(instant.getTime() / 1000) * 1000) / 60000;
}

/** Converte "YYYY-MM-DD" + minutos do dia em São Paulo para epoch em ms. */
function saoPauloEpochMs(dateStr, minutesOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naiveUTC = Date.UTC(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  // Duas passadas: a primeira estima o deslocamento, a segunda o confirma no
  // instante real (importa se o fuso voltar a ter horário de verão).
  let epoch = naiveUTC - offsetMinutes(new Date(naiveUTC)) * 60000;
  epoch = naiveUTC - offsetMinutes(new Date(epoch)) * 60000;
  return epoch;
}

/** Valida "YYYY-MM-DD" exigindo que seja um dia real do calendário. */
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}

/** "HH:MM" -> minutos do dia. Lança se o formato estiver errado. */
function timeToMinutes(value) {
  if (!isValidTime(value)) throw new RangeError(`Horário inválido: ${value}`);
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/** minutos do dia -> "HH:MM". */
function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Soma de dias em uma data ISO, sem passar por fuso. */
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Pode apostar nesta data?
 * - Dia atual: só até as 08:30.
 * - Datas futuras: sempre.
 * - Datas passadas: nunca.
 */
function checkBetWindow(targetDate, now) {
  if (!isValidDate(targetDate)) {
    return { ok: false, code: 'DATA_INVALIDA', message: 'Data inválida.' };
  }
  if (targetDate < now.date) {
    return {
      ok: false,
      code: 'DATA_PASSADA',
      message: 'Essa data já passou. Você só pode apostar em hoje (até as 08:30) ou em um dia futuro.',
    };
  }
  if (targetDate === now.date && now.minutes >= BET_CLOSE_MINUTES) {
    return {
      ok: false,
      code: 'PRAZO_ENCERRADO',
      message: 'As apostas de hoje fecharam às 08:30. Aposte em um dia futuro.',
    };
  }
  return { ok: true };
}

/** As apostas de um dia só aparecem para todos depois das 08:30 daquele dia. */
function betsAreVisible(targetDate, now) {
  if (targetDate < now.date) return true;
  if (targetDate > now.date) return false;
  return now.minutes >= BET_CLOSE_MINUTES;
}

/** O bolão do dia encerrou (passou do meio-dia daquele dia)? */
function isDaySettled(targetDate, now) {
  if (targetDate < now.date) return true;
  if (targetDate > now.date) return false;
  return now.minutes >= SETTLE_MINUTES;
}

/** Admin não registra chegada de um dia que ainda não aconteceu. */
function checkResultWindow(targetDate, now) {
  if (!isValidDate(targetDate)) {
    return { ok: false, code: 'DATA_INVALIDA', message: 'Data inválida.' };
  }
  if (targetDate > now.date) {
    return {
      ok: false,
      code: 'DATA_FUTURA',
      message: 'Não dá para registrar a chegada de um dia que ainda não aconteceu.',
    };
  }
  return { ok: true };
}

/**
 * Vencedores do dia.
 *
 * Ganha a aposta mais próxima do horário real que seja IGUAL OU POSTERIOR a
 * ele — o tempo não volta para trás, então quem apostou antes está eliminado.
 * Empate no horário vencedor: todos ganham.
 *
 * @param {Array<{minutes:number}>} bets apostas do dia
 * @param {number|null} arrivalMinutes horário de chegada, ou null se não registrado
 */
function findWinners(bets, arrivalMinutes) {
  if (arrivalMinutes === null || arrivalMinutes === undefined) return [];
  const eligible = bets.filter((bet) => bet.minutes >= arrivalMinutes);
  if (eligible.length === 0) return [];
  const winningMinutes = Math.min(...eligible.map((bet) => bet.minutes));
  return bets.filter((bet) => bet.minutes === winningMinutes);
}

/**
 * Vencedores do dia e quantos pontos cada um leva.
 *
 * Acerto exato vale 2; vitória pela aposta posterior mais próxima vale 1.
 * Todos os vencedores apostaram o mesmo horário, então a pontuação é uma só
 * para o dia — empatados levam a pontuação cheia, sem dividir.
 *
 * @returns {{winners: Array, points: number}} points é 0 quando não há vencedor
 */
function scoreDay(bets, arrivalMinutes) {
  const winners = findWinners(bets, arrivalMinutes);
  if (winners.length === 0) return { winners, points: 0 };
  const points = winners[0].minutes === arrivalMinutes ? POINTS_EXACT : POINTS_CLOSEST;
  return { winners, points };
}

/**
 * Situação do dia, do ponto de vista de quem está olhando.
 *
 * - `apostas_abertas`: ainda dá para apostar; apostas dos outros escondidas.
 * - `aguardando_chegada`: apostas fechadas, Perico ainda não bateu o ponto.
 * - `com_resultado`: chegada registrada (pode ter vencedor ou não).
 * - `sem_resultado`: passou do meio-dia sem chegada registrada — dia sem vencedor.
 */
function dayStatus(targetDate, now, arrivalMinutes) {
  const visible = betsAreVisible(targetDate, now);
  if (visible && arrivalMinutes !== null && arrivalMinutes !== undefined) return 'com_resultado';
  if (!visible) return 'apostas_abertas';
  return isDaySettled(targetDate, now) ? 'sem_resultado' : 'aguardando_chegada';
}

/**
 * Ranking geral: pontos por usuário. Desempate por vitórias e, depois, por
 * menos apostas feitas — quem chegou lá apostando menos vai na frente. Só
 * entra quem fez ao menos uma aposta, em qualquer data.
 *
 * Só conta dias já revelados (depois das 08:30 daquele dia) e que tenham
 * horário de chegada registrado — um dia ainda em aberto não pontua. Como
 * tudo sai das apostas e das chegadas, nada guardado precisa ser recalculado.
 *
 * @param {Array<{id:number,name:string}>} users
 * @param {Array<{userId:number,date:string,minutes:number}>} bets todas as apostas
 * @param {Array<{date:string,minutes:number}>} results chegadas registradas
 * @param {{date:string,minutes:number}} now agora em São Paulo
 */
function computeRanking(users, bets, results, now) {
  const betsByDate = new Map();
  const totalByUser = new Map();
  for (const bet of bets) {
    if (!betsByDate.has(bet.date)) betsByDate.set(bet.date, []);
    betsByDate.get(bet.date).push(bet);
    totalByUser.set(bet.userId, (totalByUser.get(bet.userId) ?? 0) + 1);
  }

  const winsByUser = new Map();
  const pointsByUser = new Map();
  for (const result of results) {
    if (!betsAreVisible(result.date, now)) continue;
    const { winners, points } = scoreDay(betsByDate.get(result.date) ?? [], result.minutes);
    for (const winner of winners) {
      winsByUser.set(winner.userId, (winsByUser.get(winner.userId) ?? 0) + 1);
      pointsByUser.set(winner.userId, (pointsByUser.get(winner.userId) ?? 0) + points);
    }
  }

  // Quem nunca apostou não entra no ranking.
  return users
    .filter((user) => totalByUser.has(user.id))
    .map((user) => ({
      name: user.name,
      points: pointsByUser.get(user.id) ?? 0,
      wins: winsByUser.get(user.id) ?? 0,
      totalBets: totalByUser.get(user.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.wins - a.wins ||
        a.totalBets - b.totalBets ||
        a.name.localeCompare(b.name, 'pt-BR'),
    );
}

module.exports = {
  TIMEZONE,
  BET_CLOSE_MINUTES,
  SETTLE_MINUTES,
  POINTS_EXACT,
  POINTS_CLOSEST,
  nowInSaoPaulo,
  saoPauloEpochMs,
  isValidDate,
  isValidTime,
  timeToMinutes,
  minutesToTime,
  addDays,
  checkBetWindow,
  betsAreVisible,
  isDaySettled,
  checkResultWindow,
  findWinners,
  scoreDay,
  dayStatus,
  computeRanking,
};
