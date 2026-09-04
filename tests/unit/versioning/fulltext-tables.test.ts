import { describe, expect, it } from 'bun:test';
import { isDoltFulltextInternalTable } from '../../../src/contexts/versioning/fulltext-tables';

describe('versioning/fulltext-tables', () => {
  it('identifies long auto-generated FULLTEXT doc-count backing tables', () => {
    expect(
      isDoltFulltextInternalTable(
        'dolt_logs_recipients_listener_ix_logs_recipients_listener_message_0_fts_doc_count',
      ),
    ).toBe(true);
  });

  it('identifies the other FULLTEXT backing tables', () => {
    expect(
      isDoltFulltextInternalTable('dolt_logs_recipients_listener_ix_msg_1_fts_global_count'),
    ).toBe(true);
    expect(isDoltFulltextInternalTable('dolt_logs_recipients_listener_ix_msg_1_fts_position')).toBe(
      true,
    );
    expect(
      isDoltFulltextInternalTable('dolt_logs_recipients_listener_ix_msg_1_fts_row_count'),
    ).toBe(true);
    expect(isDoltFulltextInternalTable('dolt_logs_recipients_listener_ix_msg_1_fts_config')).toBe(
      true,
    );
  });

  it('does not identify user tables or the owning table', () => {
    expect(isDoltFulltextInternalTable('logs_recipients_listener')).toBe(false);
    expect(isDoltFulltextInternalTable('customers')).toBe(false);
    expect(isDoltFulltextInternalTable('accounts')).toBe(false);
  });
});
