'use strict';

/* ===========================================================================
   Bolão do Perico — front-end.

   Este arquivo só desenha e pede. Nenhuma regra de prazo é decidida aqui:
   o servidor diz o que está aberto, o que está visível e quem ganhou. O
   relógio do navegador só serve para animar a contagem, sempre corrigido
   pelo deslocamento medido contra o relógio do servidor.
   =========================================================================== */

/** O nome é a identificação: o navegador só lembra dele para não perguntar de novo. */
const NAME_KEY = 'bolao-perico-nome';
/** Onde ficava o token, quando o usuário era preso a um navegador. Só para limpar. */
const LEGACY_TOKEN_KEY = 'bolao-perico-token';
const REFRESH_MS = 30_000;

const state = {
  /** Nome como está gravado no servidor; vai em todo pedido. */
  userName: null,
  /** Data selecionada, "YYYY-MM-DD". */
  date: null,
  /** Hoje segundo o servidor. */
  today: null,
  /** serverEpoch - clienteEpoch, medido na última resposta. */
  clockSkewMs: 0,
  day: null,
  ranking: [],
};

const $ = (id) => document.getElementById(id);

const dom = {};
for (const id of [
  'gate', 'gate-form', 'gate-name', 'gate-error', 'gate-submit',
  'app', 'whoami-name', 'logout',
  'clock', 'clock-label', 'clock-readout', 'clock-foot',
  'day-prev', 'day-next', 'day-input', 'day-today',
  'bet-panel', 'bet-form', 'bet-time', 'bet-submit', 'bet-stamp', 'bet-stamp-time',
  'bet-note', 'bet-error',
  'day-tally', 'strip', 'day-note',
  'ranking', 'ranking-note',
  'admin-form', 'admin-password', 'admin-date', 'admin-time', 'admin-submit',
  'admin-error', 'admin-ok',
  'foot-close',
]) {
  dom[id] = $(id);
}

// --- Utilidades -------------------------------------------------------------

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Header só carrega Latin-1; o servidor decodifica.
  if (state.userName) headers['x-bolao-usuario'] = encodeURIComponent(state.userName);

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('SEM_CONEXAO', 'Não conseguimos falar com o servidor. Tente de novo.', 0);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(err.code ?? 'ERRO', err.message ?? 'Algo deu errado.', res.status);
  }

  // Toda resposta que carrega o relógio do servidor atualiza o deslocamento.
  if (data?.serverNow?.epochMs) {
    state.clockSkewMs = data.serverNow.epochMs - Date.now();
  }
  if (data?.today) state.today = data.today;

  return data;
}

/** Agora em epoch ms, corrigido pelo relógio do servidor. */
const nowMs = () => Date.now() + state.clockSkewMs;

/** Soma dias a uma data ISO sem passar por fuso horário. */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const weekdayFmt = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC',
});

/** "2026-10-07" -> "qua, 07/10" */
function formatDate(isoDate) {
  const label = weekdayFmt.format(new Date(`${isoDate}T12:00:00Z`));
  return label.replace('.,', ',').replace(/^(\w)/, (c) => c.toUpperCase());
}

/** "2026-10-07" -> "07/10" */
const shortDate = (isoDate) => isoDate.split('-').reverse().slice(0, 2).join('/');

const listFmt = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' });

/** "+1 ponto", "+2 pontos". */
const pointsLabel = (points) => `+${points} ${points === 1 ? 'ponto' : 'pontos'}`;

/**
 * Resumo do vencedor com os pontos, como o servidor calculou:
 * "Ganhou: Silva. +1 ponto." / "Na mosca: Ana e Bruno. +2 pontos para cada."
 */
function winnersSummary({ winners, winnerPoints, exactHit }) {
  const head = exactHit ? 'Na mosca' : winners.length === 1 ? 'Ganhou' : 'Ganharam';
  const each = winners.length > 1 ? ' para cada' : '';
  return `${head}: ${listFmt.format(winners)}. ${pointsLabel(winnerPoints)}${each}.`;
}

/** Nome do dia relativo a hoje: "hoje", "amanhã", "ontem" ou a data. */
function dayWord(isoDate) {
  if (!state.today) return formatDate(isoDate);
  if (isoDate === state.today) return 'hoje';
  if (isoDate === addDays(state.today, 1)) return 'amanhã';
  if (isoDate === addDays(state.today, -1)) return 'ontem';
  return formatDate(isoDate);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = false;
}

function clearError(node) {
  node.textContent = '';
  node.hidden = true;
}

function setNote(node, message) {
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = '';
    node.hidden = true;
  }
}

/** Desabilita o botão enquanto a requisição está no ar. */
async function whileBusy(button, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Aguarde…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// --- Porteiro ---------------------------------------------------------------

dom['gate-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(dom['gate-error']);

  const name = dom['gate-name'].value.trim();
  if (!name) {
    showError(dom['gate-error'], 'Digite um nome para entrar.');
    return;
  }

  let user;
  try {
    // Nome que já existe entra como esse usuário; nome novo é criado.
    const data = await whileBusy(dom['gate-submit'], () => api('POST', '/api/users', { name }));
    user = data.user;
  } catch (err) {
    showError(dom['gate-error'], err.message);
    return;
  }

  rememberUser(user.name);
  await enterApp();
});

/** Guarda o nome como o servidor devolveu — quem digitou "ana" é a "Ana". */
function rememberUser(name) {
  state.userName = name;
  localStorage.setItem(NAME_KEY, name);
}

/** Esquece o nome neste navegador e volta para o porteiro. */
function forgetUser(message, prefill = '') {
  localStorage.removeItem(NAME_KEY);
  state.userName = null;
  state.day = null;

  // Nada do usuário anterior fica para trás, nem a senha de admin digitada.
  dom['bet-time'].value = '';
  dom['admin-password'].value = '';
  clearError(dom['bet-error']);
  clearError(dom['admin-error']);
  setNote(dom['admin-ok'], '');

  dom['app'].hidden = true;
  dom['gate'].hidden = false;
  dom['gate-name'].value = prefill;
  if (message) showError(dom['gate-error'], message);
  else clearError(dom['gate-error']);
  dom['gate-name'].focus();
}

dom['logout'].addEventListener('click', () => forgetUser());

// --- Navegação de dia -------------------------------------------------------

async function selectDate(isoDate) {
  state.date = isoDate;
  dom['day-input'].value = isoDate;
  clearError(dom['bet-error']);
  await loadDay();
}

dom['day-prev'].addEventListener('click', () => selectDate(addDays(state.date, -1)));
dom['day-next'].addEventListener('click', () => selectDate(addDays(state.date, 1)));
dom['day-today'].addEventListener('click', () => selectDate(state.today));

dom['day-input'].addEventListener('change', () => {
  const value = dom['day-input'].value;
  if (value) selectDate(value);
  else dom['day-input'].value = state.date;
});

// --- Aposta -----------------------------------------------------------------

dom['bet-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(dom['bet-error']);

  const time = dom['bet-time'].value;
  if (!time) {
    showError(dom['bet-error'], 'Escolha um horário para apostar.');
    return;
  }

  try {
    await whileBusy(dom['bet-submit'], async () => {
      state.day = await api('POST', '/api/bets', { date: state.date, time });
    });
  } catch (err) {
    if (err.code === 'SEM_USUARIO') return userVanished();
    showError(dom['bet-error'], err.message);
    // O servidor pode ter recusado por prazo: recarrega para refletir o estado real.
    await loadDay();
    return;
  }

  dom['bet-time'].value = '';
  renderDayView();
  await loadRanking();
});

// --- Admin ------------------------------------------------------------------

dom['admin-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError(dom['admin-error']);
  setNote(dom['admin-ok'], '');

  const password = dom['admin-password'].value;
  const date = dom['admin-date'].value;
  const time = dom['admin-time'].value;

  if (!password || !date || !time) {
    showError(dom['admin-error'], 'Preencha a senha, o dia e o horário de chegada.');
    return;
  }

  let result;
  try {
    result = await whileBusy(dom['admin-submit'], () =>
      api('POST', '/api/admin/result', { password, date, time }),
    );
  } catch (err) {
    showError(dom['admin-error'], err.message);
    return;
  }

  const quem = result.winners.length
    ? winnersSummary(result)
    : 'Ninguém acertou: todas as apostas foram antes desse horário.';
  setNote(dom['admin-ok'], `Chegada de ${shortDate(date)} registrada às ${time}. ${quem}`);

  if (date === state.date) await loadDay();
  await loadRanking();
});

// --- Carregamento -----------------------------------------------------------

async function loadDay() {
  const asked = state.userName;
  let day;
  try {
    day = await api('GET', `/api/day?date=${encodeURIComponent(state.date)}`);
  } catch (err) {
    showError(dom['bet-error'], err.message);
    return;
  }
  // Resposta que chegou depois de um "Sair": era de outra pessoa, descarta.
  if (asked !== state.userName) return;
  state.day = day;
  renderDayView();
}

async function loadRanking() {
  try {
    const data = await api('GET', '/api/ranking');
    state.ranking = data.ranking;
  } catch {
    return; // Ranking é secundário: se falhar, mantém o que já está na tela.
  }
  renderRanking();
}

/** O nome lembrado não existe mais no servidor (banco recriado, por exemplo). */
function userVanished() {
  const name = state.userName ?? '';
  forgetUser(`Não encontramos "${name}" no bolão. Entre de novo para continuar.`, name);
}

// --- Desenho: relógio -------------------------------------------------------

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Monta "01:42:07" com os dois-pontos piscando. */
function renderCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  dom['clock-readout'].replaceChildren(
    document.createTextNode(pad2(h)),
    el('span', 'clock__sep', ':'),
    document.createTextNode(pad2(m)),
    el('span', 'clock__sep', ':'),
    document.createTextNode(pad2(s)),
  );
}

function setReadout(text, variant) {
  dom['clock-readout'].className = `clock__readout clock__readout--closed${variant ? ` ${variant}` : ''}`;
  dom['clock-readout'].textContent = text;
}

function renderClock() {
  const day = state.day;
  if (!day) return;

  const quando = dayWord(day.date);
  const remaining = day.betCloseEpochMs - nowMs();

  if (day.status === 'apostas_abertas') {
    if (remaining <= 0) {
      // Virou a hora entre dois ticks: o servidor manda a palavra.
      dom['clock-label'].textContent = 'fechando as apostas';
      setReadout('Atualizando…');
      void loadDay();
      return;
    }
    dom['clock-label'].textContent =
      day.date === state.today ? 'apostas de hoje fecham em' : `apostas de ${quando} fecham em`;
    dom['clock-readout'].className = 'clock__readout';
    renderCountdown(remaining);
    dom['clock-foot'].textContent = `${formatDate(day.date)} · fecham às ${day.betCloseTime}`;
    return;
  }

  if (day.status === 'com_resultado') {
    dom['clock-label'].textContent = `${quando}, o Perico bateu o ponto às`;
    setReadout(day.arrivalTime, 'clock__readout--late');
    dom['clock-readout'].classList.remove('clock__readout--closed');
    dom['clock-foot'].textContent = day.winners.length
      ? winnersSummary(day)
      : 'Ninguém acertou: todas as apostas foram antes da chegada.';
    return;
  }

  if (day.status === 'aguardando_chegada') {
    dom['clock-label'].textContent = `apostas de ${quando} fechadas`;
    setReadout('Perico ainda não bateu o ponto');
    dom['clock-foot'].textContent = `O dia encerra às ${day.settleTime}.`;
    return;
  }

  dom['clock-label'].textContent = `${quando}, dia encerrado`;
  setReadout('Sem registro de chegada');
  dom['clock-foot'].textContent = `Encerrou às ${day.settleTime} sem horário registrado. Dia sem vencedor.`;
}

// --- Desenho: aposta --------------------------------------------------------

function renderBet() {
  const day = state.day;
  const quando = dayWord(day.date);

  if (day.myBet) {
    dom['bet-form'].hidden = true;
    dom['bet-stamp'].hidden = false;
    dom['bet-stamp-time'].textContent = day.myBet;
    setNote(
      dom['bet-note'],
      `Sua aposta para ${quando} (${shortDate(day.date)}). A aposta é única por dia e não pode ser trocada nem apagada.`,
    );
    return;
  }

  dom['bet-stamp'].hidden = true;

  if (day.betWindow.ok) {
    dom['bet-form'].hidden = false;
    setNote(dom['bet-note'], `Você ainda não apostou em ${quando}. Vale um palpite só.`);
    return;
  }

  dom['bet-form'].hidden = true;
  setNote(dom['bet-note'], day.betWindow.message);
}

// --- Desenho: a fita do dia -------------------------------------------------

function betRow(bet, exactHit) {
  const classes = ['strip__row'];
  if (bet.isWinner) classes.push('strip__row--win');
  else if (bet.isEliminated) classes.push('strip__row--out');
  if (bet.isMine) classes.push('strip__row--mine');

  const row = el('li', classes.join(' '));
  row.append(el('span', 'strip__time', bet.time), el('span', 'strip__name', bet.name));

  if (bet.isWinner) {
    row.append(el('span', 'strip__tag', `${exactHit ? 'na mosca' : 'ganhou'} +${bet.points}`));
  }
  else if (bet.isEliminated) row.append(el('span', 'strip__tag', 'fora'));

  return row;
}

function arrivalRow(time) {
  const row = el('li', 'strip__arrival');
  row.append(
    el('span', 'strip__time', time),
    el('span', 'strip__arrival-label', 'bateu o ponto'),
  );
  return row;
}

function renderDay() {
  const day = state.day;
  const strip = dom['strip'];
  strip.replaceChildren();

  if (!day.betsVisible) {
    dom['day-tally'].textContent = day.totalBets === 1 ? '1 aposta' : `${day.totalBets} apostas`;
    setNote(
      dom['day-note'],
      day.totalBets === 0
        ? `Ninguém apostou em ${dayWord(day.date)} ainda. Seja o primeiro.`
        : `Os palpites aparecem às ${day.betCloseTime}. Até lá ninguém vê a aposta de ninguém.`,
    );
    return;
  }

  dom['day-tally'].textContent = day.bets.length === 1 ? '1 aposta' : `${day.bets.length} apostas`;

  if (day.bets.length === 0) {
    setNote(dom['day-note'], `Ninguém apostou em ${dayWord(day.date)}.`);
    return;
  }

  // A linha vermelha da chegada entra no lugar certo da ordem: tudo acima
  // dela apostou antes do Perico e está fora.
  let arrivalPlaced = day.arrivalTime === null;
  for (const bet of day.bets) {
    if (!arrivalPlaced && bet.time >= day.arrivalTime) {
      strip.append(arrivalRow(day.arrivalTime));
      arrivalPlaced = true;
    }
    strip.append(betRow(bet, day.exactHit));
  }
  if (!arrivalPlaced) strip.append(arrivalRow(day.arrivalTime));

  if (day.arrivalTime === null) {
    setNote(
      dom['day-note'],
      day.settled
        ? `Encerrou às ${day.settleTime} sem horário registrado. Dia sem vencedor.`
        : `Perico ainda não bateu o ponto. O dia encerra às ${day.settleTime}.`,
    );
  } else if (day.winners.length === 0) {
    setNote(
      dom['day-note'],
      `Ninguém acertou: todas as apostas foram antes das ${day.arrivalTime}.`,
    );
  } else {
    setNote(dom['day-note'], winnersSummary(day));
  }
}

// --- Desenho: ranking -------------------------------------------------------

function renderRanking() {
  const list = dom['ranking'];
  list.replaceChildren();

  if (state.ranking.length === 0) {
    setNote(dom['ranking-note'], 'Ninguém apostou ainda. Quem fizer a primeira aposta entra no ranking.');
    return;
  }

  const temVitoria = state.ranking.some((row) => row.wins > 0);
  setNote(
    dom['ranking-note'],
    temVitoria ? '' : 'Ninguém venceu ainda. O primeiro resultado sai depois das 08:30.',
  );

  state.ranking.forEach((entry, index) => {
    const classes = ['ranking__row'];
    if (index === 0 && entry.points > 0) classes.push('ranking__row--lead');
    if (entry.name === state.userName) classes.push('ranking__row--mine');

    const row = el('li', classes.join(' '));
    const score = el('span', 'ranking__score');
    score.append(
      el('span', 'ranking__points', String(entry.points)),
      el('span', 'ranking__dot', '·'),
      el('span', 'ranking__wins', String(entry.wins)),
      el('span', 'ranking__dot', '·'),
      el('span', 'ranking__bets', String(entry.totalBets)),
    );
    row.append(
      el('span', 'ranking__pos', `${index + 1}`),
      el('span', 'ranking__name', entry.name),
      score,
    );
    list.append(row);
  });
}

function renderDayView() {
  renderClock();
  renderBet();
  renderDay();
}

// --- Arranque ---------------------------------------------------------------

let timersStarted = false;

/** Relógio e atualização periódica: ligados uma vez, quietos sem usuário. */
function startTimers() {
  if (timersStarted) return;
  timersStarted = true;

  const refresh = () => {
    if (!state.userName) return;
    void loadDay();
    void loadRanking();
  };

  setInterval(renderClock, 1000);
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
}

async function enterApp() {
  dom['whoami-name'].textContent = state.userName;

  state.date = state.date ?? state.today;
  dom['day-input'].value = state.date;
  // O seletor nativo não oferece datas passadas; as setas ainda permitem rever.
  dom['day-input'].min = state.today;
  dom['admin-date'].value = state.today;
  dom['admin-date'].max = state.today;

  // Carrega antes de mostrar: depois de um "Sair", a tela ainda tem o dia
  // de quem saiu.
  await Promise.all([loadDay(), loadRanking()]);

  dom['gate'].hidden = true;
  dom['app'].hidden = false;
  clearError(dom['gate-error']);
  startTimers();
}

async function boot() {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  state.userName = localStorage.getItem(NAME_KEY);

  let session;
  try {
    session = await api('GET', '/api/session');
  } catch {
    dom['gate'].hidden = false;
    showError(dom['gate-error'], 'Não conseguimos falar com o servidor. Recarregue a página.');
    return;
  }

  state.today = session.today;
  dom['foot-close'].textContent = session.betCloseTime;

  if (!session.user) {
    // Primeiro acesso neste navegador, ou um nome lembrado que sumiu do banco.
    if (state.userName) return userVanished();
    dom['gate'].hidden = false;
    dom['gate-name'].focus();
    return;
  }

  rememberUser(session.user.name);
  await enterApp();
}

void boot();
