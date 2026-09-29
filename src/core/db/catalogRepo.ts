import type { Category, CategoryKind, RuleDTO, RuleMatchType } from '../../shared/types';
import { SYSTEM_CATEGORIES, type SystemCategoryKey } from '../domain/categories';
import type { UserRule } from '../domain/categorizer';
import { AppError, notFound } from '../errors';
import type { Database } from './database';

interface CategoryRow {
  id: number;
  name: string;
  kind: CategoryKind;
  color: string;
  is_system: number;
  excluded_from_spending: number;
  system_key: string | null;
}

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  color: r.color,
  isSystem: r.is_system === 1,
  excludedFromSpending: r.excluded_from_spending === 1,
});

export class CategoriesRepo {
  private keyCache = new Map<string, number>();

  constructor(private readonly db: Database, private readonly now: () => Date) {}

  /** Inserts missing system categories (idempotent). */
  ensureSystemCategories(): void {
    const ts = this.now().toISOString();
    this.db.transaction(() => {
      for (const c of SYSTEM_CATEGORIES) {
        this.db.run(
          `INSERT INTO categories(name, kind, color, is_system, excluded_from_spending, system_key, created_at)
           VALUES (?, ?, ?, 1, ?, ?, ?) ON CONFLICT DO NOTHING`,
          c.name, c.kind, c.color, c.excludedFromSpending ?? false, c.key, ts,
        );
      }
    });
    this.keyCache.clear();
  }

  list(): Category[] {
    return this.db.all<CategoryRow>('SELECT * FROM categories ORDER BY is_system DESC, name').map(toCategory);
  }

  get(id: number): Category {
    const row = this.db.get<CategoryRow>('SELECT * FROM categories WHERE id = ?', id);
    if (!row) throw notFound('La categoría');
    return toCategory(row);
  }

  idByKey(key: SystemCategoryKey): number {
    const cached = this.keyCache.get(key);
    if (cached !== undefined) return cached;
    const row = this.db.get<{ id: number }>('SELECT id FROM categories WHERE system_key = ?', key);
    if (!row) throw new AppError('INTERNAL', `Falta la categoría del sistema ${key}`);
    this.keyCache.set(key, row.id);
    return row.id;
  }

  create(input: { name: string; kind: CategoryKind; color: string }): Category {
    const name = input.name.trim();
    if (this.db.get('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE', name)) {
      throw new AppError('CONFLICT', `Ya existe una categoría llamada «${name}».`);
    }
    const r = this.db.run(
      'INSERT INTO categories(name, kind, color, is_system, excluded_from_spending, created_at) VALUES (?, ?, ?, 0, 0, ?)',
      name, input.kind, input.color, this.now().toISOString(),
    );
    return this.get(r.lastInsertRowid);
  }

  update(input: { id: number; name?: string; kind?: CategoryKind; color?: string }): Category {
    const current = this.get(input.id);
    if (input.name !== undefined && input.name.trim() !== current.name) {
      if (current.isSystem) throw new AppError('VALIDATION', 'Las categorías del sistema no se pueden renombrar; puedes crear una personalizada.');
      if (this.db.get('SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?', input.name.trim(), input.id)) {
        throw new AppError('CONFLICT', `Ya existe una categoría llamada «${input.name.trim()}».`);
      }
    }
    this.db.run(
      'UPDATE categories SET name = ?, kind = ?, color = ? WHERE id = ?',
      input.name?.trim() ?? current.name, input.kind ?? current.kind, input.color ?? current.color, input.id,
    );
    return this.get(input.id);
  }

  /** Deletes a custom category; its movements move to "Sin clasificar" and rules pointing to it are removed. */
  delete(id: number): { reassigned: number } {
    const cat = this.get(id);
    if (cat.isSystem) throw new AppError('VALIDATION', 'Las categorías del sistema no se pueden eliminar.');
    const fallback = this.idByKey('uncategorized');
    return this.db.transaction(() => {
      const r = this.db.run(
        `UPDATE transactions SET category_id = ?, classification_source = 'UNKNOWN', classification_confidence = 0,
           classification_detail = 'Su categoría fue eliminada', rule_id = NULL, category_locked = 0, updated_at = ?
         WHERE category_id = ?`,
        fallback, this.now().toISOString(), id,
      );
      this.db.run('DELETE FROM categorization_rules WHERE category_id = ?', id);
      this.db.run('DELETE FROM categories WHERE id = ?', id);
      return { reassigned: r.changes };
    });
  }
}

export class MerchantsRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  upsert(key: string, display: string): number {
    const existing = this.db.get<{ id: number }>('SELECT id FROM merchants WHERE key = ?', key);
    if (existing) return existing.id;
    return this.db.run('INSERT INTO merchants(key, display_name, created_at) VALUES (?, ?, ?)', key, display, this.now().toISOString()).lastInsertRowid;
  }

  get(id: number): { id: number; key: string; displayName: string } {
    const row = this.db.get<{ id: number; key: string; display_name: string }>('SELECT id, key, display_name FROM merchants WHERE id = ?', id);
    if (!row) throw notFound('El comercio');
    return { id: row.id, key: row.key, displayName: row.display_name };
  }

  /** Renames a merchant display name. Keys are stable, so learned rules keep working. */
  rename(id: number, name: string): void {
    this.get(id);
    this.db.run('UPDATE merchants SET display_name = ? WHERE id = ?', name.trim(), id);
  }
}

interface RuleRow {
  id: number;
  match_type: RuleMatchType;
  pattern: string;
  category_id: number;
  category_name: string;
  created_at: string;
  merchant_name: string | null;
  match_count: number;
}

export class RulesRepo {
  constructor(private readonly db: Database, private readonly now: () => Date) {}

  listForEngine(): UserRule[] {
    return this.db
      .all<{ id: number; match_type: RuleMatchType; pattern: string; category_id: number }>('SELECT id, match_type, pattern, category_id FROM categorization_rules')
      .map((r) => ({ id: r.id, matchType: r.match_type, pattern: r.pattern, categoryId: r.category_id }));
  }

  list(): RuleDTO[] {
    return this.db
      .all<RuleRow>(
        `SELECT r.id, r.match_type, r.pattern, r.category_id, c.name AS category_name, r.created_at,
                (SELECT display_name FROM merchants m WHERE r.match_type = 'merchant' AND m.key = r.pattern) AS merchant_name,
                (SELECT COUNT(*) FROM transactions t WHERE t.rule_id = r.id) AS match_count
         FROM categorization_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.created_at DESC`,
      )
      .map(toRuleDto);
  }

  get(id: number): RuleDTO {
    const row = this.db.get<RuleRow>(
      `SELECT r.id, r.match_type, r.pattern, r.category_id, c.name AS category_name, r.created_at,
              (SELECT display_name FROM merchants m WHERE r.match_type = 'merchant' AND m.key = r.pattern) AS merchant_name,
              (SELECT COUNT(*) FROM transactions t WHERE t.rule_id = r.id) AS match_count
       FROM categorization_rules r JOIN categories c ON c.id = r.category_id WHERE r.id = ?`,
      id,
    );
    if (!row) throw notFound('La regla');
    return toRuleDto(row);
  }

  /** Creates or replaces the rule for the same (matchType, pattern). */
  upsert(matchType: RuleMatchType, pattern: string, categoryId: number): number {
    this.db.run(
      `INSERT INTO categorization_rules(match_type, pattern, category_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(match_type, pattern) DO UPDATE SET category_id = excluded.category_id`,
      matchType, pattern, categoryId, this.now().toISOString(),
    );
    return this.db.get<{ id: number }>('SELECT id FROM categorization_rules WHERE match_type = ? AND pattern = ?', matchType, pattern)!.id;
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM categorization_rules WHERE id = ?', id).changes > 0;
  }
}

function toRuleDto(r: RuleRow): RuleDTO {
  return {
    id: r.id,
    matchType: r.match_type,
    pattern: r.pattern,
    displayPattern: r.match_type === 'merchant' ? `Comercio: ${r.merchant_name ?? r.pattern}` : `Contiene «${r.pattern}»`,
    categoryId: r.category_id,
    categoryName: r.category_name,
    createdAt: r.created_at,
    matchCount: Number(r.match_count),
  };
}
