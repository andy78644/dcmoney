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
  is_public: number;
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
  isPublic: boolean;
}

export interface CreateLedgerInput {
  interactionId: string;
  guildId: string;
  actorUserId: string;
  name: string;
  currencyCode: string;
  currencyScale: number;
  displayName?: string | undefined;
  isPublic?: boolean | undefined;
}

export interface LedgerMember {
  userId: string;
  displayName: string | null;
  isManager: boolean;
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
    isPublic: row.is_public === 1,
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
               owner_user_id, created_at, is_public)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.guildId,
            name,
            currencyCode,
            input.currencyScale,
            input.actorUserId,
            createdAt,
            input.isPublic === true ? 1 : 0,
          ),
        this.#db
          .prepare(
            `INSERT INTO ledger_members
              (ledger_id, user_id, added_by, created_at, display_name,
               is_manager)
             VALUES (?, ?, ?, ?, ?, 1)`,
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
      isPublic: input.isPublic === true,
    };
  }

  async listForMember(
    guildId: string,
    userId: string,
    options: { archived?: "exclude" | "only" | "include" } = {},
  ): Promise<Ledger[]> {
    const archived = options.archived ?? "exclude";
    const clause =
      archived === "exclude"
        ? "AND l.archived_at IS NULL"
        : archived === "only"
          ? "AND l.archived_at IS NOT NULL"
          : "";
    const result = await this.#db
      .prepare(
        `SELECT l.*
           FROM ledgers l
           JOIN ledger_members m ON m.ledger_id = l.id
          WHERE l.guild_id = ?
            AND m.user_id = ?
            ${clause}
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
    options: { includeArchived?: boolean } = {},
  ): Promise<Ledger> {
    const row = await this.#db
      .prepare(
        `SELECT l.*
           FROM ledgers l
           JOIN ledger_members m ON m.ledger_id = l.id
          WHERE l.id = ?
            AND l.guild_id = ?
            AND m.user_id = ?
            ${options.includeArchived === true ? "" : "AND l.archived_at IS NULL"}`,
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

  /**
   * Admin actions need a manager, not specifically the creator: a ledger whose
   * creator left the Discord server would otherwise have nobody able to manage
   * it, with no way back.
   */
  async requireManager(
    ledgerId: string,
    guildId: string,
    userId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<Ledger> {
    const ledger = await this.requireMember(ledgerId, guildId, userId, options);
    if (ledger.ownerUserId === userId) {
      return ledger;
    }
    const row = await this.#db
      .prepare(
        `SELECT is_manager FROM ledger_members
          WHERE ledger_id = ? AND user_id = ?`,
      )
      .bind(ledgerId, userId)
      .first<{ is_manager: number }>();
    if (row?.is_manager !== 1) {
      throw new ApplicationError(
        "FORBIDDEN",
        "Only a ledger manager can perform this action.",
      );
    }
    return ledger;
  }

  /**
   * Adds several members in one round trip.
   *
   * Members already in the ledger are reported rather than treated as an
   * error: in a bulk add a duplicate is a no-op, and letting it abort would
   * discard everyone else in the same selection.
   */
  async addMembers(input: {
    interactionId: string;
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    members: ReadonlyArray<{ userId: string; displayName?: string | undefined }>;
  }): Promise<{ added: string[]; alreadyMembers: string[] }> {
    await this.requireManager(input.ledgerId, input.guildId, input.actorUserId);
    for (const { userId } of input.members) {
      assertDiscordId(userId, "Member user ID");
    }

    const existing = new Set(await this.listMemberIds(input.ledgerId));
    const seen = new Set<string>();
    const added: typeof input.members[number][] = [];
    const alreadyMembers: string[] = [];
    for (const member of input.members) {
      if (seen.has(member.userId)) {
        continue;
      }
      seen.add(member.userId);
      if (existing.has(member.userId)) {
        alreadyMembers.push(member.userId);
      } else {
        added.push(member);
      }
    }
    if (added.length === 0) {
      return { added: [], alreadyMembers };
    }

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
        ...added.map(({ userId, displayName }) =>
          this.#db
            .prepare(
              `INSERT INTO ledger_members
                (ledger_id, user_id, added_by, created_at, display_name)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              input.ledgerId,
              userId,
              input.actorUserId,
              createdAt,
              displayName ?? null,
            ),
        ),
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
    return { added: added.map(({ userId }) => userId), alreadyMembers };
  }

  /**
   * Archives or restores a ledger. Archived ledgers disappear from listings and
   * pickers but keep every record, so a finished trip stops cluttering the menu
   * without destroying its history.
   */
  async setArchived(input: {
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    archived: boolean;
  }): Promise<Ledger> {
    const ledger = await this.requireManager(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
      { includeArchived: true },
    );
    const archivedAt = input.archived
      ? this.#dependencies.now().toISOString()
      : null;
    await this.#db
      .prepare(`UPDATE ledgers SET archived_at = ? WHERE id = ?`)
      .bind(archivedAt, input.ledgerId)
      .run();
    return { ...ledger, archivedAt };
  }

  /** Hands the creator role to another member, who becomes a manager too. */
  async transferOwnership(input: {
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    newOwnerUserId: string;
  }): Promise<Ledger> {
    const ledger = await this.requireManager(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
      { includeArchived: true },
    );
    const members = await this.listMemberIds(input.ledgerId);
    if (!members.includes(input.newOwnerUserId)) {
      throw new ApplicationError(
        "MEMBER_NOT_FOUND",
        "The new owner must already be a ledger member.",
        { userIds: [input.newOwnerUserId] },
      );
    }
    await this.#db.batch([
      this.#db
        .prepare(`UPDATE ledgers SET owner_user_id = ? WHERE id = ?`)
        .bind(input.newOwnerUserId, input.ledgerId),
      this.#db
        .prepare(
          `UPDATE ledger_members SET is_manager = 1
            WHERE ledger_id = ? AND user_id = ?`,
        )
        .bind(input.ledgerId, input.newOwnerUserId),
    ]);
    return { ...ledger, ownerUserId: input.newOwnerUserId };
  }

  async setManager(input: {
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    memberUserId: string;
    isManager: boolean;
  }): Promise<Ledger> {
    const ledger = await this.requireManager(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
      { includeArchived: true },
    );
    if (!input.isManager && ledger.ownerUserId === input.memberUserId) {
      throw new ApplicationError(
        "OWNER_CANNOT_BE_REMOVED",
        "The ledger creator is always a manager.",
      );
    }
    const members = await this.listMembers(input.ledgerId);
    if (!members.some(({ userId }) => userId === input.memberUserId)) {
      throw new ApplicationError(
        "MEMBER_NOT_FOUND",
        "This user is not a ledger member.",
        { userIds: [input.memberUserId] },
      );
    }
    // Never leave a ledger with nobody able to administer it.
    if (
      !input.isManager &&
      members.filter(({ isManager }) => isManager).length <= 1
    ) {
      throw new ApplicationError(
        "LAST_MANAGER",
        "A ledger must keep at least one manager.",
      );
    }
    await this.#db
      .prepare(
        `UPDATE ledger_members SET is_manager = ?
          WHERE ledger_id = ? AND user_id = ?`,
      )
      .bind(input.isManager ? 1 : 0, input.ledgerId, input.memberUserId)
      .run();
    return ledger;
  }

  async setPublic(input: {
    ledgerId: string;
    guildId: string;
    actorUserId: string;
    isPublic: boolean;
  }): Promise<Ledger> {
    const ledger = await this.requireManager(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    await this.#db
      .prepare(`UPDATE ledgers SET is_public = ? WHERE id = ?`)
      .bind(input.isPublic ? 1 : 0, input.ledgerId)
      .run();
    return { ...ledger, isPublic: input.isPublic };
  }

  async listMembers(ledgerId: string): Promise<LedgerMember[]> {
    const result = await this.#db
      .prepare(
        `SELECT user_id, display_name, is_manager
           FROM ledger_members
          WHERE ledger_id = ?
          ORDER BY created_at, user_id`,
      )
      .bind(ledgerId)
      .all<{
        user_id: string;
        display_name: string | null;
        is_manager: number;
      }>();
    return result.results.map(({ user_id, display_name, is_manager }) => ({
      userId: user_id,
      displayName: display_name,
      isManager: is_manager === 1,
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
    await this.requireManager(input.ledgerId, input.guildId, input.actorUserId);
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
    const ledger = await this.requireManager(
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
