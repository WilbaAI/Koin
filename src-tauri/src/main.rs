// Koin persistence — embedded SQLite via rusqlite.
//
// The frontend (main.js) still sends/receives the WHOLE `state` object as a JSON string through
// the same three commands (load_data / save_data / data_file_location). On disk that JSON is now a
// normalized relational database (koin.db). Derived values (balances, outstanding, received) are
// NOT stored — they stay computed in compute.js. Write model is full-snapshot inside one
// transaction, so a crash can never leave a half-written DB.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// ---- schema (CREATE ... IF NOT EXISTS; run on every open) ----
const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'bank' CHECK (type IN ('bank','cash')),
  institution TEXT NOT NULL DEFAULT '',
  opening REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)) );

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY, date TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN
    ('expense','income','transfer','lend','loan_repaid','borrow','debt_repaid','invest','redeem','adjust')),
  amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  from_ref TEXT, to_ref TEXT,
  category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  link_kind TEXT CHECK (link_kind IS NULL OR link_kind IN ('loan','debt','income','trust')),
  link_id TEXT, link_inv_id TEXT,
  CHECK ((link_kind IS NULL AND link_id IS NULL) OR (link_kind IS NOT NULL AND link_id IS NOT NULL)) );

CREATE TABLE IF NOT EXISTS unit_trusts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', current_nav REAL NOT NULL DEFAULT 0 );

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  trust_id TEXT NOT NULL REFERENCES unit_trusts(id) ON DELETE CASCADE ON UPDATE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  nav REAL NOT NULL DEFAULT 0, units REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  redeemed INTEGER NOT NULL DEFAULT 0 CHECK (redeemed IN (0,1)) );

CREATE TABLE IF NOT EXISTS incomes (
  id TEXT PRIMARY KEY, project TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  total REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
  date TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '' );

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY, person TEXT NOT NULL DEFAULT '',
  principal REAL NOT NULL DEFAULT 0 CHECK (principal >= 0),
  direction TEXT NOT NULL DEFAULT 'lent' CHECK (direction IN ('lent','borrowed')),
  date TEXT NOT NULL DEFAULT '', due TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '' );

CREATE TABLE IF NOT EXISTS categories ( name TEXT PRIMARY KEY );

CREATE INDEX IF NOT EXISTS ix_txn_date  ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_txn_from  ON transactions(from_ref);
CREATE INDEX IF NOT EXISTS ix_txn_to    ON transactions(to_ref);
CREATE INDEX IF NOT EXISTS ix_txn_link  ON transactions(link_kind, link_id);
CREATE INDEX IF NOT EXISTS ix_txn_inv   ON transactions(link_inv_id);
CREATE INDEX IF NOT EXISTS ix_inv_trust ON investments(trust_id);
";

// ---- serde structs mirroring the JS `state` (exact JSON shape both ways) ----
// #[serde(default)] everywhere so partial/legacy JSON deserializes like JS {...blank(), ...loaded}.
fn is_false(b: &bool) -> bool { !*b }

#[derive(Serialize, Deserialize, Default)]
struct State {
    #[serde(default)] accounts: Vec<Account>,
    #[serde(default)] transactions: Vec<Txn>,
    #[serde(default, rename = "unitTrusts")] unit_trusts: Vec<Trust>,
    #[serde(default)] incomes: Vec<Income>,
    #[serde(default)] loans: Vec<Loan>,
    #[serde(default)] categories: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] theme: Option<String>,
    #[serde(default, rename = "appLock", skip_serializing_if = "is_false")] app_lock: bool,
    // NOTE: txnFilter (transient UI state in main.js) is intentionally absent — it must not persist.
}

#[derive(Serialize, Deserialize, Default)]
struct Account {
    #[serde(default)] id: String,
    #[serde(default)] name: String,
    #[serde(default, rename = "type")] kind: String,
    #[serde(default)] institution: String,
    #[serde(default)] opening: f64,
    #[serde(default)] archived: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Link {
    #[serde(default)] kind: String,
    #[serde(default)] id: String,
    #[serde(default, rename = "invId", skip_serializing_if = "Option::is_none")] inv_id: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Txn {
    #[serde(default)] id: String,
    #[serde(default)] date: String,
    #[serde(default, rename = "type")] kind: String,
    #[serde(default)] amount: f64,
    // from/to/link always serialize (null when absent) to match the shape main.js authors.
    #[serde(default)] from: Option<String>,
    #[serde(default)] to: Option<String>,
    #[serde(default)] category: String,
    #[serde(default)] note: String,
    #[serde(default)] link: Option<Link>,
}

#[derive(Serialize, Deserialize, Default)]
struct Investment {
    #[serde(default)] id: String,
    #[serde(default)] amount: f64,
    #[serde(default)] nav: f64,
    #[serde(default)] units: f64,
    #[serde(default)] date: String,
    #[serde(default)] note: String,
    #[serde(default, skip_serializing_if = "is_false")] redeemed: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Trust {
    #[serde(default)] id: String,
    #[serde(default)] name: String,
    #[serde(default, rename = "currentNav")] current_nav: f64,
    #[serde(default)] investments: Vec<Investment>,
}

#[derive(Serialize, Deserialize, Default)]
struct Income {
    #[serde(default)] id: String,
    #[serde(default)] project: String,
    #[serde(default)] source: String,
    #[serde(default)] total: f64,
    #[serde(default)] date: String,
    #[serde(default)] due: String,
    #[serde(default)] note: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Loan {
    #[serde(default)] id: String,
    #[serde(default)] person: String,
    #[serde(default)] principal: f64,
    #[serde(default)] direction: String,
    #[serde(default)] date: String,
    #[serde(default)] due: String,
    #[serde(default)] note: String,
}

// ---- paths & connection ----
fn app_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("could not resolve app data dir");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}
fn db_path(app: &tauri::AppHandle) -> PathBuf { app_dir(app).join("koin.db") }

fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)).map_err(|e| e.to_string())?;
    // foreign_keys is per-connection; WAL/synchronous persist on the file.
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;
    Ok(conn)
}

// ---- meta helpers ----
fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())
}
fn meta_set(conn: &Connection, key: &str, val: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, val],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn table_empty(conn: &Connection, table: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(n == 0)
}

// One-time import of a pre-SQLite koin-data.json. Idempotent. Stashes the raw JSON in
// meta.legacy_blob so the JS boot migrations (compute.js) — not Rust — normalize it; the next
// save_data writes the normalized tables and clears the blob. Original json kept as .bak.
fn import_legacy_if_needed(dir: &std::path::Path, conn: &Connection) -> Result<(), String> {
    if meta_get(conn, "legacy_blob")?.is_some() {
        return Ok(()); // a pending blob is already waiting to be normalized
    }
    if meta_get(conn, "json_imported")?.as_deref() == Some("1") {
        return Ok(());
    }
    let populated = !table_empty(conn, "accounts")?
        || !table_empty(conn, "transactions")?
        || !table_empty(conn, "incomes")?
        || !table_empty(conn, "loans")?
        || !table_empty(conn, "unit_trusts")?
        || !table_empty(conn, "categories")?;
    if !populated {
        let jpath = dir.join("koin-data.json");
        if let Ok(contents) = fs::read_to_string(&jpath) {
            let trimmed = contents.trim();
            if !trimmed.is_empty() && trimmed != "null" {
                meta_set(conn, "legacy_blob", &contents)?;
                let _ = fs::rename(&jpath, jpath.with_extension("json.bak"));
            }
        }
    }
    meta_set(conn, "json_imported", "1")?;
    Ok(())
}

// ---- read: tables -> State (ORDER BY rowid preserves insertion order, e.g. seeded cash account first) ----
fn read_state(conn: &Connection) -> Result<State, String> {
    let mut st = State::default();

    let mut stmt = conn
        .prepare("SELECT id,name,type,institution,opening,archived FROM accounts ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, institution: r.get(3)?,
                opening: r.get(4)?, archived: r.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    for a in rows { st.accounts.push(a.map_err(|e| e.to_string())?); }

    let mut stmt = conn
        .prepare("SELECT id,date,type,amount,from_ref,to_ref,category,note,link_kind,link_id,link_inv_id FROM transactions ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let link_kind: Option<String> = r.get(8)?;
            let link = match link_kind {
                Some(k) => Some(Link {
                    kind: k,
                    id: r.get::<_, Option<String>>(9)?.unwrap_or_default(),
                    inv_id: r.get(10)?,
                }),
                None => None,
            };
            Ok(Txn {
                id: r.get(0)?, date: r.get(1)?, kind: r.get(2)?, amount: r.get(3)?,
                from: r.get(4)?, to: r.get(5)?, category: r.get(6)?, note: r.get(7)?, link,
            })
        })
        .map_err(|e| e.to_string())?;
    for t in rows { st.transactions.push(t.map_err(|e| e.to_string())?); }

    let mut stmt = conn
        .prepare("SELECT id,name,current_nav FROM unit_trusts ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Trust { id: r.get(0)?, name: r.get(1)?, current_nav: r.get(2)?, investments: vec![] })
        })
        .map_err(|e| e.to_string())?;
    for t in rows { st.unit_trusts.push(t.map_err(|e| e.to_string())?); }

    let mut stmt = conn
        .prepare("SELECT trust_id,id,amount,nav,units,date,note,redeemed FROM investments ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Investment {
                    id: r.get(1)?, amount: r.get(2)?, nav: r.get(3)?, units: r.get(4)?,
                    date: r.get(5)?, note: r.get(6)?, redeemed: r.get::<_, i64>(7)? != 0,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (trust_id, inv) = row.map_err(|e| e.to_string())?;
        if let Some(t) = st.unit_trusts.iter_mut().find(|t| t.id == trust_id) {
            t.investments.push(inv);
        }
    }

    let mut stmt = conn
        .prepare("SELECT id,project,source,total,date,due,note FROM incomes ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Income {
                id: r.get(0)?, project: r.get(1)?, source: r.get(2)?, total: r.get(3)?,
                date: r.get(4)?, due: r.get(5)?, note: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for i in rows { st.incomes.push(i.map_err(|e| e.to_string())?); }

    let mut stmt = conn
        .prepare("SELECT id,person,principal,direction,date,due,note FROM loans ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Loan {
                id: r.get(0)?, person: r.get(1)?, principal: r.get(2)?, direction: r.get(3)?,
                date: r.get(4)?, due: r.get(5)?, note: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for l in rows { st.loans.push(l.map_err(|e| e.to_string())?); }

    let mut stmt = conn.prepare("SELECT name FROM categories ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for c in rows { st.categories.push(c.map_err(|e| e.to_string())?); }

    st.theme = meta_get(conn, "theme")?;
    st.app_lock = matches!(meta_get(conn, "app_lock")?.as_deref(), Some("1"));
    Ok(st)
}

// ---- write: State -> tables (full snapshot in one transaction; FK-safe order) ----
fn write_state(tx: &rusqlite::Transaction, st: &State) -> Result<(), String> {
    for t in ["investments", "transactions", "accounts", "unit_trusts", "incomes", "loans", "categories"] {
        tx.execute(&format!("DELETE FROM {t}"), []).map_err(|e| e.to_string())?;
    }
    for a in &st.accounts {
        let kind = if a.kind.is_empty() { "bank" } else { a.kind.as_str() };
        tx.execute(
            "INSERT INTO accounts(id,name,type,institution,opening,archived) VALUES(?1,?2,?3,?4,?5,?6)",
            params![a.id, a.name, kind, a.institution, a.opening, a.archived as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    for t in &st.unit_trusts {
        tx.execute(
            "INSERT INTO unit_trusts(id,name,current_nav) VALUES(?1,?2,?3)",
            params![t.id, t.name, t.current_nav],
        )
        .map_err(|e| e.to_string())?;
        for inv in &t.investments {
            tx.execute(
                "INSERT INTO investments(id,trust_id,amount,nav,units,date,note,redeemed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![inv.id, t.id, inv.amount, inv.nav, inv.units, inv.date, inv.note, inv.redeemed as i64],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    for t in &st.transactions {
        let (lk, li, lv) = match &t.link {
            Some(l) => (Some(l.kind.as_str()), Some(l.id.as_str()), l.inv_id.clone()),
            None => (None, None, None),
        };
        tx.execute(
            "INSERT INTO transactions(id,date,type,amount,from_ref,to_ref,category,note,link_kind,link_id,link_inv_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![t.id, t.date, t.kind, t.amount, t.from, t.to, t.category, t.note, lk, li, lv],
        )
        .map_err(|e| e.to_string())?;
    }
    for i in &st.incomes {
        tx.execute(
            "INSERT INTO incomes(id,project,source,total,date,due,note) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![i.id, i.project, i.source, i.total, i.date, i.due, i.note],
        )
        .map_err(|e| e.to_string())?;
    }
    for l in &st.loans {
        let dir = if l.direction.is_empty() { "lent" } else { l.direction.as_str() };
        tx.execute(
            "INSERT INTO loans(id,person,principal,direction,date,due,note) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![l.id, l.person, l.principal, dir, l.date, l.due, l.note],
        )
        .map_err(|e| e.to_string())?;
    }
    for c in &st.categories {
        tx.execute("INSERT OR IGNORE INTO categories(name) VALUES(?1)", params![c]).map_err(|e| e.to_string())?;
    }
    if let Some(th) = &st.theme {
        tx.execute(
            "INSERT INTO meta(key,value) VALUES('theme',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![th],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO meta(key,value) VALUES('app_lock',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![if st.app_lock { "1" } else { "0" }],
    )
    .map_err(|e| e.to_string())?;
    // The legacy blob (if any) is now superseded by normalized rows.
    tx.execute("DELETE FROM meta WHERE key='legacy_blob'", []).map_err(|e| e.to_string())?;
    Ok(())
}

// ---- commands (same names & signatures as the old JSON-file version) ----
#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<String, String> {
    let conn = open_db(&app)?;
    import_legacy_if_needed(&app_dir(&app), &conn)?;
    if let Some(blob) = meta_get(&conn, "legacy_blob")? {
        return Ok(blob); // raw legacy JSON; JS migrates it, next save normalizes + clears the blob
    }
    let st = read_state(&conn)?;
    let empty = st.accounts.is_empty()
        && st.transactions.is_empty()
        && st.incomes.is_empty()
        && st.loans.is_empty()
        && st.unit_trusts.is_empty()
        && st.categories.is_empty()
        && st.theme.is_none();
    if empty {
        return Ok(String::from("null")); // preserve the "no data yet" signal main.js expects
    }
    serde_json::to_string(&st).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let st: State = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    let mut conn = open_db(&app)?;
    {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_state(&tx, &st)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    // Fold the WAL back into koin.db so it stays a single self-contained, copyable file.
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(())
}

#[tauri::command]
fn data_file_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(db_path(&app).to_string_lossy().to_string())
}

// App-lock auth. macOS: Touch ID with automatic password fallback (LocalAuthentication).
// Other platforms: no native prompt, so it succeeds (the lock is a macOS feature).
#[tauri::command]
fn authenticate(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use robius_authentication::{AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText};
        let policy = PolicyBuilder::new()
            .biometrics(Some(BiometricStrength::Strong))
            .password(true)
            .watch(true)
            .build()
            .expect("valid auth policy");
        let text = Text {
            android: AndroidText { title: "Koin", subtitle: None, description: None },
            apple: reason.as_str(),
            windows: WindowsText::new("Koin", reason.as_str()).expect("windows auth text"),
        };
        Ok(Context::new(()).blocking_authenticate(text, &policy).is_ok())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(true)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            data_file_location,
            authenticate
        ])
        .run(tauri::generate_context!())
        .expect("error while running koin");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        c
    }

    fn roundtrip(json: &str) -> serde_json::Value {
        let st: State = serde_json::from_str(json).unwrap();
        let mut c = mem();
        {
            let tx = c.transaction().unwrap();
            write_state(&tx, &st).unwrap();
            tx.commit().unwrap();
        }
        let out = read_state(&c).unwrap();
        serde_json::from_str(&serde_json::to_string(&out).unwrap()).unwrap()
    }

    // The full state (every entity, ext-token refs, null link, trust link with invId,
    // signed-negative redemption row, archived/redeemed bools, theme) survives a DB round-trip
    // byte-for-byte at the JSON level.
    #[test]
    fn full_state_roundtrips() {
        let json = r#"{
          "accounts":[
            {"id":"cash1","name":"Cash in hand","type":"cash","institution":"","opening":0.0,"archived":false},
            {"id":"boc","name":"Salary","type":"bank","institution":"ComBank","opening":100000.0,"archived":true}
          ],
          "transactions":[
            {"id":"t1","date":"2026-06-02","type":"expense","amount":2500.0,"from":"cash1","to":"ext:expense","category":"Food","note":"lunch","link":null},
            {"id":"t2","date":"2026-06-05","type":"lend","amount":15000.0,"from":"boc","to":"ext:loan","category":"","note":"","link":{"kind":"loan","id":"l1"}},
            {"id":"t3","date":"2026-06-06","type":"invest","amount":5000.0,"from":"boc","to":"ext:trust","category":"","note":"","link":{"kind":"trust","id":"f1","invId":"iv1"}}
          ],
          "unitTrusts":[
            {"id":"f1","name":"Growth","currentNav":30.0,"investments":[
              {"id":"iv1","amount":5000.0,"nav":25.0,"units":200.0,"date":"2026-06-06","note":"top-up"},
              {"id":"iv2","amount":-1000.0,"nav":30.0,"units":-33.0,"date":"2026-06-10","note":"redemption","redeemed":true}
            ]}
          ],
          "incomes":[{"id":"i1","project":"Logo","source":"ABC","total":80000.0,"date":"2026-02-01","due":"","note":""}],
          "loans":[
            {"id":"l1","person":"Kasun","principal":15000.0,"direction":"lent","date":"2026-06-05","due":"","note":""},
            {"id":"d1","person":"Nimal","principal":8000.0,"direction":"borrowed","date":"2026-06-07","due":"","note":""}
          ],
          "categories":["Food","Transport"],
          "theme":"dark"
        }"#;
        let before: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(before, roundtrip(json), "state must survive a DB round-trip unchanged");
    }

    #[test]
    fn empty_db_reads_as_empty() {
        let c = mem();
        let st = read_state(&c).unwrap();
        assert!(st.accounts.is_empty() && st.transactions.is_empty() && st.theme.is_none());
    }

    // Legacy json is stashed into meta.legacy_blob (json renamed to .bak), and a subsequent
    // normalized save clears the blob.
    #[test]
    fn legacy_import_then_save_clears_blob() {
        let dir = std::env::temp_dir().join(format!("koin_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let jpath = dir.join("koin-data.json");
        fs::write(&jpath, r#"{"theme":"light","categories":["X"]}"#).unwrap();

        let c = Connection::open(dir.join("koin.db")).unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        import_legacy_if_needed(&dir, &c).unwrap();
        assert!(meta_get(&c, "legacy_blob").unwrap().is_some(), "blob stashed");
        assert!(!jpath.exists(), "original json renamed");
        assert!(dir.join("koin-data.json.bak").exists(), ".bak kept");
        // re-running is a no-op (idempotent)
        import_legacy_if_needed(&dir, &c).unwrap();

        let st: State = serde_json::from_str(r#"{"categories":["X"],"theme":"light"}"#).unwrap();
        let mut c2 = Connection::open(dir.join("koin.db")).unwrap();
        {
            let tx = c2.transaction().unwrap();
            write_state(&tx, &st).unwrap();
            tx.commit().unwrap();
        }
        assert!(meta_get(&c2, "legacy_blob").unwrap().is_none(), "blob cleared after save");
        let _ = fs::remove_dir_all(&dir);
    }
}
