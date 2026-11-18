import { hostname } from 'os';
import { db } from './turso.service';

// Heartbeat for jobs that run outside the web server (the Mumbai VM).
// /version and `npm run check-deploy` read it to show the last run of each job.

export interface JobRun {
  name:       string;
  host:       string;
  startedAt:  string;
  finishedAt: string | null;
  ok:         boolean | null;
  summary:    string;
}

async function ensureTable(): Promise<void> {
  await db().execute(`CREATE TABLE IF NOT EXISTS job_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    host        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    ok          INTEGER,
    summary     TEXT NOT NULL DEFAULT ''
  )`);
}

export async function recordJob<T>(name: string, fn: () => Promise<T>, summarize: (r: T) => string = r => JSON.stringify(r)): Promise<T> {
  await ensureTable();
  const host = process.env.JOB_HOST_LABEL || hostname();
  const started = new Date().toISOString();
  const res = await db().execute({
    sql: `INSERT INTO job_runs (name, host, started_at) VALUES (?, ?, ?)`, args: [name, host, started],
  });
  const id = Number(res.lastInsertRowid);
  try {
    const out = await fn();
    await db().execute({
      sql: `UPDATE job_runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?`,
      args: [new Date().toISOString(), summarize(out).slice(0, 500), id],
    });
    return out;
  } catch (err) {
    await db().execute({
      sql: `UPDATE job_runs SET finished_at = ?, ok = 0, summary = ? WHERE id = ?`,
      args: [new Date().toISOString(), String((err as Error).message ?? err).slice(0, 500), id],
    }).catch(() => {});
    throw err;
  }
}

/** Latest run of each job. */
export async function latestJobRuns(): Promise<JobRun[]> {
  try {
    const { rows } = await db().execute(
      `SELECT name, host, started_at, finished_at, ok, summary FROM job_runs
       WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY name) ORDER BY name`,
    );
    return rows.map(r => ({
      name: String(r.name), host: String(r.host), startedAt: String(r.started_at),
      finishedAt: (r.finished_at as string) ?? null, ok: r.ok == null ? null : r.ok === 1,
      summary: String(r.summary ?? ''),
    }));
  } catch {
    return []; // table not created yet
  }
}
