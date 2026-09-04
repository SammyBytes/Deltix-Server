/**
 * Dolt materializes each FULLTEXT index as a set of hidden secondary tables
 * (`dolt_<table>_ix_..._fts_doc_count`, `_fts_global_count`, `_fts_position`,
 * `_fts_row_count`, `_fts_config`). These are derived state, not user data:
 * they are regenerated automatically whenever the owning table (whose CREATE
 * TABLE carries the FULLTEXT KEY) is imported, and they appear in
 * `dolt_diff_summary`/`dolt diff --name-only` as "changed tables" alongside
 * their owner. They must not be exported or imported as standalone tables:
 *
 * 1. Their auto-generated names concatenate the owning table and index names,
 *    so they routinely exceed MySQL's 64-character identifier limit. Dolt can
 *    create them internally with long names, but the explicit `CREATE TABLE`
 *    a client/server replays from the exported DDL fails with
 *    `invalid identifier`, aborting the whole pull/push.
 * 2. Dolt fails to resolve them `AS OF` some historical commits the way it
 *    resolves user tables, and they contain no data of their own worth
 *    syncing.
 */
export const DOLT_FULLTEXT_INTERNAL_TABLE_RE =
  /^dolt_.*_fts_(?:doc_count|global_count|position|row_count|config)$/;

/** True if `table` is one of Dolt's hidden FULLTEXT index backing tables. */
export function isDoltFulltextInternalTable(table: string): boolean {
  return DOLT_FULLTEXT_INTERNAL_TABLE_RE.test(table);
}
