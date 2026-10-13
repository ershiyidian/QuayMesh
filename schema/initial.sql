CREATE TABLE workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    , recovery_kind text);

CREATE TABLE loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

CREATE TABLE oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

CREATE TABLE oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

CREATE TABLE oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

CREATE TABLE local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    , error_code text, error_retryable text, context_key text, context_signature text, work_item_id text, progress text, recovery_type text, parent_provider_session_id text, control_state text not null default 'terminal', provider_turn_id text, control_revision integer not null default 0, task_name text);

CREATE TABLE workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

CREATE TABLE execution_claims (
        id text primary key,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        resources text not null,
        acquired_at text not null
      , access_mode text not null default 'write', thread_key text);

CREATE TABLE agent_task_keys (
        workspace_root text not null, workspace_scope text not null,
        target text not null, task_key text not null, request_hash text not null,
        agent_id text not null references local_agent_sessions(id),
        primary key (workspace_root, workspace_scope, target, task_key)
      );

CREATE TABLE agent_usage_snapshots (
        agent_id text not null references local_agent_sessions(id),
        thread_id text not null, turn_id text not null,
        total_tokens integer not null, totals text not null, last_request text,
        baseline text, baseline_kind text not null, observed_at text not null,
        provider_version text,
        primary key (agent_id, thread_id, turn_id)
      );

CREATE TABLE execution_waiters (
        sequence integer primary key autoincrement,
        id text not null unique,
        owner_id text not null,
        owner_pid integer not null,
        kind text not null,
        checkout_root text not null,
        agent_id text,
        thread_key text,
        access_mode text not null,
        resources text not null,
        expires_at_ms integer not null
      );

CREATE TABLE agent_continue_keys (
        agent_id text not null references local_agent_sessions(id) on delete cascade,
        request_key text not null,
        request_hash text not null,
        primary key(agent_id, request_key)
      );

CREATE TABLE console_projects (
      id text primary key, root text not null unique, name text not null, created_at text not null
    );

CREATE TABLE console_work_items (
      id text primary key, project_id text not null references console_projects(id),
      item_key text not null, title text not null, created_at text not null
    );

CREATE TABLE console_work_runs (
      id text primary key, project_id text not null references console_projects(id),
      item_id text not null references console_work_items(id), workspace_id text,
      run_key text not null, request_hash text not null, origin text not null,
      status text not null default 'running', acceptance text not null default 'pending',
      summary text not null default '', evidence text not null default '[]',
      revision integer not null default 1, created_at text not null, finished_at text
    , last_activity_at text, lease_expires_at text, interrupted_at text, resume_count integer not null default 0);

CREATE TABLE console_operations (
      id text primary key, run_id text not null references console_work_runs(id),
      request_key text not null, kind text not null, label text not null,
      status text not null, evidence text not null default '[]', created_at text not null, finished_at text
    );

CREATE TABLE console_threads (
      id text primary key, project_id text not null references console_projects(id),
      agent_id text not null references local_agent_sessions(id), instance_id text not null,
      thread_id text not null, created_here integer not null, identity_verified integer not null,
      origin text not null, title text not null, name_status text not null default 'pending',
      external_activity integer not null default 0, protected integer not null default 0,
      archive_state text not null default 'active', revision integer not null default 1,
      created_at text not null, updated_at text not null
    );

CREATE TABLE console_executions (
      id text primary key, run_id text not null references console_work_runs(id),
      agent_id text not null references local_agent_sessions(id), provider text not null,
      managed_thread_id text references console_threads(id), provider_turn_id text,
      status text not null, requested integer not null default 0, provider_finished integer not null default 0,
      baseline text, cumulative text, delta text, usage_quality text not null default 'not_used',
      boundary_reason text not null default 'no_provider_request', requested_model text, requested_effort text,
      created_at text not null, finished_at text
    );

CREATE TABLE console_archive_batches (
      id text primary key, project_id text not null references console_projects(id),
      mode text not null, status text not null, request_hash text not null,
      accept_partial integer not null, external_idle integer not null, created_at text not null,
      expires_at text not null, updated_at text not null
    );

CREATE TABLE console_archive_entries (
      batch_id text not null references console_archive_batches(id),
      managed_thread_id text not null references console_threads(id),
      expected_revision integer not null, expected_snapshot text, status text not null,
      reason text, updated_at text not null,
      primary key(batch_id, managed_thread_id)
    );

CREATE TABLE execution_responses (
    execution_id text primary key references console_executions(id),
    response text not null, sha256 text not null, bytes integer not null
  );

CREATE TABLE local_agent_turns (
      id integer primary key autoincrement,
      agent_id text not null,
      prompt text not null,
      status text not null,
      response text,
      error text,
      error_code text,
      error_retryable text,
      created_at text not null,
      completed_at text,
      foreign key (agent_id) references local_agent_sessions(id) on delete cascade
    );

CREATE TABLE agent_control_requests (
      agent_id text not null references local_agent_sessions(id) on delete cascade,
      request_key text not null,
      request_hash text not null,
      action text not null,
      status text not null,
      receipt text,
      created_at text not null,
      updated_at text not null,
      primary key(agent_id, request_key)
    );

CREATE TABLE agent_control_events (
      sequence integer primary key autoincrement,
      agent_id text not null references local_agent_sessions(id) on delete cascade,
      event_type text not null,
      control_state text not null,
      provider_thread_id text,
      provider_turn_id text,
      created_at text not null
    );

CREATE TABLE console_sessions (
      token_hash text primary key,
      csrf text not null,
      expires_at integer not null,
      created_at text not null,
      last_used_at text not null
    );

CREATE TABLE execution_claim_reconciliations (
      id text primary key,
      claim_id text not null,
      kind text not null,
      owner_pid integer not null,
      agent_id text,
      checkout_root text not null,
      run_id text,
      reason text not null,
      evidence text not null,
      created_at text not null
    );

CREATE TABLE qm_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      execution_state TEXT NOT NULL DEFAULT 'idle',
      review_state TEXT NOT NULL DEFAULT 'unknown',
      host_state TEXT NOT NULL DEFAULT 'unknown',
      selected_member_id TEXT,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    , current_task_id TEXT);

CREATE TABLE qm_session_members (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES qm_sessions(id),
      node_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      root TEXT NOT NULL,
      source_root TEXT,
      mode TEXT NOT NULL,
      recovery_root TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      snapshot_revision INTEGER NOT NULL DEFAULT -1,
      snapshot_json TEXT,
      snapshot_updated_at TEXT,
      dirty_revision INTEGER NOT NULL DEFAULT 0,
      exported_revision INTEGER NOT NULL DEFAULT 0,
      projection_error TEXT,
      online INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      UNIQUE(session_id, node_id, root)
    );

CREATE TABLE qm_invocations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      transport_instance_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES qm_sessions(id),
      member_id TEXT NOT NULL REFERENCES qm_session_members(id),
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      operation_id TEXT,
      state TEXT NOT NULL,
      effect TEXT NOT NULL,
      result_ref TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(owner_id, transport_instance_id, request_id)
    );

CREATE TABLE qm_run_links (
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE, task_id TEXT,
      PRIMARY KEY(session_id, member_id, run_id)
    );

CREATE TABLE qm_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL, task_id TEXT,
      UNIQUE(session_id, source_id, event_type)
    );

CREATE TABLE qm_context_reads (
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      content_ref TEXT,
      read_count INTEGER NOT NULL DEFAULT 0,
      observed_at TEXT,
      PRIMARY KEY(session_id, member_id, actor_id, path, kind)
    );

CREATE TABLE qm_change_baselines (
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      baseline_ref TEXT NOT NULL,
      latest_ref TEXT NOT NULL,
      coverage TEXT NOT NULL,
      PRIMARY KEY(session_id, member_id, repo_root)
    );

CREATE TABLE qm_file_changes (
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      version_ref TEXT NOT NULL,
      file_id TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT NOT NULL,
      from_path TEXT,
      additions INTEGER,
      removals INTEGER,
      hash TEXT NOT NULL,
      large INTEGER NOT NULL DEFAULT 0,
      binary INTEGER NOT NULL DEFAULT 0,
      coverage TEXT NOT NULL,
      revertible INTEGER NOT NULL DEFAULT 0,
      patch_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, member_id, version_ref, file_id)
    );

CREATE TABLE qm_agent_observations (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider_turn_id TEXT,
      control_revision INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(session_id, agent_id)
    );

CREATE TABLE qm_agent_operations (
      operation_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE qm_run_checkpoints (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );

CREATE TABLE console_write_receipts (
      scope TEXT NOT NULL,
      request_key TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      state TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      PRIMARY KEY (scope, request_key)
    );

CREATE TABLE console_revert_previews (
      id TEXT PRIMARY KEY,
      data_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

CREATE TABLE qm_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES qm_sessions(id),
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active',
      start_sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      finished_at TEXT
    , request_key TEXT, result_status TEXT, summary TEXT);

CREATE TABLE qm_task_members (
      task_id TEXT NOT NULL REFERENCES qm_tasks(id),
      member_id TEXT NOT NULL REFERENCES qm_session_members(id),
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY(task_id, member_id)
    );

CREATE TABLE qm_task_snapshots (
      task_id TEXT NOT NULL REFERENCES qm_tasks(id),
      member_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY(task_id, member_id)
    );

CREATE TABLE qm_task_context (
      task_id TEXT NOT NULL REFERENCES qm_tasks(id),
      member_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY(task_id, member_id, path)
    );

CREATE INDEX workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

CREATE INDEX workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

CREATE INDEX loaded_agent_files_path_idx
      on loaded_agent_files(path);

CREATE INDEX oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

CREATE INDEX oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

CREATE INDEX oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

CREATE INDEX oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

CREATE INDEX oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);

CREATE INDEX local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

CREATE INDEX local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

CREATE INDEX local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);

CREATE INDEX workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);

CREATE INDEX execution_waiters_order on execution_waiters(sequence);

CREATE INDEX agent_context_affinity on local_agent_sessions
        (workspace_root, workspace_id, profile_name, work_item_id, context_key, context_signature);

CREATE INDEX console_runs_project on console_work_runs(project_id, created_at desc, id);

CREATE INDEX console_threads_project on console_threads(project_id, updated_at desc);

CREATE INDEX console_exec_run on console_executions(run_id, created_at);

CREATE INDEX console_exec_agent on console_executions(agent_id, created_at desc);

CREATE UNIQUE INDEX console_exec_provider_turn on console_executions(managed_thread_id, provider_turn_id)
      where provider_turn_id is not null;

CREATE UNIQUE INDEX console_item_identity on console_work_items(project_id, item_key);

CREATE UNIQUE INDEX console_run_identity on console_work_runs(item_id, run_key);

CREATE UNIQUE INDEX console_operation_identity on console_operations(run_id, request_key);

CREATE UNIQUE INDEX console_thread_identity on console_threads(instance_id, thread_id);

CREATE INDEX local_agent_turns_agent_id_idx
      on local_agent_turns(agent_id, id desc);

CREATE INDEX local_agent_turns_status_idx
      on local_agent_turns(status);

CREATE INDEX agent_control_events_agent_sequence
      on agent_control_events(agent_id, sequence desc);

CREATE INDEX console_sessions_expires_at_idx on console_sessions(expires_at);

CREATE INDEX execution_claim_reconciliations_claim_idx on execution_claim_reconciliations(claim_id);

CREATE UNIQUE INDEX qm_session_conversation
      ON qm_sessions(owner_id, conversation_id)
      WHERE conversation_id IS NOT NULL;

CREATE INDEX qm_event_session_sequence
      ON qm_events(session_id, sequence);

CREATE INDEX qm_file_changes_member
      ON qm_file_changes(session_id, member_id, path);

CREATE INDEX qm_agent_operations_session
      ON qm_agent_operations(session_id, member_id, updated_at);

CREATE INDEX console_runs_started ON console_work_runs(created_at DESC, id);

CREATE INDEX console_runs_project_status ON console_work_runs(project_id, status);

CREATE INDEX console_operations_run_status ON console_operations(run_id, status);

CREATE INDEX console_executions_run_status ON console_executions(run_id, status);

CREATE INDEX qm_run_links_member ON qm_run_links(member_id);

CREATE INDEX qm_tasks_session_created
      ON qm_tasks(session_id, created_at DESC);

CREATE INDEX qm_run_links_task
      ON qm_run_links(task_id, member_id);

CREATE INDEX qm_events_task_sequence
      ON qm_events(task_id, sequence);

CREATE UNIQUE INDEX qm_tasks_request_key ON qm_tasks(session_id,request_key) WHERE request_key IS NOT NULL;
