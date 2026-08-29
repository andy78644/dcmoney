import { ApplicationError } from "./errors";
import {
  defaultServiceDependencies,
  type ServiceDependencies,
} from "./shared";

interface SessionRow {
  id: string;
  guild_id: string;
  user_id: string;
  kind: string;
  state_json: string;
  created_at: string;
  expires_at: string;
}

export interface InteractionSession<T> {
  id: string;
  guildId: string;
  userId: string;
  kind: string;
  state: T;
  createdAt: string;
  expiresAt: string;
}

export class SessionService {
  readonly #db: D1Database;
  readonly #dependencies: ServiceDependencies;

  constructor(
    db: D1Database,
    dependencies: ServiceDependencies = defaultServiceDependencies,
  ) {
    this.#db = db;
    this.#dependencies = dependencies;
  }

  async create<T extends object>(input: {
    guildId: string;
    userId: string;
    kind: string;
    state: T;
    ttlMinutes?: number;
  }): Promise<InteractionSession<T>> {
    const id = this.#dependencies.generateId();
    const now = this.#dependencies.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + (input.ttlMinutes ?? 15) * 60_000,
    ).toISOString();
    // Expired rows are only ever rejected on read, so without this they would
    // accumulate for the lifetime of the database. Cleaning up here keeps it
    // bounded without needing a scheduled job.
    await this.#db
      .prepare(`DELETE FROM interaction_sessions WHERE expires_at <= ?`)
      .bind(createdAt)
      .run();
    await this.#db
      .prepare(
        `INSERT INTO interaction_sessions
          (id, guild_id, user_id, kind, state_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.guildId,
        input.userId,
        input.kind,
        JSON.stringify(input.state),
        createdAt,
        expiresAt,
      )
      .run();
    return {
      id,
      guildId: input.guildId,
      userId: input.userId,
      kind: input.kind,
      state: input.state,
      createdAt,
      expiresAt,
    };
  }

  async require<T>(input: {
    id: string;
    guildId: string;
    userId: string;
    kind: string;
  }): Promise<InteractionSession<T>> {
    const row = await this.#db
      .prepare(
        `SELECT * FROM interaction_sessions
          WHERE id = ? AND guild_id = ? AND user_id = ? AND kind = ?`,
      )
      .bind(input.id, input.guildId, input.userId, input.kind)
      .first<SessionRow>();
    if (row === null || row.expires_at <= this.#dependencies.now().toISOString()) {
      if (row !== null) {
        await this.delete(row.id);
      }
      throw new ApplicationError(
        "NOT_FOUND",
        "This interaction has expired. Start the command again.",
      );
    }
    return {
      id: row.id,
      guildId: row.guild_id,
      userId: row.user_id,
      kind: row.kind,
      state: JSON.parse(row.state_json) as T,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async update<T>(id: string, state: T): Promise<void> {
    const result = await this.#db
      .prepare(
        `UPDATE interaction_sessions SET state_json = ? WHERE id = ?`,
      )
      .bind(JSON.stringify(state), id)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new ApplicationError("NOT_FOUND", "Interaction session was not found.");
    }
  }

  async delete(id: string): Promise<void> {
    await this.#db
      .prepare(`DELETE FROM interaction_sessions WHERE id = ?`)
      .bind(id)
      .run();
  }
}
