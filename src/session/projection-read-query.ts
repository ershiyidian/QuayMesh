import { openReadonlyDatabase } from '../db/client.js';
import { readExecutionClaims } from '../execution-inspection.js';
import { SessionStore } from './store.js';
import { SessionProjector } from './projection.js';
import { projectionIdentity } from './projection-read-identity.js';
import { sameProjectionIdentity, type ProjectionReadRequest, type ProjectionReadResult } from './projection-read-protocol.js';
import { readRevertEligibility } from './revert-read.js';

/** Invoked only in the bounded read child. All historical parsing, filesystem
 * observation and occupancy inspection share its deadline and readonly DB. */
export async function readSessionProjection(request:ProjectionReadRequest):Promise<ProjectionReadResult> {
  const database = openReadonlyDatabase(request.stateDir);
  try {
    database.sqlite.exec('BEGIN');
    const store = new SessionStore(database.sqlite), expected = request.identity;
    const actual = projectionIdentity(store,expected.sessionId,expected.memberId,expected.taskId??undefined,expected.nodeId);
    if (!sameProjectionIdentity(expected,actual)) throw Object.assign(new Error('projection_changed'),{code:'revision_conflict'});
    const snapshot = await new SessionProjector(store,request.stateDir,request.consoleUrl,undefined,request.localNodeId)
      .readSnapshot(expected.sessionId,expected.memberId,expected.taskId??undefined);
    const captureBlock = ():string|null => {
      const capture = request.capture;
      if (!capture || !capture.unchanged) return 'live_revert_not_observed';
      if (capture.state === 'pending') return '文件改动正在采集，请等待完成并刷新后重新确认撤销';
      if (capture.state === 'failed') return `文件改动采集失败，请处理后刷新并重新确认撤销${capture.error ? `：${capture.error}` : ''}`;
      return null;
    };
    const eligibility = actual.nodeId !== request.localNodeId
      ? {allowed:false,reason:'remote_member',revision:actual.memberRevision}
      : actual.sessionState === 'active'
      ? {allowed:false,reason:'session_active',revision:actual.memberRevision}
      : await readRevertEligibility(store,actual.sessionId,store.getMember(actual.sessionId,actual.memberId), {
        captureBlock,inspect:root => readExecutionClaims(database.sqlite,root),
      },new Set(),undefined,actual.taskId??undefined);
    snapshot.capabilities.revert = eligibility.allowed && eligibility.revision === snapshot.changeRev;
    snapshot.notices = snapshot.notices.filter(notice => !notice.startsWith('Revert unavailable: '));
    if (!snapshot.capabilities.revert && eligibility.reason) snapshot.notices.push(`Revert unavailable: ${eligibility.reason}`);
    return {identity:actual,capture:request.capture,snapshot};
  } finally {
    try {if (database.sqlite.inTransaction) database.sqlite.exec('ROLLBACK');}
    finally {database.close();}
  }
}
