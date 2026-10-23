export const executionQuiescenceSchema = `
CREATE TABLE execution_quiescence (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK(domain IN ('operation','execution')),
  object_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  receipt_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  invalidated_at TEXT,
  UNIQUE(domain,object_id,fingerprint,receipt_id)
);
CREATE INDEX execution_quiescence_subject ON execution_quiescence(domain,object_id);
CREATE INDEX execution_quiescence_current ON execution_quiescence(domain,object_id) WHERE invalidated_at IS NULL;
CREATE INDEX console_operations_maintenance_status ON console_operations(status,id);
CREATE INDEX console_executions_maintenance_status ON console_executions(status,id);
CREATE TRIGGER execution_quiescence_operation_insert AFTER INSERT ON console_operations BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='operation' AND object_id=NEW.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_operation_update AFTER UPDATE ON console_operations BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='operation' AND object_id IN (OLD.id,NEW.id) AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_operation_delete AFTER DELETE ON console_operations BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='operation' AND object_id=OLD.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_execution_insert AFTER INSERT ON console_executions BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='execution' AND object_id=NEW.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_execution_update AFTER UPDATE ON console_executions BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='execution' AND object_id IN (OLD.id,NEW.id) AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_execution_delete AFTER DELETE ON console_executions BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain='execution' AND object_id=OLD.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_owner_insert AFTER INSERT ON execution_owners BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain=NEW.domain AND object_id=NEW.id AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_owner_update AFTER UPDATE ON execution_owners BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE ((domain=OLD.domain AND object_id=OLD.id) OR (domain=NEW.domain AND object_id=NEW.id)) AND invalidated_at IS NULL;
END;
CREATE TRIGGER execution_quiescence_owner_delete AFTER DELETE ON execution_owners BEGIN
  UPDATE execution_quiescence SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE domain=OLD.domain AND object_id=OLD.id AND invalidated_at IS NULL;
END;
`;
