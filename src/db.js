"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createClient } = require("@libsql/client");

const { timeToMinutes, minutesToTime } = require("./rules.js");

/**
 * Banco do bolão, sobre libSQL (o fork do SQLite que o Turso serve).
 *
 * Mesmo SQL de antes; o que mudou é que tudo virou assíncrono, porque em
 * produção o banco está do outro lado da rede. Três tabelas e nenhuma rota de
 * UPDATE/DELETE para apostas: a imutabilidade da aposta e o "uma por dia" são
 * garantidos pelo schema (UNIQUE), não só pela aplicação.
 */

// token é herança de quando o usuário era identificado por um token guardado
// no navegador. Hoje ninguém lê essa coluna — quem identifica é name_lower.
// Ela fica porque o SQLite não remove coluna UNIQUE sem reconstruir a tabela,
// e reconstruir users num banco cheio de apostas não vale o risco. Assim
// bancos novos e antigos continuam com o mesmo schema.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_lower  TEXT    NOT NULL UNIQUE,
  token       TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bets (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  bet_date    TEXT    NOT NULL,
  bet_minutes INTEGER NOT NULL CHECK (bet_minutes BETWEEN 0 AND 1439),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, bet_date)
);

CREATE INDEX IF NOT EXISTS bets_by_date ON bets (bet_date);

CREATE TABLE IF NOT EXISTS results (
  bet_date        TEXT    PRIMARY KEY,
  arrival_minutes INTEGER NOT NULL CHECK (arrival_minutes BETWEEN 0 AND 1439),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Violação de UNIQUE.
 *
 * O libSQL devolve `SQLITE_CONSTRAINT` genérico, que também cobre CHECK — por
 * isso a conferência é pela mensagem. Confundir os dois faria um horário
 * inválido virar "você já apostou".
 */
function isUniqueViolation(err) {
  return (
    err?.name === "LibsqlError" &&
    typeof err.message === "string" &&
    err.message.includes("UNIQUE constraint failed")
  );
}

/**
 * De onde ler a configuração do banco.
 *
 * Com TURSO_DATABASE_URL definida, fala com o Turso. Sem ela, usa um arquivo
 * local — o mesmo banco de antes, para desenvolver sem depender da rede.
 */
function configFromEnv(env = process.env) {
  if (env.TURSO_DATABASE_URL) {
    return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN };
  }
  // Na Vercel o disco é somente leitura e some a cada instância: sem Turso,
  // melhor falhar com uma mensagem clara do que com um erro de mkdir.
  if (env.VERCEL) {
    throw new Error(
      "Na Vercel o banco precisa ser o Turso: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN nas variáveis do projeto.",
    );
  }
  const file = env.DB_FILE ?? path.join(__dirname, "..", "data", "bolao.db");
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // O libSQL quer uma URL; pathToFileURL cuida de espaços e de letra de drive.
  return { url: pathToFileURL(absolute).href };
}

/**
 * Monta o repositório de acesso aos dados.
 *
 * @param {{url: string, authToken?: string}} config `{ url: ':memory:' }` nos testes
 */
function createStore(config) {
  const client = createClient(config);

  // O schema é criado uma vez por processo. Em serverless isso custa um
  // round trip por cold start, e é idempotente.
  let schemaReady = null;
  const ready = () => (schemaReady ??= client.executeMultiple(SCHEMA));

  async function rows(sql, args = []) {
    await ready();
    const result = await client.execute({ sql, args });
    return result.rows;
  }

  async function first(sql, args = []) {
    return (await rows(sql, args))[0] ?? null;
  }

  async function run(sql, args = []) {
    await ready();
    return client.execute({ sql, args });
  }

  return {
    /** Cria as tabelas. Útil para rodar uma vez contra o Turso. */
    migrate: ready,

    /** Cria o usuário. Devolve null se o nome já existir (comparação sem caixa). */
    async createUser(name) {
      try {
        // A coluna token continua obrigatória e única: recebe um valor
        // aleatório só para satisfazer o schema.
        const result = await run(
          "INSERT INTO users (name, name_lower, token) VALUES (?, ?, lower(hex(randomblob(16))))",
          [name, name.toLowerCase()],
        );
        return { id: Number(result.lastInsertRowid), name };
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async findUserByName(name) {
      return first("SELECT id, name FROM users WHERE name_lower = ?", [
        String(name).toLowerCase(),
      ]);
    },

    /** Registra a aposta. Devolve false se o usuário já tiver aposta nessa data. */
    async placeBet(userId, date, time) {
      try {
        await run(
          "INSERT INTO bets (user_id, bet_date, bet_minutes) VALUES (?, ?, ?)",
          [userId, date, timeToMinutes(time)],
        );
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    /** Aposta do usuário naquela data, como "HH:MM", ou null. */
    async getBet(userId, date) {
      const row = await first(
        "SELECT bet_minutes FROM bets WHERE user_id = ? AND bet_date = ?",
        [userId, date],
      );
      return row ? minutesToTime(row.bet_minutes) : null;
    },

    /** Apostas do dia, já ordenadas por horário. */
    async getBetsOnDate(date) {
      const list = await rows(
        `SELECT b.user_id, u.name, b.bet_minutes
           FROM bets b JOIN users u ON u.id = b.user_id
          WHERE b.bet_date = ?
          ORDER BY b.bet_minutes ASC, u.name COLLATE NOCASE ASC`,
        [date],
      );
      return list.map((row) => ({
        userId: row.user_id,
        name: row.name,
        minutes: row.bet_minutes,
        time: minutesToTime(row.bet_minutes),
      }));
    },

    async countBetsOnDate(date) {
      const row = await first(
        "SELECT COUNT(*) AS total FROM bets WHERE bet_date = ?",
        [date],
      );
      return Number(row.total);
    },

    /** Horário de chegada daquela data em minutos, ou null. */
    async getArrivalMinutes(date) {
      const row = await first(
        "SELECT arrival_minutes FROM results WHERE bet_date = ?",
        [date],
      );
      return row ? row.arrival_minutes : null;
    },

    async setArrival(date, time) {
      await run(
        `INSERT INTO results (bet_date, arrival_minutes) VALUES (?, ?)
         ON CONFLICT (bet_date) DO UPDATE
           SET arrival_minutes = excluded.arrival_minutes,
               updated_at = datetime('now')`,
        [date, timeToMinutes(time)],
      );
    },

    async getAllResults() {
      const list = await rows("SELECT bet_date, arrival_minutes FROM results");
      return list.map((row) => ({
        date: row.bet_date,
        minutes: row.arrival_minutes,
      }));
    },

    async getAllBets() {
      const list = await rows(
        `SELECT b.user_id, u.name, b.bet_date, b.bet_minutes
           FROM bets b JOIN users u ON u.id = b.user_id`,
      );
      return list.map((row) => ({
        userId: row.user_id,
        name: row.name,
        date: row.bet_date,
        minutes: row.bet_minutes,
      }));
    },

    async getAllUsers() {
      return rows("SELECT id, name FROM users ORDER BY name COLLATE NOCASE ASC");
    },

    /** Apaga tudo. Só o seed usa, para recriar o bolão de brincadeira. */
    async reset() {
      await ready();
      await client.batch([
        "DELETE FROM bets",
        "DELETE FROM results",
        "DELETE FROM users",
      ]);
    },

    close() {
      client.close();
    },
  };
}

module.exports = { createStore, configFromEnv };
