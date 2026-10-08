import {
  buildExpensePostings,
  buildSettlementPostings,
  simplifyDebts,
  type Balance,
  type Share,
  type SettlementSuggestion,
  validateCustomShares,
} from "../domain/accounting";
import {
  assertPositiveMinorAmount,
  formatMinorAmount,
} from "../domain/money";
import { ApplicationError } from "./errors";
import { type Ledger, LedgerService } from "./ledger-service";
import {
  assertCalendarDate,
  defaultServiceDependencies,
  normalizeCategory,
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
  category: string | null;
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
  category: string | null;
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
  category?: string | undefined;
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
  category?: string;
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
      category: normalizeCategory(input.category),
    };

    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "expense.create", createdAt),
      this.#balanceRevisionStatement(ledger, input.interactionId),
      this.#db
        .prepare(
          `INSERT INTO transactions
            (id, ledger_id, type, description, total_amount_minor, occurred_on,
             created_by, created_at, updated_by, updated_at, revision,
             last_operation_id, category)
           SELECT ?, ?, 'expense', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM ledgers
               WHERE id = ? AND last_balance_operation_id = ?
            )`,
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
          normalizeCategory(input.category),
          input.ledgerId,
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

    await this.#runBalanceCreateBatch(
      statements,
      input.interactionId,
      ledger,
    );
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

    this.#assertSettlementWithinDebt(
      await this.#loadBalances(input.ledgerId),
      ledger,
      input.payerUserId,
      input.amountMinor,
    );

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
      this.#balanceRevisionStatement(ledger, input.interactionId),
      this.#db
        .prepare(
          `INSERT INTO transactions
            (id, ledger_id, type, description, total_amount_minor, occurred_on,
             created_by, created_at, updated_by, updated_at, revision,
             last_operation_id)
           SELECT ?, ?, 'settlement', ?, ?, ?, ?, ?, ?, ?, 1, ?
            WHERE EXISTS (
              SELECT 1 FROM ledgers
               WHERE id = ? AND last_balance_operation_id = ?
            )`,
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
          input.ledgerId,
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

    await this.#runBalanceCreateBatch(
      statements,
      input.interactionId,
      ledger,
    );
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
    if (input.category !== undefined) {
      clauses.push("t.category = ?");
      bindings.push(input.category);
    }
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

  async get(
    input: TransactionAccess & { transactionId: string },
  ): Promise<LedgerTransaction> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    return this.#requireTransaction(input.transactionId, input.ledgerId);
  }

  /**
   * Totals for a period: what the ledger spent, what each member paid out and
   * was allocated, and the split by category. `/balances` answers "who should
   * pay whom"; this answers "where did the money go".
   */
  async getSummary(
    input: TransactionAccess & { startDate?: string; endDate?: string },
  ): Promise<{
    totalSpentMinor: number;
    expenseCount: number;
    perMember: Array<{ userId: string; paidMinor: number; shareMinor: number }>;
    perCategory: Array<{ category: string | null; amountMinor: number }>;
  }> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const clauses = [
      "t.ledger_id = ?",
      "t.deleted_at IS NULL",
      "t.type = 'expense'",
    ];
    const bindings: string[] = [input.ledgerId];
    if (input.startDate !== undefined) {
      assertCalendarDate(input.startDate);
      clauses.push("t.occurred_on >= ?");
      bindings.push(input.startDate);
    }
    if (input.endDate !== undefined) {
      assertCalendarDate(input.endDate);
      clauses.push("t.occurred_on <= ?");
      bindings.push(input.endDate);
    }
    const where = clauses.join(" AND ");

    const [totals, paid, shares, categories] = await this.#db.batch([
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(t.total_amount_minor), 0) AS total
             FROM transactions t WHERE ${where}`,
        )
        .bind(...bindings),
      this.#db
        .prepare(
          `SELECT d.payer_user_id AS user_id,
                  SUM(t.total_amount_minor) AS amount
             FROM transactions t
             JOIN expense_details d ON d.transaction_id = t.id
            WHERE ${where}
            GROUP BY d.payer_user_id`,
        )
        .bind(...bindings),
      this.#db
        .prepare(
          `SELECT s.user_id, SUM(s.amount_minor) AS amount
             FROM transactions t
             JOIN expense_shares s ON s.transaction_id = t.id
            WHERE ${where}
            GROUP BY s.user_id`,
        )
        .bind(...bindings),
      this.#db
        .prepare(
          `SELECT t.category, SUM(t.total_amount_minor) AS amount
             FROM transactions t
            WHERE ${where}
            GROUP BY t.category
            ORDER BY amount DESC`,
        )
        .bind(...bindings),
    ]);

    const rowsOf = <T>(result: D1Result | undefined): T[] =>
      (result?.results ?? []) as T[];
    const totalRow = rowsOf<{ n: number; total: number }>(totals)[0];
    const paidBy = new Map(
      rowsOf<{ user_id: string; amount: number }>(paid).map(
        ({ user_id, amount }) => [user_id, amount],
      ),
    );
    const shareBy = new Map(
      rowsOf<{ user_id: string; amount: number }>(shares).map(
        ({ user_id, amount }) => [user_id, amount],
      ),
    );
    const everyone = new Set([...paidBy.keys(), ...shareBy.keys()]);

    return {
      totalSpentMinor: totalRow?.total ?? 0,
      expenseCount: totalRow?.n ?? 0,
      perMember: [...everyone]
        .map((userId) => ({
          userId,
          paidMinor: paidBy.get(userId) ?? 0,
          shareMinor: shareBy.get(userId) ?? 0,
        }))
        .sort(
          (a, b) =>
            b.shareMinor - a.shareMinor ||
            b.paidMinor - a.paidMinor ||
            a.userId.localeCompare(b.userId),
        ),
      perCategory: rowsOf<{ category: string | null; amount: number }>(
        categories,
      ).map(({ category, amount }) => ({ category, amountMinor: amount })),
    };
  }

  /**
   * One member's spending for a period: what they consumed (their shares),
   * what they fronted for others, and the expenses behind those numbers.
   */
  async getMemberSpending(
    input: TransactionAccess & {
      memberUserId: string;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<{
    ledgerSpentMinor: number;
    spentMinor: number;
    paidMinor: number;
    perCategory: Array<{ category: string | null; amountMinor: number }>;
    items: Array<{
      transactionId: string;
      occurredOn: string;
      description: string;
      category: string | null;
      payerUserId: string;
      totalAmountMinor: number;
      shareMinor: number;
    }>;
  }> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const clauses = [
      "t.ledger_id = ?",
      "t.deleted_at IS NULL",
      "t.type = 'expense'",
    ];
    const bindings: string[] = [input.ledgerId];
    if (input.startDate !== undefined) {
      assertCalendarDate(input.startDate);
      clauses.push("t.occurred_on >= ?");
      bindings.push(input.startDate);
    }
    if (input.endDate !== undefined) {
      assertCalendarDate(input.endDate);
      clauses.push("t.occurred_on <= ?");
      bindings.push(input.endDate);
    }
    const where = clauses.join(" AND ");
    const member = input.memberUserId;

    const [totals, rows] = await this.#db.batch([
      this.#db
        .prepare(
          `SELECT COALESCE(SUM(t.total_amount_minor), 0) AS total
             FROM transactions t WHERE ${where}`,
        )
        .bind(...bindings),
      // Every expense the member either shared in or paid for; the share is 0
      // when they only fronted the money.
      this.#db
        .prepare(
          `SELECT t.id, t.occurred_on, t.description, t.category,
                  t.total_amount_minor, d.payer_user_id,
                  COALESCE(s.amount_minor, 0) AS share
             FROM transactions t
             JOIN expense_details d ON d.transaction_id = t.id
             LEFT JOIN expense_shares s
               ON s.transaction_id = t.id AND s.user_id = ?
            WHERE ${where}
              AND (s.user_id IS NOT NULL OR d.payer_user_id = ?)
            ORDER BY t.occurred_on DESC, t.created_at DESC, t.id DESC`,
        )
        .bind(member, ...bindings, member),
    ]);

    const totalRow = ((totals?.results ?? []) as Array<{ total: number }>)[0];
    const items = (
      (rows?.results ?? []) as Array<{
        id: string;
        occurred_on: string;
        description: string;
        category: string | null;
        total_amount_minor: number;
        payer_user_id: string;
        share: number;
      }>
    ).map((row) => ({
      transactionId: row.id,
      occurredOn: row.occurred_on,
      description: row.description,
      category: row.category,
      payerUserId: row.payer_user_id,
      totalAmountMinor: row.total_amount_minor,
      shareMinor: row.share,
    }));

    const byCategory = new Map<string | null, number>();
    let spentMinor = 0;
    let paidMinor = 0;
    for (const item of items) {
      spentMinor += item.shareMinor;
      if (item.payerUserId === member) {
        paidMinor += item.totalAmountMinor;
      }
      if (item.shareMinor > 0) {
        byCategory.set(
          item.category,
          (byCategory.get(item.category) ?? 0) + item.shareMinor,
        );
      }
    }

    return {
      ledgerSpentMinor: totalRow?.total ?? 0,
      spentMinor,
      paidMinor,
      perCategory: [...byCategory]
        .map(([category, amountMinor]) => ({ category, amountMinor }))
        .sort((a, b) => b.amountMinor - a.amountMinor),
      items,
    };
  }

  /** Categories this ledger has actually used, most recent first. */
  async listCategories(input: TransactionAccess): Promise<string[]> {
    await this.#ledgers.requireMember(
      input.ledgerId,
      input.guildId,
      input.actorUserId,
    );
    const result = await this.#db
      .prepare(
        `SELECT category, MAX(occurred_on) AS latest
           FROM transactions
          WHERE ledger_id = ?
            AND deleted_at IS NULL
            AND category IS NOT NULL
          GROUP BY category
          ORDER BY latest DESC, category
          LIMIT 25`,
      )
      .bind(input.ledgerId)
      .all<{ category: string }>();
    return result.results.map(({ category }) => category);
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
      category: normalizeCategory(input.category),
    };
    const operationGuard = `EXISTS (
      SELECT 1 FROM transactions
       WHERE id = ? AND last_operation_id = ?
    )`;
    const statements: D1PreparedStatement[] = [
      this.#receiptStatement(input.interactionId, "expense.update", updatedAt),
      this.#balanceRevisionStatement(ledger, input.interactionId),
      this.#db
        .prepare(
          `UPDATE transactions
              SET description = ?, total_amount_minor = ?, occurred_on = ?,
                  updated_by = ?, updated_at = ?, revision = revision + 1,
                  last_operation_id = ?, category = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM ledgers
                 WHERE id = ? AND last_balance_operation_id = ?
              )`,
        )
        .bind(
          description,
          input.totalAmountMinor,
          input.occurredOn,
          input.actorUserId,
          updatedAt,
          input.interactionId,
          normalizeCategory(input.category),
          input.transactionId,
          input.ledgerId,
          input.expectedRevision,
          input.ledgerId,
          input.interactionId,
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
    if (
      (results[1]?.meta.changes ?? 0) === 0 ||
      (results[2]?.meta.changes ?? 0) === 0
    ) {
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
    this.#assertSettlementWithinDebt(
      await this.#loadBalances(input.ledgerId, undefined, input.transactionId),
      ledger,
      input.payerUserId,
      input.amountMinor,
    );

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
      this.#balanceRevisionStatement(ledger, input.interactionId),
      this.#db
        .prepare(
          `UPDATE transactions
              SET description = ?, total_amount_minor = ?, occurred_on = ?,
                  updated_by = ?, updated_at = ?, revision = revision + 1,
                  last_operation_id = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM ledgers
                 WHERE id = ? AND last_balance_operation_id = ?
              )`,
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
          input.ledgerId,
          input.interactionId,
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
    if (
      (results[1]?.meta.changes ?? 0) === 0 ||
      (results[2]?.meta.changes ?? 0) === 0
    ) {
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
    const ledger = await this.#ledgers.requireMember(
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
      this.#balanceRevisionStatement(ledger, input.interactionId),
      this.#db
        .prepare(
          `UPDATE transactions
              SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ?,
                  revision = revision + 1, last_operation_id = ?
            WHERE id = ? AND ledger_id = ? AND revision = ?
              AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM ledgers
                 WHERE id = ? AND last_balance_operation_id = ?
              )`,
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
          input.ledgerId,
          input.interactionId,
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

    if (
      (results[1]?.meta.changes ?? 0) === 0 ||
      (results[2]?.meta.changes ?? 0) === 0
    ) {
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
        category: row.category,
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
    return simplifyDebts(
      await this.#loadBalances(ledgerId, asOf, excludedTransactionId),
    );
  }

  /** Raw per-member net position. Negative means the member owes. */
  async #loadBalances(
    ledgerId: string,
    asOf?: string,
    excludedTransactionId?: string,
  ): Promise<Balance[]> {
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
    return result.results.map(({ user_id, amount_minor }) => ({
      userId: user_id,
      amountMinor: amount_minor,
    }));
  }

  /**
   * A settlement is just a transfer between two members, so it need not follow
   * the simplified suggestion: people hand money to whoever they actually see.
   * The only guard kept is that the payer cannot pay out more than they owe
   * across the ledger, which catches a mistyped amount without dictating who
   * pays whom.
   */
  #assertSettlementWithinDebt(
    balances: readonly Balance[],
    ledger: Ledger,
    payerUserId: string,
    amountMinor: number,
  ): void {
    const owed = -(
      balances.find(({ userId }) => userId === payerUserId)?.amountMinor ?? 0
    );
    if (owed <= 0) {
      throw new ApplicationError(
        "SETTLEMENT_NOT_A_DEBTOR",
        "The payer does not owe anything in this ledger.",
        { userIds: [payerUserId] },
      );
    }
    if (amountMinor > owed) {
      throw new ApplicationError(
        "SETTLEMENT_EXCEEDS_BALANCE",
        "Settlement cannot exceed what the payer owes.",
        {
          detail: `<@${payerUserId}> 目前總共欠 ${
            ledger.currencyCode
          } ${formatMinorAmount(owed, ledger.currencyScale)}。`,
        },
      );
    }
  }

  async #requireTransactionMembers(
    ledger: Ledger,
    userIds: readonly string[],
  ): Promise<void> {
    const members = new Set(await this.#ledgers.listMemberIds(ledger.id));
    const missing = [...new Set(userIds)].filter((userId) => !members.has(userId));
    if (missing.length > 0) {
      throw new ApplicationError(
        "MEMBER_NOT_IN_LEDGER",
        "Every payer, receiver and participant must belong to the ledger.",
        { userIds: missing },
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

  #balanceRevisionStatement(
    ledger: Ledger,
    operationId: string,
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `UPDATE ledgers
            SET balance_revision = balance_revision + 1,
                last_balance_operation_id = ?
          WHERE id = ? AND balance_revision = ?`,
      )
      .bind(operationId, ledger.id, ledger.balanceRevision);
  }

  async #runBalanceCreateBatch(
    statements: D1PreparedStatement[],
    interactionId: string,
    ledger: Ledger,
  ): Promise<void> {
    try {
      const results = await this.#runBatch(statements, interactionId);
      if ((results[1]?.meta.changes ?? 0) === 0) {
        throw new ApplicationError(
          "CONFLICT",
          "The ledger changed while this transaction was being saved.",
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      const current = await this.#db
        .prepare(`SELECT balance_revision FROM ledgers WHERE id = ?`)
        .bind(ledger.id)
        .first<{ balance_revision: number }>();
      if (current?.balance_revision !== ledger.balanceRevision) {
        throw new ApplicationError(
          "CONFLICT",
          "The ledger changed while this transaction was being saved.",
        );
      }
      throw error;
    }
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
