import {
  buildExpensePostings,
  buildSettlementPostings,
  simplifyDebts,
  type Balance,
  type Share,
  type SettlementSuggestion,
  validateCustomShares,
} from "../domain/accounting";
import { assertPositiveMinorAmount } from "../domain/money";
import { ApplicationError } from "./errors";
import { type Ledger, LedgerService } from "./ledger-service";
import {
  assertCalendarDate,
  defaultServiceDependencies,
  normalizeDescription,
  type ServiceDependencies,
} from "./shared";

interface TransactionRow {
  id: string;
  ledger_id: string;
  type: "expense" | "settlement";
  description: string;
  total_amount_minor: number;
  occurred_on: string;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  revision: number;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface ExpenseDetailRow {
  payer_user_id: string;
}

interface ExpenseShareRow {
  user_id: string;
  amount_minor: number;
}

interface SettlementDetailRow {
  payer_user_id: string;
  receiver_user_id: string;
}

interface TransactionBase {
  id: string;
  ledgerId: string;
  description: string;
  totalAmountMinor: number;
  occurredOn: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
}

export interface ExpenseTransaction extends TransactionBase {
  type: "expense";
  payerUserId: string;
  shares: Share[];
}

export interface SettlementTransaction extends TransactionBase {
  type: "settlement";
  payerUserId: string;
  receiverUserId: string;
}

export type LedgerTransaction = ExpenseTransaction | SettlementTransaction;

export interface TransactionAccess {
  ledgerId: string;
  guildId: string;
  actorUserId: string;
}

export interface CreateExpenseInput extends TransactionAccess {
  interactionId: string;
  payerUserId: string;
  totalAmountMinor: number;
  shares: Share[];
  description?: string;
  occurredOn: string;
}

export interface CreateSettlementInput extends TransactionAccess {
  interactionId: string;
  payerUserId: string;
  receiverUserId: string;
  amountMinor: number;
  description?: string;
  occurredOn: string;
}

export interface ListTransactionsInput extends TransactionAccess {
  memberUserId?: string;
  startDate?: string;
  endDate?: string;
  type?: "expense" | "settlement";
  limit?: number;
  offset?: number;
}

function mapTransactionBase(row: TransactionRow): TransactionBase {
  return {
    id: row.id,
    ledgerId: row.ledger_id,
    description: row.description,
    totalAmountMinor: row.total_amount_minor,
    occurredOn: row.occurred_on,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export class TransactionService {
  readonly #db: D1Database;
  readonly #ledgers: LedgerService;
  readonly #dependencies: ServiceDependencies;

  constructor(
    db: D1Database,
    dependencies: ServiceDependencies = defaultServiceDependencies,
  ) {
    this.#db = db;
    this.#dependencies = dependencies;
    this.#ledgers = new LedgerService(db, dependencies);
  }

  async createExpense(input: CreateExpenseInput): Promise<ExpenseTransaction> {
    const ledger = await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    assertCalendarDate(input.occurredOn);
    const description = normalizeDescription(input.description);
    const shares = validateCustomShares(input.totalAmountMinor, input.shares);
    await this.#requireTransactionMembers(ledger, [
      input.payerUserId,
      ...shares.map(({ userId }) => userId),
    ]);
    const postings = buildExpensePostings(
      input.payerUserId,
      input.totalAmountMinor,
      shares,
    );
    const id = this.#dependencies.generateId();
    const auditId = this.#dependencies.generateId();
    const createdAt = this.#dependencies.now().toISOString();
    const transaction: ExpenseTransaction = {
      id,
      ledgerId: input.ledgerId,
      type: "expense",
      description,
      totalAmountMinor: input.totalAmountMinor,
      occurredOn: input.occurredOn,
      createdBy: input.actorUserId,
      createdAt,
      updatedBy: input.actorUserId,
      updatedAt: createdAt,
      revision: 1,
      payerUserId: input.payerUserId,
      shares,
    };

    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "expense.create", createdAt),
      this.#db
        .prepare(
          `INSERT INTO transactions
            (id, ledger_id, type, description, total_amount_minor, occurred_on,
             created_by, created_at, updated_by, updated_at, revision,
             last_operation_id)
           VALUES (?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          id,
          input.ledgerId,
          description,
          input.totalAmountMinor,
          input.occurredOn,
          input.actorUserId,
          createdAt,
          input.actorUserId,
          createdAt,
          input.interactionId,
        ),
      this.#db
        .prepare(
          `INSERT INTO expense_details (transaction_id, payer_user_id)
           VALUES (?, ?)`,
        )
        .bind(id, input.payerUserId),
      ...shares.map(({ userId, amountMinor }, position) =>
        this.#db
          .prepare(
            `INSERT INTO expense_shares
              (transaction_id, user_id, amount_minor, position)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(id, userId, amountMinor, position),
      ),
      ...postings.map(({ userId, amountMinor }) =>
        this.#db
          .prepare(
            `INSERT INTO postings (transaction_id, user_id, amount_minor)
             VALUES (?, ?, ?)`,
          )
          .bind(id, userId, amountMinor),
      ),
      this.#db
        .prepare(
          `INSERT INTO transaction_audits
            (id, transaction_id, action, actor_user_id, before_snapshot,
             after_snapshot, created_at)
           VALUES (?, ?, 'create', ?, NULL, ?, ?)`,
        )
        .bind(
          auditId,
          id,
          input.actorUserId,
          JSON.stringify(transaction),
          createdAt,
        ),
    ];

    await this.#runCreateBatch(statements, input.interactionId);
    return transaction;
  }

  async createSettlement(
    input: CreateSettlementInput,
  ): Promise<SettlementTransaction> {
    const ledger = await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    assertCalendarDate(input.occurredOn);
    assertPositiveMinorAmount(input.amountMinor);
    const description = normalizeDescription(input.description);
    await this.#requireTransactionMembers(ledger, [
      input.payerUserId,
      input.receiverUserId,
    ]);

    const suggestions = await this.#loadSuggestions(input.ledgerId);
    const current = suggestions.find(
      ({ debtorUserId, creditorUserId }) =>
        debtorUserId === input.payerUserId &&
        creditorUserId === input.receiverUserId,
    );
    if (current === undefined || input.amountMinor > current.amountMinor) {
      throw new ApplicationError(
        "SETTLEMENT_EXCEEDS_BALANCE",
        "Settlement must match a current suggestion and cannot exceed it.",
      );
    }

    const postings = buildSettlementPostings(
      input.payerUserId,
      input.receiverUserId,
      input.amountMinor,
    );
    const id = this.#dependencies.generateId();
    const auditId = this.#dependencies.generateId();
    const createdAt = this.#dependencies.now().toISOString();
    const transaction: SettlementTransaction = {
      id,
      ledgerId: input.ledgerId,
      type: "settlement",
      description,
      totalAmountMinor: input.amountMinor,
      occurredOn: input.occurredOn,
      createdBy: input.actorUserId,
      createdAt,
      updatedBy: input.actorUserId,
      updatedAt: createdAt,
      revision: 1,
      payerUserId: input.payerUserId,
      receiverUserId: input.receiverUserId,
    };

    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "settlement.create", createdAt),
      this.#db
        .prepare(
          `INSERT INTO transactions
            (id, ledger_id, type, description, total_amount_minor, occurred_on,
             created_by, created_at, updated_by, updated_at, revision,
             last_operation_id)
           VALUES (?, ?, 'settlement', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          id,
          input.ledgerId,
          description,
          input.amountMinor,
          input.occurredOn,
          input.actorUserId,
          createdAt,
          input.actorUserId,
          createdAt,
          input.interactionId,
        ),
      this.#db
        .prepare(
          `INSERT INTO settlement_details
            (transaction_id, payer_user_id, receiver_user_id)
           VALUES (?, ?, ?)`,
        )
        .bind(id, input.payerUserId, input.receiverUserId),
      ...postings.map(({ userId, amountMinor }) =>
        this.#db
          .prepare(
            `INSERT INTO postings (transaction_id, user_id, amount_minor)
             VALUES (?, ?, ?)`,
          )
          .bind(id, userId, amountMinor),
      ),
      this.#db
        .prepare(
          `INSERT INTO transaction_audits
            (id, transaction_id, action, actor_user_id, before_snapshot,
             after_snapshot, created_at)
           VALUES (?, ?, 'create', ?, NULL, ?, ?)`,
        )
        .bind(
          auditId,
          id,
          input.actorUserId,
          JSON.stringify(transaction),
          createdAt,
        ),
    ];

    await this.#runCreateBatch(statements, input.interactionId);
    return transaction;
  }

  async list(input: ListTransactionsInput): Promise<LedgerTransaction[]> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    if (input.startDate !== undefined) {
      assertCalendarDate(input.startDate);
    }
    if (input.endDate !== undefined) {
      assertCalendarDate(input.endDate);
    }
    if (
      input.startDate !== undefined &&
      input.endDate !== undefined &&
      input.startDate > input.endDate
    ) {
      throw new ApplicationError(
        "INVALID_DATE",
        "Start date cannot be later than end date.",
      );
    }

    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      throw new ApplicationError(
        "INVALID_INPUT",
        "Pagination is outside the supported range.",
      );
    }

    const clauses = ["t.ledger_id = ?", "t.deleted_at IS NULL"];
    const bindings: (string | number)[] = [input.ledgerId];
    if (input.startDate !== undefined) {
      clauses.push("t.occurred_on >= ?");
      bindings.push(input.startDate);
    }
    if (input.endDate !== undefined) {
      clauses.push("t.occurred_on <= ?");
      bindings.push(input.endDate);
    }
    if (input.type !== undefined) {
      clauses.push("t.type = ?");
      bindings.push(input.type);
    }
    if (input.memberUserId !== undefined) {
      clauses.push(`(
        EXISTS (
          SELECT 1 FROM expense_details ed
           WHERE ed.transaction_id = t.id AND ed.payer_user_id = ?
        ) OR EXISTS (
          SELECT 1 FROM expense_shares es
           WHERE es.transaction_id = t.id AND es.user_id = ?
        ) OR EXISTS (
          SELECT 1 FROM settlement_details sd
           WHERE sd.transaction_id = t.id
             AND (sd.payer_user_id = ? OR sd.receiver_user_id = ?)
        )
      )`);
      bindings.push(
        input.memberUserId,
        input.memberUserId,
        input.memberUserId,
        input.memberUserId,
      );
    }
    bindings.push(limit, offset);

    const result = await this.#db
      .prepare(
        `SELECT t.*
           FROM transactions t
          WHERE ${clauses.join(" AND ")}
          ORDER BY t.occurred_on DESC, t.created_at DESC, t.id DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(...bindings)
      .all<TransactionRow>();

    return Promise.all(result.results.map((row) => this.#hydrate(row)));
  }

  async getSuggestions(input: TransactionAccess & {
    asOf?: string;
    memberUserId?: string;
  }): Promise<SettlementSuggestion[]> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    if (input.asOf !== undefined) {
      assertCalendarDate(input.asOf);
    }

    const suggestions = await this.#loadSuggestions(input.ledgerId, input.asOf);
    if (input.memberUserId === undefined) {
      return suggestions;
    }
    return suggestions.filter(
      ({ debtorUserId, creditorUserId }) =>
        debtorUserId === input.memberUserId ||
        creditorUserId === input.memberUserId,
    );
  }

  async updateExpense(
    input: CreateExpenseInput & { transactionId: string; expectedRevision: number },
  ): Promise<ExpenseTransaction> {
    const ledger = await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const current = await this.#requireTransaction(
      input.transactionId,
      input.ledgerId,
    );
    if (current.type !== "expense") {
      throw new ApplicationError("INVALID_INPUT", "Transaction is not an expense.");
    }

    assertCalendarDate(input.occurredOn);
    const description = normalizeDescription(input.description);
    const shares = validateCustomShares(input.totalAmountMinor, input.shares);
    await this.#requireTransactionMembers(ledger, [
      input.payerUserId,
      ...shares.map(({ userId }) => userId),
    ]);
    const postings = buildExpensePostings(
      input.payerUserId,
      input.totalAmountMinor,
      shares,
    );
    const updatedAt = this.#dependencies.now().toISOString();
    const updated: ExpenseTransaction = {
      ...current,
      description,
      totalAmountMinor: input.totalAmountMinor,
      occurredOn: input.occurredOn,
      updatedBy: input.actorUserId,
      updatedAt,
      revision: input.expectedRevision + 1,
      payerUserId: input.payerUserId,
      shares,
    };
    const operationGuard = `EXISTS (
      SELECT 1 FROM transactions
       WHERE id = ? AND last_operation_id = ?
    )`;
    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "expense.update", updatedAt),
      this.#db
        .prepare(
          `UPDATE transactions
              SET description = ?, total_amount_minor = ?, occurred_on = ?,
                  updated_by = ?, updated_at = ?, revision = revision + 1,
                  last_operation_id = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL`,
        )
        .bind(
          description,
          input.totalAmountMinor,
          input.occurredOn,
          input.actorUserId,
          updatedAt,
          input.interactionId,
          input.transactionId,
          input.ledgerId,
          input.expectedRevision,
        ),
      this.#db
        .prepare(
          `UPDATE expense_details SET payer_user_id = ?
            WHERE transaction_id = ? AND ${operationGuard}`,
        )
        .bind(
          input.payerUserId,
          input.transactionId,
          input.transactionId,
          input.interactionId,
        ),
      this.#db
        .prepare(
          `DELETE FROM expense_shares
            WHERE transaction_id = ? AND ${operationGuard}`,
        )
        .bind(input.transactionId, input.transactionId, input.interactionId),
      ...shares.map(({ userId, amountMinor }, position) =>
        this.#db
          .prepare(
            `INSERT INTO expense_shares
              (transaction_id, user_id, amount_minor, position)
             SELECT ?, ?, ?, ? WHERE ${operationGuard}`,
          )
          .bind(
            input.transactionId,
            userId,
            amountMinor,
            position,
            input.transactionId,
            input.interactionId,
          ),
      ),
      this.#db
        .prepare(
          `DELETE FROM postings
            WHERE transaction_id = ? AND ${operationGuard}`,
        )
        .bind(input.transactionId, input.transactionId, input.interactionId),
      ...postings.map(({ userId, amountMinor }) =>
        this.#db
          .prepare(
            `INSERT INTO postings (transaction_id, user_id, amount_minor)
             SELECT ?, ?, ? WHERE ${operationGuard}`,
          )
          .bind(
            input.transactionId,
            userId,
            amountMinor,
            input.transactionId,
            input.interactionId,
          ),
      ),
      this.#db
        .prepare(
          `INSERT INTO transaction_audits
            (id, transaction_id, action, actor_user_id, before_snapshot,
             after_snapshot, created_at)
           SELECT ?, ?, 'update', ?, ?, ?, ? WHERE ${operationGuard}`,
        )
        .bind(
          this.#dependencies.generateId(),
          input.transactionId,
          input.actorUserId,
          JSON.stringify(current),
          JSON.stringify(updated),
          updatedAt,
          input.transactionId,
          input.interactionId,
        ),
    ];

    const results = await this.#runBatch(statements, input.interactionId);
    if ((results[1]?.meta.changes ?? 0) === 0) {
      throw new ApplicationError(
        "CONFLICT",
        "The transaction was changed by someone else. Reload and try again.",
      );
    }
    return updated;
  }

  async updateSettlement(
    input: CreateSettlementInput & {
      transactionId: string;
      expectedRevision: number;
    },
  ): Promise<SettlementTransaction> {
    const ledger = await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const current = await this.#requireTransaction(
      input.transactionId,
      input.ledgerId,
    );
    if (current.type !== "settlement") {
      throw new ApplicationError(
        "INVALID_INPUT",
        "Transaction is not a settlement.",
      );
    }

    assertCalendarDate(input.occurredOn);
    assertPositiveMinorAmount(input.amountMinor);
    const description = normalizeDescription(input.description);
    await this.#requireTransactionMembers(ledger, [
      input.payerUserId,
      input.receiverUserId,
    ]);
    const suggestions = await this.#loadSuggestions(
      input.ledgerId,
      undefined,
      input.transactionId,
    );
    const available = suggestions.find(
      ({ debtorUserId, creditorUserId }) =>
        debtorUserId === input.payerUserId &&
        creditorUserId === input.receiverUserId,
    );
    if (available === undefined || input.amountMinor > available.amountMinor) {
      throw new ApplicationError(
        "SETTLEMENT_EXCEEDS_BALANCE",
        "Settlement must match a current suggestion and cannot exceed it.",
      );
    }

    const postings = buildSettlementPostings(
      input.payerUserId,
      input.receiverUserId,
      input.amountMinor,
    );
    const updatedAt = this.#dependencies.now().toISOString();
    const updated: SettlementTransaction = {
      ...current,
      description,
      totalAmountMinor: input.amountMinor,
      occurredOn: input.occurredOn,
      updatedBy: input.actorUserId,
      updatedAt,
      revision: input.expectedRevision + 1,
      payerUserId: input.payerUserId,
      receiverUserId: input.receiverUserId,
    };
    const operationGuard = `EXISTS (
      SELECT 1 FROM transactions
       WHERE id = ? AND last_operation_id = ?
    )`;
    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "settlement.update", updatedAt),
      this.#db
        .prepare(
          `UPDATE transactions
              SET description = ?, total_amount_minor = ?, occurred_on = ?,
                  updated_by = ?, updated_at = ?, revision = revision + 1,
                  last_operation_id = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL`,
        )
        .bind(
          description,
          input.amountMinor,
          input.occurredOn,
          input.actorUserId,
          updatedAt,
          input.interactionId,
          input.transactionId,
          input.ledgerId,
          input.expectedRevision,
        ),
      this.#db
        .prepare(
          `UPDATE settlement_details
              SET payer_user_id = ?, receiver_user_id = ?
            WHERE transaction_id = ? AND ${operationGuard}`,
        )
        .bind(
          input.payerUserId,
          input.receiverUserId,
          input.transactionId,
          input.transactionId,
          input.interactionId,
        ),
      this.#db
        .prepare(
          `DELETE FROM postings
            WHERE transaction_id = ? AND ${operationGuard}`,
        )
        .bind(input.transactionId, input.transactionId, input.interactionId),
      ...postings.map(({ userId, amountMinor }) =>
        this.#db
          .prepare(
            `INSERT INTO postings (transaction_id, user_id, amount_minor)
             SELECT ?, ?, ? WHERE ${operationGuard}`,
          )
          .bind(
            input.transactionId,
            userId,
            amountMinor,
            input.transactionId,
            input.interactionId,
          ),
      ),
      this.#db
        .prepare(
          `INSERT INTO transaction_audits
            (id, transaction_id, action, actor_user_id, before_snapshot,
             after_snapshot, created_at)
           SELECT ?, ?, 'update', ?, ?, ?, ? WHERE ${operationGuard}`,
        )
        .bind(
          this.#dependencies.generateId(),
          input.transactionId,
          input.actorUserId,
          JSON.stringify(current),
          JSON.stringify(updated),
          updatedAt,
          input.transactionId,
          input.interactionId,
        ),
    ];

    const results = await this.#runBatch(statements, input.interactionId);
    if ((results[1]?.meta.changes ?? 0) === 0) {
      throw new ApplicationError(
        "CONFLICT",
        "The transaction was changed by someone else. Reload and try again.",
      );
    }
    return updated;
  }

  async delete(input: TransactionAccess & {
    interactionId: string;
    transactionId: string;
    expectedRevision: number;
  }): Promise<void> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const current = await this.#requireTransaction(
      input.transactionId,
      input.ledgerId,
    );
    const deletedAt = this.#dependencies.now().toISOString();
    const results = await this.#runBatch([
      this.#receiptStatement(input.interactionId, "transaction.delete", deletedAt),
      this.#db
        .prepare(
          `UPDATE transactions
              SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ?,
                  revision = revision + 1, last_operation_id = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL`,
        )
        .bind(
          deletedAt,
          input.actorUserId,
          deletedAt,
          input.actorUserId,
          input.interactionId,
          input.transactionId,
          input.ledgerId,
          input.expectedRevision,
        ),
      this.#db
        .prepare(
          `INSERT INTO transaction_audits
            (id, transaction_id, action, actor_user_id, before_snapshot,
             after_snapshot, created_at)
           SELECT ?, ?, 'delete', ?, ?, NULL, ?
            WHERE EXISTS (
              SELECT 1 FROM transactions
               WHERE id = ? AND last_operation_id = ?
            )`,
        )
        .bind(
          this.#dependencies.generateId(),
          input.transactionId,
          input.actorUserId,
          JSON.stringify(current),
          deletedAt,
          input.transactionId,
          input.interactionId,
        ),
    ], input.interactionId);

    if ((results[1]?.meta.changes ?? 0) === 0) {
      throw new ApplicationError(
        "CONFLICT",
        "The transaction was changed by someone else. Reload and try again.",
      );
    }
  }

  async #requireTransaction(
    transactionId: string,
    ledgerId: string,
  ): Promise<LedgerTransaction> {
    const row = await this.#db
      .prepare(
        `SELECT * FROM transactions
          WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL`,
      )
      .bind(transactionId, ledgerId)
      .first<TransactionRow>();
    if (row === null) {
      throw new ApplicationError("NOT_FOUND", "Transaction was not found.");
    }
    return this.#hydrate(row);
  }

  async #hydrate(row: TransactionRow): Promise<LedgerTransaction> {
    const base = mapTransactionBase(row);
    if (row.type === "expense") {
      const [detail, shares] = await Promise.all([
        this.#db
          .prepare(
            `SELECT payer_user_id FROM expense_details
              WHERE transaction_id = ?`,
          )
          .bind(row.id)
          .first<ExpenseDetailRow>(),
        this.#db
          .prepare(
            `SELECT user_id, amount_minor FROM expense_shares
              WHERE transaction_id = ? ORDER BY position`,
          )
          .bind(row.id)
          .all<ExpenseShareRow>(),
      ]);
      if (detail === null) {
        throw new Error(`Expense ${row.id} has no detail row.`);
      }
      return {
        ...base,
        type: "expense",
        payerUserId: detail.payer_user_id,
        shares: shares.results.map(({ user_id, amount_minor }) => ({
          userId: user_id,
          amountMinor: amount_minor,
        })),
      };
    }

    const detail = await this.#db
      .prepare(
        `SELECT payer_user_id, receiver_user_id FROM settlement_details
          WHERE transaction_id = ?`,
      )
      .bind(row.id)
      .first<SettlementDetailRow>();
    if (detail === null) {
      throw new Error(`Settlement ${row.id} has no detail row.`);
    }
    return {
      ...base,
      type: "settlement",
      payerUserId: detail.payer_user_id,
      receiverUserId: detail.receiver_user_id,
    };
  }

  async #loadSuggestions(
    ledgerId: string,
    asOf?: string,
    excludedTransactionId?: string,
  ): Promise<SettlementSuggestion[]> {
    const clauses = ["t.ledger_id = ?", "t.deleted_at IS NULL"];
    const bindings: string[] = [ledgerId];
    if (asOf !== undefined) {
      clauses.push("t.occurred_on <= ?");
      bindings.push(asOf);
    }
    if (excludedTransactionId !== undefined) {
      clauses.push("t.id <> ?");
      bindings.push(excludedTransactionId);
    }
    const statement = this.#db.prepare(
      `SELECT p.user_id, SUM(p.amount_minor) AS amount_minor
         FROM postings p
         JOIN transactions t ON t.id = p.transaction_id
        WHERE ${clauses.join(" AND ")}
        GROUP BY p.user_id
       HAVING SUM(p.amount_minor) <> 0`,
    );
    const result = await statement
      .bind(...bindings)
      .all<{ user_id: string; amount_minor: number }>();
    const balances: Balance[] = result.results.map(
      ({ user_id, amount_minor }) => ({
        userId: user_id,
        amountMinor: amount_minor,
      }),
    );
    return simplifyDebts(balances);
  }

  async #requireTransactionMembers(
    ledger: Ledger,
    userIds: readonly string[],
  ): Promise<void> {
    const members = new Set(await this.#ledgers.listMemberIds(ledger.id));
    const missing = [...new Set(userIds)].filter((userId) => !members.has(userId));
    if (missing.length > 0) {
      throw new ApplicationError(
        "FORBIDDEN",
        "Every payer, receiver and participant must belong to the ledger.",
      );
    }
  }

  #receiptStatement(
    interactionId: string,
    operation: string,
    createdAt: string,
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT INTO interaction_receipts
          (interaction_id, operation, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(interactionId, operation, createdAt);
  }

  async #runCreateBatch(
    statements: D1PreparedStatement[],
    interactionId: string,
  ): Promise<void> {
    await this.#runBatch(statements, interactionId);
  }

  async #runBatch(
    statements: D1PreparedStatement[],
    interactionId: string,
  ): Promise<D1Result[]> {
    try {
      return await this.#db.batch(statements);
    } catch (error) {
      const receipt = await this.#db
        .prepare(
          `SELECT interaction_id FROM interaction_receipts
            WHERE interaction_id = ?`,
        )
        .bind(interactionId)
        .first<{ interaction_id: string }>();
      if (receipt !== null) {
        throw new ApplicationError(
          "DUPLICATE_INTERACTION",
          "This interaction has already been processed.",
        );
      }
      throw error;
    }
  }
}
