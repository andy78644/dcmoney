import { assertCurrencyScale } from "../domain/money";
import {
  ApplicationError,
  isUniqueConstraintError,
} from "./errors";
import {
  assertDiscordId,
  defaultServiceDependencies,
  type ServiceDependencies,
} from "./shared";

interface LedgerRow {
  id: string;
  guild_id: string;
  name: string;
  currency_code: string;
  currency_scale: number;
  owner_user_id: string;
  balance_revision: number;
  created_at: string;
  archived_at: string | null;
}

export interface Ledger {
  id: string;
  guildId: string;
  name: string;
  currencyCode: string;
  currencyScale: number;
  ownerUserId: string;
  balanceRevision: number;
  createdAt: string;
  archivedAt: string | null;
}

export interface CreateLedgerInput {
  interactionId: string;
  guildId: string;
  actorUserId: string;
  name: string;
  currencyCode: string;
  currencyScale: number;
  displayName?: string | undefined;
}

export interface LedgerMember {
  userId: string;
  displayName: string | null;
}

/** Discord 選單／autocomplete 的標籤上限是 100 字元。 */
export function memberLabel(member: LedgerMember): string {
  return (member.displayName ?? member.userId).slice(0, 100);
}

function mapLedger(row: LedgerRow): Ledger {
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    currencyCode: row.currency_code,
    currencyScale: row.currency_scale,
    ownerUserId: row.owner_user_id,
    balanceRevision: row.balance_revision,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export class LedgerService {
  readonly #db: D1Database;
  readonly #dependencies: ServiceDependencies;

  constructor(
    db: D1Database,
    dependencies: ServiceDependencies = defaultServiceDependencies,
  ) {
    this.#db = db;
    this.#dependencies = dependencies;
  }

  async create(input: CreateLedgerInput): Promise<Ledger> {
    assertDiscordId(input.guildId, "Guild ID");
    assertDiscordId(input.actorUserId, "Actor user ID");
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) {
      throw new ApplicationError(
        "INVALID_INPUT",
        "Ledger name must contain between 1 and 80 characters.",
      );
    }

    const currencyCode = input.currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new ApplicationError(
        "INVALID_INPUT",
        "Currency must be a three-letter ISO code.",
      );
    }
    assertCurrencyScale(input.currencyScale);

    const id = this.#dependencies.generateId();
    const createdAt = this.#dependencies.now().toISOString();

    try {
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO interaction_receipts
              (interaction_id, operation, created_at)
             VALUES (?, 'ledger.create', ?)`,
          )
          .bind(input.interactionId, createdAt),
        this.#db
          .prepare(
            `INSERT INTO ledgers
              (id, guild_id, name, currency_code, currency_scale,
               owner_user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.guildId,
            name,
            currencyCode,
            input.currencyScale,
            input.actorUserId,
            createdAt,
          ),
        this.#db
          .prepare(
            `INSERT INTO ledger_members
              (ledger_id, user_id, added_by, created_at, display_name)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.actorUserId,
            input.actorUserId,
            createdAt,
            input.displayName ?? null,
          ),
      ]);
    } catch (error) {
      if (await this.#hasReceipt(input.interactionId)) {
        throw new ApplicationError(
          "DUPLICATE_INTERACTION",
          "This interaction has already been processed.",
        );
      }
      if (isUniqueConstraintError(error)) {
        throw new ApplicationError(
          "LEDGER_NAME_TAKEN",
          "An active ledger with this name already exists in the server.",
        );
      }
      throw error;
    }

    return {
      id,
      guildId: input.guildId,
      name,
      currencyCode,
      currencyScale: input.currencyScale,
      ownerUserId: input.actorUserId,
      balanceRevision: 0,
      createdAt,
      archivedAt: null,
    };
  }

  async listForMember(guildId: string, userId: string): Promise<Ledger[]> {
    const result = await this.#db
      .prepare(
        `SELECT l.*
           FROM ledgers l
           JOIN ledger_members m ON m.ledger_id = l.id
          WHERE l.guild_id = ?
            AND m.user_id = ?
            AND l.archived_at IS NULL
          ORDER BY l.name COLLATE NOCASE, l.id`,
      )
      .bind(guildId, userId)
      .all<LedgerRow>();

    return result.results.map(mapLedger);
  }

  async requireMember(
    ledgerId: string,
    guildId: string,
    userId: string,
  ): Promise<Ledger> {
    const row = await this.#db
      .prepare(
        `SELECT l.*
           FROM ledgers l
           JOIN ledger_members m ON m.ledger_id = l.id
          WHERE l.id = ?
            AND l.guild_id = ?
            AND m.user_id = ?
            AND l.archived_at IS NULL`,
      )
      .bind(ledgerId, guildId, userId)
      .first<LedgerRow>();

    if (row === null) {
      throw new ApplicationError(
        "FORBIDDEN",
        "You do not have access to this ledger.",
      );
    }
    return mapLedger(row);
  }

  async requireOwner(
    ledgerId: string,
    guildId: string,
    userId: string,
  ): Promise<Ledger> {
    const ledger = await this.requireMember(ledgerId, guildId, userId);
    if (ledger.ownerUserId !== userId) {
      throw new ApplicationError(
        "FORBIDDEN",
        "Only the ledger owner can manage members.",
      );
    }
    return ledger;
  }

  async listMembers(ledgerId: string): Promise<LedgerMember[]> {
    const result = await this.#db
      .prepare(
        `SELECT user_id, display_name
           FROM ledger_members
          WHERE ledger_id = ?
          ORDER BY created_at, user_id`,
      )
      .bind(ledgerId)
      .all<{ user_id: string; display_name: string | null }>();
    return result.results.map(({ user_id, display_name }) => ({
      userId: user_id,
      displayName: display_name,
    }));
  }

  async listMemberIds(ledgerId: string): Promise<string[]> {
    const result = await this.#db
      .prepare(
        `SELECT user_id
           FROM ledger_members
          WHERE ledger_id = ?
          ORDER BY created_at, user_id`,
      )
      .bind(ledgerId)
      .all<{ user_id: string }>();
    return result.results.map(({ user_id }) => user_id);
  }

  async addMember(input: {
    interactionId: string;
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    memberUserId: string;
    displayName?: string | undefined;
  }): Promise<void> {
    await this.requireOwner(input.ledgerId, input.guildId, input.actorUserId);
    assertDiscordId(input.memberUserId, "Member user ID");
    const createdAt = this.#dependencies.now().toISOString();

    try {
      await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO interaction_receipts
              (interaction_id, operation, created_at)
             VALUES (?, 'ledger.member.add', ?)`,
          )
          .bind(input.interactionId, createdAt),
        this.#db
          .prepare(
            `INSERT INTO ledger_members
              (ledger_id, user_id, added_by, created_at, display_name)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            input.ledgerId,
            input.memberUserId,
            input.actorUserId,
            createdAt,
            input.displayName ?? null,
          ),
      ]);
    } catch (error) {
      if (await this.#hasReceipt(input.interactionId)) {
        throw new ApplicationError(
          "DUPLICATE_INTERACTION",
          "This interaction has already been processed.",
        );
      }
      if (isUniqueConstraintError(error)) {
        throw new ApplicationError(
          "MEMBER_ALREADY_EXISTS",
          "This user is already a ledger member.",
        );
      }
      throw error;
    }
  }

  async removeMember(input: {
    interactionId: string;
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    memberUserId: string;
  }): Promise<void> {
    const ledger = await this.requireOwner(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    if (ledger.ownerUserId === input.memberUserId) {
      throw new ApplicationError(
        "OWNER_CANNOT_BE_REMOVED",
        "The ledger owner cannot be removed.",
      );
    }

    const createdAt = this.#dependencies.now().toISOString();
    let results: D1Result[];
    try {
      results = await this.#db.batch([
        this.#db
          .prepare(
            `INSERT INTO interaction_receipts
              (interaction_id, operation, created_at)
             VALUES (?, 'ledger.member.remove', ?)`,
          )
          .bind(input.interactionId, createdAt),
        this.#db
          .prepare(
            `DELETE FROM ledger_members
              WHERE ledger_id = ? AND user_id = ?`,
          )
          .bind(input.ledgerId, input.memberUserId),
      ]);
    } catch (error) {
      if (await this.#hasReceipt(input.interactionId)) {
        throw new ApplicationError(
          "DUPLICATE_INTERACTION",
          "This interaction has already been processed.",
        );
      }
      throw error;
    }

    if ((results[1]?.meta.changes ?? 0) === 0) {
      throw new ApplicationError(
        "MEMBER_NOT_FOUND",
        "This user is not a ledger member.",
      );
    }
  }

  async #hasReceipt(interactionId: string): Promise<boolean> {
    const row = await this.#db
      .prepare(
        `SELECT interaction_id
           FROM interaction_receipts
          WHERE interaction_id = ?`,
      )
      .bind(interactionId)
      .first<{ interaction_id: string }>();
    return row !== null;
  }
}
