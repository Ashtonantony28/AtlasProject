// EXPLAIN QUERY PLAN + timing for Atlas's hot queries (AUDIT-2): node scripts/audit-explain.mjs <index.db>
import Database from 'better-sqlite3';
import * as v from 'sqlite-vec';
import { performance } from 'node:perf_hooks';
const db = new Database(process.argv[2], { readonly: true }); v.load(db);
const MAX_CALLS = 12;
const Q = {
OUTGOING: `SELECT COALESCE(s.qualified_name, s.name) AS symbol, f.path || '#' || COALESCE(t.qualified_name, t.name) AS other
  FROM symbols s JOIN edges e ON e.src_symbol = s.id AND e.kind = 'calls' JOIN symbols t ON t.id = e.dst_symbol JOIN files f ON f.id = t.file_id
  WHERE s.file_id = ? AND s.kind != 'module' AND t.file_id != s.file_id
  GROUP BY symbol, other ORDER BY COUNT(*) DESC, other, symbol LIMIT ${MAX_CALLS}`,
INCOMING: `SELECT COALESCE(s.qualified_name, s.name) AS symbol, f.path || '#' || COALESCE(t.qualified_name, t.name) AS other
  FROM symbols s JOIN edges e ON e.dst_symbol = s.id AND e.kind = 'calls' JOIN symbols t ON t.id = e.src_symbol JOIN files f ON f.id = t.file_id
  WHERE s.file_id = ? AND s.kind != 'module' AND t.file_id != s.file_id
  GROUP BY symbol, other ORDER BY COUNT(*) DESC, other, symbol LIMIT ${MAX_CALLS}`,
ARCH_FILES: `SELECT f.path, f.language, f.loc, (SELECT COUNT(*) FROM symbols s WHERE s.file_id = f.id AND s.kind != 'module') AS symbolCount FROM files f ORDER BY f.path`,
ARCH_TOP: `SELECT f.path AS file, COUNT(*) AS degree FROM (SELECT src_symbol AS sid FROM edges UNION ALL SELECT dst_symbol FROM edges) x JOIN symbols s ON s.id = x.sid JOIN files f ON f.id = s.file_id GROUP BY f.path ORDER BY degree DESC, f.path LIMIT 10`,
SYMS_FOR_FILE: `SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line`,
FTS: `SELECT s.id FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id WHERE symbols_fts MATCH ? AND s.kind != 'module' ORDER BY bm25(symbols_fts, 10.0, 5.0, 1.0) LIMIT ?`,
EXACT: `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE (s.name IN (?) OR s.qualified_name = ?) AND s.kind != 'module' LIMIT ?`,
FILE_FILTER_KNN_SUB: `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind != 'module' AND instr(f.path, ?) > 0`,
};
const args = { OUTGOING:[5], INCOMING:[5], ARCH_FILES:[], ARCH_TOP:[], SYMS_FOR_FILE:[5], FTS:['"invoice"', 400], EXACT:['handleOrder0x0','handleOrder0x0',80], FILE_FILTER_KNN_SUB:['pkg1'] };
for (const [k, sql] of Object.entries(Q)) {
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args[k]).map(r => r.detail);
  const st = db.prepare(sql); const ts=[];
  for (let i=0;i<5;i++){ const t=performance.now(); st.all(...args[k]); ts.push(performance.now()-t); }
  ts.sort((a,b)=>a-b);
  console.log(`== ${k}  median ${ts[2].toFixed(2)} ms`); for (const p of plan) console.log('   ', p);
}
