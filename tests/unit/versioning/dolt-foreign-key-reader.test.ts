import { describe, expect, it } from 'bun:test';
import { assertSafeTableName } from '../../../src/contexts/versioning/dolt-foreign-key-reader';

describe('versioning/dolt-foreign-key-reader table validation', () => {
  it.each(['orders', 'customers_2026', '_audit'])('accepts safe identifier %p', (tableName) => {
    expect(() => assertSafeTableName(tableName)).not.toThrow();
  });

  it.each(['orders-items', 'orders items', 'orders;drop', '9orders'])(
    'rejects unsafe identifier %p',
    (tableName) => {
      expect(() => assertSafeTableName(tableName)).toThrow();
    },
  );
});
