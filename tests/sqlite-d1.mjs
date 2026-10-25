import { DatabaseSync } from 'node:sqlite';

/**
 * A D1-shaped test transport backed by real SQLite. SQL, uniqueness, foreign
 * keys, conditional updates, and batch rollback are executed by SQLite;
 * business outcomes are never preprogrammed by the fixture.
 */
export class SQLiteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql) {
    return new SQLiteStatement(this, sql, []);
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.execute('all'));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

class SQLiteStatement {
  constructor(database, sql, values) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SQLiteStatement(this.database, this.sql, values);
  }

  execute(mode) {
    const statement = this.database.sqlite.prepare(this.sql);
    const returnsRows = statement.columns().length > 0;
    let results = [];
    let changes = 0;
    let lastRowId = 0;
    if (returnsRows) {
      results = statement.all(...this.values).map(row => ({ ...row }));
      const metadata = this.database.sqlite
        .prepare('SELECT changes() AS changes, last_insert_rowid() AS lastRowId')
        .get();
      changes = Number(metadata.changes);
      lastRowId = Number(metadata.lastRowId);
    } else {
      const metadata = statement.run(...this.values);
      changes = Number(metadata.changes);
      lastRowId = Number(metadata.lastInsertRowid);
    }
    return {
      success: true,
      results: mode === 'run' ? [] : results,
      meta: {
        changes,
        last_row_id: lastRowId,
        duration: 0,
        rows_read: results.length,
        rows_written: changes,
        changed_db: changes > 0,
      },
    };
  }

  async all() {
    return this.execute('all');
  }

  async run() {
    return this.execute('run');
  }

  async first(column) {
    const row = this.execute('all').results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }

  async raw(options = {}) {
    const rows = this.execute('all').results;
    const columns = this.database.sqlite.prepare(this.sql).columns().map(c => c.name);
    const values = rows.map(row => columns.map(column => row[column]));
    return options.columnNames ? [columns, ...values] : values;
  }
}
