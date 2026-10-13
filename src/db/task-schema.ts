export const taskSchema = `
CREATE TABLE IF NOT EXISTS qm_task_change_baselines (
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  session_id TEXT NOT NULL REFERENCES qm_sessions(id),
  member_id TEXT NOT NULL REFERENCES qm_session_members(id),
  repo_root TEXT NOT NULL,
  baseline_ref TEXT NOT NULL,
  latest_ref TEXT NOT NULL,
  coverage TEXT NOT NULL,
  PRIMARY KEY(task_id,member_id,repo_root)
);
CREATE TABLE IF NOT EXISTS qm_task_file_changes (
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  session_id TEXT NOT NULL REFERENCES qm_sessions(id),
  member_id TEXT NOT NULL REFERENCES qm_session_members(id),
  version_ref TEXT NOT NULL,
  file_id TEXT NOT NULL,
  status TEXT NOT NULL,
  path TEXT NOT NULL,
  from_path TEXT,
  additions INTEGER,
  removals INTEGER,
  hash TEXT NOT NULL,
  large INTEGER NOT NULL,
  binary INTEGER NOT NULL,
  coverage TEXT NOT NULL,
  revertible INTEGER NOT NULL,
  patch_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id,member_id,version_ref,file_id)
);
CREATE INDEX IF NOT EXISTS qm_task_file_changes_path ON qm_task_file_changes(task_id,member_id,path);
CREATE TABLE IF NOT EXISTS qm_task_context_reads (
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  session_id TEXT NOT NULL REFERENCES qm_sessions(id),
  member_id TEXT NOT NULL REFERENCES qm_session_members(id),
  actor_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  content_ref TEXT,
  read_count INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(task_id,member_id,actor_id,path,kind)
);
CREATE TABLE IF NOT EXISTS qm_task_projections (
  task_id TEXT NOT NULL REFERENCES qm_tasks(id),
  member_id TEXT NOT NULL REFERENCES qm_session_members(id),
  source_revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(task_id,member_id)
);
CREATE TABLE IF NOT EXISTS qm_task_finalizations (
  task_id TEXT PRIMARY KEY REFERENCES qm_tasks(id),
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);
`;

export const migrateCurrentTaskData = `
INSERT OR IGNORE INTO qm_task_change_baselines(task_id,session_id,member_id,repo_root,baseline_ref,latest_ref,coverage)
SELECT t.id,b.session_id,b.member_id,b.repo_root,b.baseline_ref,b.latest_ref,b.coverage
FROM qm_change_baselines b JOIN qm_sessions s ON s.id=b.session_id
JOIN qm_tasks t ON t.id=s.current_task_id AND t.state='active';
INSERT OR IGNORE INTO qm_task_file_changes(task_id,session_id,member_id,version_ref,file_id,status,path,from_path,additions,removals,hash,large,binary,coverage,revertible,patch_ref,created_at)
SELECT t.id,f.session_id,f.member_id,f.version_ref,f.file_id,f.status,f.path,f.from_path,f.additions,f.removals,f.hash,f.large,f.binary,f.coverage,f.revertible,f.patch_ref,f.created_at
FROM qm_file_changes f JOIN qm_sessions s ON s.id=f.session_id
JOIN qm_tasks t ON t.id=s.current_task_id AND t.state='active';
INSERT OR IGNORE INTO qm_task_context_reads(task_id,session_id,member_id,actor_id,path,kind,state,content_ref,read_count,observed_at)
SELECT t.id,c.session_id,c.member_id,c.actor_id,c.path,c.kind,c.state,c.content_ref,c.read_count,COALESCE(c.observed_at,t.created_at)
FROM qm_context_reads c JOIN qm_sessions s ON s.id=c.session_id
JOIN qm_tasks t ON t.id=s.current_task_id AND t.state='active';
`;
