'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BET_CLOSE_MINUTES,
  SETTLE_MINUTES,
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
  POINTS_EXACT,
  POINTS_CLOSEST,
  dayStatus,
  computeRanking,
} = require('../src/rules.js');

/** Atalho: "agora" em São Paulo, montado à mão para os testes. */
const at = (date, time, seconds = 0) => ({
  date,
  minutes: timeToMinutes(time),
  seconds,
  epochMs: saoPauloEpochMs(date, timeToMinutes(time)) + seconds * 1000,
});

/** Atalho: lista de apostas a partir de pares [nome, "HH:MM"]. */
const bets = (...pairs) => pairs.map(([userName, time]) => ({ userName, minutes: timeToMinutes(time) }));

const names = (list) => list.map((b) => b.userName).sort();

// ---------------------------------------------------------------------------
// Conversões básicas
// ---------------------------------------------------------------------------

test('timeToMinutes e minutesToTime são inversas', () => {
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('08:30'), 510);
  assert.equal(timeToMinutes('23:59'), 1439);
  assert.equal(minutesToTime(0), '00:00');
  assert.equal(minutesToTime(510), '08:30');
  assert.equal(minutesToTime(1439), '23:59');
});

test('isValidTime recusa horários fora do relógio de 24h', () => {
  for (const ok of ['00:00', '08:05', '12:00', '23:59']) {
    assert.equal(isValidTime(ok), true, `deveria aceitar ${ok}`);
  }
  for (const bad of ['24:00', '08:60', '8:30', '0830', '08:3', '', null, undefined, '08:30:00']) {
    assert.equal(isValidTime(bad), false, `deveria recusar ${String(bad)}`);
  }
});

test('isValidDate exige dia real do calendário', () => {
  assert.equal(isValidDate('2026-10-07'), true);
  assert.equal(isValidDate('2024-02-29'), true, 'ano bissexto tem 29/02');
  assert.equal(isValidDate('2025-02-29'), false, 'ano comum não tem 29/02');
  assert.equal(isValidDate('2026-04-31'), false, 'abril tem 30 dias');
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('07/10/2026'), false);
  assert.equal(isValidDate('2026-1-1'), false);
});

test('addDays atravessa viradas de mês e de ano', () => {
  assert.equal(addDays('2026-10-07', 1), '2026-10-08');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ---------------------------------------------------------------------------
// Fuso America/Sao_Paulo
// ---------------------------------------------------------------------------

test('nowInSaoPaulo converte instantes UTC para o dia e a hora de São Paulo', () => {
  // 2026-10-07T13:00:00Z = 10:00 em São Paulo (UTC-3).
  const n = nowInSaoPaulo(new Date('2026-10-07T13:00:00Z'));
  assert.equal(n.date, '2026-10-07');
  assert.equal(n.minutes, BET_CLOSE_MINUTES);

  // 02:00Z ainda é o dia anterior em São Paulo — o caso que mais quebra bolão.
  const virada = nowInSaoPaulo(new Date('2026-10-08T02:00:00Z'));
  assert.equal(virada.date, '2026-10-07');
  assert.equal(virada.minutes, 23 * 60);
});

test('saoPauloEpochMs e nowInSaoPaulo fecham a volta', () => {
  const epoch = saoPauloEpochMs('2026-10-07', BET_CLOSE_MINUTES);
  assert.equal(new Date(epoch).toISOString(), '2026-10-07T13:00:00.000Z');
  const back = nowInSaoPaulo(new Date(epoch));
  assert.equal(back.date, '2026-10-07');
  assert.equal(back.minutes, BET_CLOSE_MINUTES);
});

// ---------------------------------------------------------------------------
// Prazo para apostar
// ---------------------------------------------------------------------------

test('aposta no dia atual é aceita antes das 10:00', () => {
  assert.equal(checkBetWindow('2026-10-07', at('2026-10-07', '06:00')).ok, true);
  assert.equal(checkBetWindow('2026-10-07', at('2026-10-07', '09:59', 59)).ok, true);
});

test('aposta no dia atual é bloqueada a partir das 10:00 em ponto', () => {
  const res = checkBetWindow('2026-10-07', at('2026-10-07', '10:00'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PRAZO_ENCERRADO');
  assert.match(res.message, /10:00/);

  assert.equal(checkBetWindow('2026-10-07', at('2026-10-07', '10:01')).ok, false);
  assert.equal(checkBetWindow('2026-10-07', at('2026-10-07', '23:59')).ok, false);
});

test('aposta no dia atual é bloqueada assim que a chegada é registrada, mesmo antes das 10:00', () => {
  const res = checkBetWindow('2026-10-07', at('2026-10-07', '08:15'), timeToMinutes('08:05'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'CHEGADA_REGISTRADA');
  assert.equal(checkBetWindow('2026-10-07', at('2026-10-07', '08:15'), null).ok, true, 'sem chegada, segue aberta');
});

test('aposta em data passada é sempre bloqueada, mesmo de madrugada', () => {
  for (const hora of ['00:00', '07:00', '08:29', '12:00', '23:59']) {
    const res = checkBetWindow('2026-10-06', at('2026-10-07', hora));
    assert.equal(res.ok, false, `deveria bloquear às ${hora}`);
    assert.equal(res.code, 'DATA_PASSADA');
  }
});

test('aposta em data futura é aceita a qualquer hora do dia', () => {
  for (const hora of ['00:00', '08:30', '12:00', '23:59']) {
    assert.equal(checkBetWindow('2026-10-08', at('2026-10-07', hora)).ok, true, `deveria aceitar às ${hora}`);
  }
  assert.equal(checkBetWindow('2027-01-01', at('2026-10-07', '20:00')).ok, true);
});

test('checkBetWindow recusa data malformada antes de olhar o prazo', () => {
  const res = checkBetWindow('07/10/2026', at('2026-10-07', '06:00'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DATA_INVALIDA');
});

// ---------------------------------------------------------------------------
// Visibilidade das apostas (ninguém copia)
// ---------------------------------------------------------------------------

test('apostas do dia ficam escondidas até as 10:00 e aparecem depois', () => {
  assert.equal(betsAreVisible('2026-10-07', at('2026-10-07', '09:59', 59)), false);
  assert.equal(betsAreVisible('2026-10-07', at('2026-10-07', '10:00')), true);
  assert.equal(betsAreVisible('2026-10-07', at('2026-10-07', '12:00')), true);
});

test('apostas do dia aparecem assim que a chegada é registrada, mesmo antes das 10:00', () => {
  assert.equal(betsAreVisible('2026-10-07', at('2026-10-07', '08:15'), timeToMinutes('08:05')), true);
  assert.equal(betsAreVisible('2026-10-07', at('2026-10-07', '08:15'), null), false);
});

test('apostas de dia futuro ficam escondidas; de dia passado ficam visíveis', () => {
  assert.equal(betsAreVisible('2026-10-08', at('2026-10-07', '23:59')), false);
  assert.equal(betsAreVisible('2026-10-06', at('2026-10-07', '00:01')), true);
});

// ---------------------------------------------------------------------------
// Encerramento ao meio-dia
// ---------------------------------------------------------------------------

test('o dia encerra ao meio-dia em ponto', () => {
  assert.equal(isDaySettled('2026-10-07', at('2026-10-07', '11:59', 59)), false);
  assert.equal(isDaySettled('2026-10-07', at('2026-10-07', '12:00')), true);
  assert.equal(SETTLE_MINUTES, 720);
});

test('dia passado já está encerrado; dia futuro ainda não', () => {
  assert.equal(isDaySettled('2026-10-06', at('2026-10-07', '00:00')), true);
  assert.equal(isDaySettled('2026-10-08', at('2026-10-07', '23:59')), false);
});

test('registro de chegada aceita hoje e passado, recusa futuro', () => {
  assert.equal(checkResultWindow('2026-10-07', at('2026-10-07', '10:30')).ok, true);
  assert.equal(checkResultWindow('2026-10-06', at('2026-10-07', '10:30')).ok, true);
  const res = checkResultWindow('2026-10-08', at('2026-10-07', '10:30'));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'DATA_FUTURA');
});

// ---------------------------------------------------------------------------
// Regra do vencedor
// ---------------------------------------------------------------------------

test('exemplo do enunciado: Perico chegou 08:56, 08:55 perde e 08:57 ganha', () => {
  const dia = bets(['Ana', '08:55'], ['Bruno', '08:57'], ['Carla', '09:10']);
  const winners = findWinners(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Bruno']);
});

test('aposta exatamente no horário de chegada ganha', () => {
  const dia = bets(['Ana', '08:56'], ['Bruno', '08:57']);
  assert.deepEqual(names(findWinners(dia, timeToMinutes('08:56'))), ['Ana']);
});

test('apostas anteriores à chegada estão eliminadas, por mais perto que estejam', () => {
  // 08:55 está a 1 minuto da chegada; 09:30 está a 34. Ainda assim ganha 09:30.
  const dia = bets(['Ana', '08:55'], ['Bruno', '09:30']);
  assert.deepEqual(names(findWinners(dia, timeToMinutes('08:56'))), ['Bruno']);
});

test('empate no horário vencedor: todos ganham', () => {
  const dia = bets(['Ana', '08:57'], ['Bruno', '08:57'], ['Carla', '08:58'], ['Diego', '08:50']);
  assert.deepEqual(names(findWinners(dia, timeToMinutes('08:56'))), ['Ana', 'Bruno']);
});

test('empate exatamente no horário de chegada: todos ganham', () => {
  const dia = bets(['Ana', '08:56'], ['Bruno', '08:56'], ['Carla', '08:57']);
  assert.deepEqual(names(findWinners(dia, timeToMinutes('08:56'))), ['Ana', 'Bruno']);
});

test('se todas as apostas são anteriores à chegada, o dia fica sem vencedor', () => {
  const dia = bets(['Ana', '08:30'], ['Bruno', '08:45'], ['Carla', '08:55']);
  assert.deepEqual(findWinners(dia, timeToMinutes('09:00')), []);
});

test('sem chegada registrada não há vencedor, mesmo com apostas', () => {
  const dia = bets(['Ana', '08:40'], ['Bruno', '09:00']);
  assert.deepEqual(findWinners(dia, null), []);
  assert.deepEqual(findWinners(dia, undefined), []);
});

test('dia sem apostas fica sem vencedor', () => {
  assert.deepEqual(findWinners([], timeToMinutes('08:56')), []);
});

test('a ordem das apostas na lista não muda o vencedor', () => {
  const dia = bets(['Ana', '09:10'], ['Bruno', '08:57'], ['Carla', '08:55'], ['Diego', '08:57']);
  const direta = names(findWinners(dia, timeToMinutes('08:56')));
  const invertida = names(findWinners([...dia].reverse(), timeToMinutes('08:56')));
  assert.deepEqual(direta, ['Bruno', 'Diego']);
  assert.deepEqual(invertida, direta);
});

test('chegada pontual às 08:00 premia a aposta mais cedo a partir dali', () => {
  const dia = bets(['Ana', '07:55'], ['Bruno', '08:00'], ['Carla', '08:01']);
  assert.deepEqual(names(findWinners(dia, timeToMinutes('08:00'))), ['Bruno']);
});

// ---------------------------------------------------------------------------
// Pontuação do dia
// ---------------------------------------------------------------------------

test('a pontuação vale 2 no acerto exato e 1 por proximidade', () => {
  assert.equal(POINTS_EXACT, 2);
  assert.equal(POINTS_CLOSEST, 1);
});

test('acerto exato: quem apostou o horário da chegada leva 2 pontos', () => {
  const dia = bets(['Ana', '08:56'], ['Bruno', '08:57'], ['Carla', '08:50']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Ana']);
  assert.equal(points, 2);
});

test('vitória por proximidade: a aposta posterior mais próxima leva 1 ponto', () => {
  // O exemplo do enunciado: chegou 08:56, 08:57 ganha por um minuto.
  const dia = bets(['Ana', '08:55'], ['Bruno', '08:57'], ['Carla', '09:10']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Bruno']);
  assert.equal(points, 1);
});

test('vitória por proximidade vale 1 mesmo longe da chegada', () => {
  const dia = bets(['Ana', '08:55'], ['Bruno', '10:30']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Bruno']);
  assert.equal(points, 1);
});

test('empate no acerto exato: todos os empatados levam os 2 pontos', () => {
  const dia = bets(['Ana', '08:56'], ['Bruno', '08:56'], ['Carla', '08:57']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Ana', 'Bruno']);
  assert.equal(points, 2, 'pontuação cheia, sem dividir');
});

test('empate por proximidade: todos os empatados levam 1 ponto', () => {
  const dia = bets(['Ana', '08:57'], ['Bruno', '08:57'], ['Carla', '08:58'], ['Diego', '08:50']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:56'));
  assert.deepEqual(names(winners), ['Ana', 'Bruno']);
  assert.equal(points, 1);
});

test('acerto exato vence a aposta logo depois, que não pontua', () => {
  const dia = bets(['Ana', '08:00'], ['Bruno', '08:01']);
  const { winners, points } = scoreDay(dia, timeToMinutes('08:00'));
  assert.deepEqual(names(winners), ['Ana']);
  assert.equal(points, 2);
});

test('dia sem vencedor não dá ponto a ninguém', () => {
  const antes = bets(['Ana', '08:30'], ['Bruno', '08:55']);
  assert.deepEqual(scoreDay(antes, timeToMinutes('09:00')), { winners: [], points: 0 });
  assert.deepEqual(scoreDay(antes, null), { winners: [], points: 0 }, 'sem chegada registrada');
  assert.deepEqual(scoreDay([], timeToMinutes('09:00')), { winners: [], points: 0 }, 'sem apostas');
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const USERS = [
  { id: 1, name: 'Ana' },
  { id: 2, name: 'Bruno' },
  { id: 3, name: 'Carla' },
  { id: 4, name: 'Diego' },
];

/** Atalho: apostas do ranking a partir de [userId, data, "HH:MM"]. */
const rankBets = (...rows) =>
  rows.map(([userId, date, time]) => ({ userId, date, minutes: timeToMinutes(time) }));

/** Atalho: chegadas a partir de [data, "HH:MM"]. */
const arrivals = (...rows) => rows.map(([date, time]) => ({ date, minutes: timeToMinutes(time) }));

test('ranking soma os pontos de dias passados e de hoje, já revelados', () => {
  const ranking = computeRanking(
    USERS.slice(0, 3),
    rankBets(
      [1, '2026-10-05', '09:00'], [2, '2026-10-05', '09:05'], // chegou 09:00: Ana na mosca (+2)
      [1, '2026-10-06', '08:50'], [2, '2026-10-06', '08:45'], // chegou 08:46: Ana por proximidade (+1)
      [2, '2026-10-07', '08:41'], [3, '2026-10-07', '08:41'], // chegou 08:41: Bruno e Carla na mosca (+2 cada)
    ),
    arrivals(['2026-10-05', '09:00'], ['2026-10-06', '08:46'], ['2026-10-07', '08:41']),
    at('2026-10-07', '10:30'),
  );
  assert.deepEqual(ranking, [
    { name: 'Ana', points: 3, wins: 2, totalBets: 2 },
    { name: 'Carla', points: 2, wins: 1, totalBets: 1 }, // empata com Bruno, apostou menos
    { name: 'Bruno', points: 2, wins: 1, totalBets: 3 },
  ]);
});

test('ranking ordena por pontos, depois vitórias, depois menos apostas', () => {
  const ranking = computeRanking(
    USERS,
    rankBets(
      // Ana: um acerto exato = 2 pontos, 1 vitória.
      [1, '2026-10-01', '09:00'],
      // Bruno: duas vitórias por proximidade = 2 pontos, 2 vitórias.
      [2, '2026-10-02', '09:10'], [2, '2026-10-03', '09:10'],
      // Carla e Diego: um ponto cada; Carla apostou menos vezes.
      [3, '2026-10-04', '09:10'],
      [4, '2026-10-05', '09:10'], [4, '2026-10-06', '08:00'],
    ),
    arrivals(
      ['2026-10-01', '09:00'], ['2026-10-02', '09:05'], ['2026-10-03', '09:05'],
      ['2026-10-04', '09:05'], ['2026-10-05', '09:05'], ['2026-10-06', '09:05'],
    ),
    at('2026-10-07', '10:30'),
  );
  assert.deepEqual(
    ranking.map((r) => [r.name, r.points, r.wins, r.totalBets]),
    [
      ['Bruno', 2, 2, 2], // empata em pontos com Ana e passa por ter mais vitórias
      ['Ana', 2, 1, 1],
      ['Carla', 1, 1, 1], // empata com Diego em pontos e vitórias, apostou menos
      ['Diego', 1, 1, 2],
    ],
  );
});

test('quem nunca apostou não entra no ranking', () => {
  const ranking = computeRanking(
    USERS, // Ana, Bruno, Carla e Diego estão cadastrados
    rankBets(
      [1, '2026-10-06', '08:50'], // Ana perdeu
      [2, '2026-10-06', '09:10'], // Bruno ganhou
      [3, '2026-10-08', '09:00'], // Carla só apostou num dia que ainda não chegou
    ),
    arrivals(['2026-10-06', '09:00']),
    at('2026-10-07', '10:30'),
  );
  assert.deepEqual(ranking, [
    { name: 'Bruno', points: 1, wins: 1, totalBets: 1 },
    { name: 'Ana', points: 0, wins: 0, totalBets: 1 },
    { name: 'Carla', points: 0, wins: 0, totalBets: 1 },
  ]);
  assert.ok(!ranking.some((r) => r.name === 'Diego'), 'Diego nunca apostou');
});

test('ranking vazio enquanto ninguém apostou', () => {
  assert.deepEqual(computeRanking(USERS, [], [], at('2026-10-07', '10:30')), []);
});

test('ranking pontua o dia de hoje assim que a chegada é registrada, mesmo antes das 10:00', () => {
  const dia = rankBets([1, '2026-10-07', '08:05']);
  const chegada = arrivals(['2026-10-07', '08:05']);
  const cedo = computeRanking(USERS.slice(0, 1), dia, chegada, at('2026-10-07', '08:10'));
  assert.deepEqual(cedo, [{ name: 'Ana', points: 2, wins: 1, totalBets: 1 }]);
});

// ---------------------------------------------------------------------------
// Situação do dia
// ---------------------------------------------------------------------------

test('dayStatus acompanha a linha do tempo do dia', () => {
  const hoje = '2026-10-07';
  assert.equal(dayStatus(hoje, at(hoje, '07:00'), null), 'apostas_abertas');
  assert.equal(dayStatus(hoje, at(hoje, '10:30'), null), 'aguardando_chegada');
  assert.equal(dayStatus(hoje, at(hoje, '10:30'), timeToMinutes('08:56')), 'com_resultado');
  assert.equal(dayStatus(hoje, at(hoje, '12:00'), null), 'sem_resultado');
  assert.equal(dayStatus(hoje, at(hoje, '12:00'), timeToMinutes('08:56')), 'com_resultado');
});

test('dayStatus: dia futuro fica aberto; hoje mostra o resultado assim que a chegada é registrada', () => {
  assert.equal(dayStatus('2026-10-08', at('2026-10-07', '20:00'), null), 'apostas_abertas');
  assert.equal(dayStatus('2026-10-07', at('2026-10-07', '08:10'), null), 'apostas_abertas');
  assert.equal(dayStatus('2026-10-07', at('2026-10-07', '08:10'), timeToMinutes('08:05')), 'com_resultado');
});
