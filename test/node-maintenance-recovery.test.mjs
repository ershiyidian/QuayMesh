import assert from 'node:assert/strict';
import test from 'node:test';
import { resumeAdmissionWithRetry, reconcileAbandonedMaintenance } from '../node/maintenance-recovery.mjs';

test('transient Core admission failure is retried idempotently',async () => {
  let attempts=0;
  const delays=[];
  const result=await resumeAdmissionWithRetry(async () => {
    if (++attempts<3) throw new Error('Core just restarted');
    return {ok:true};
  },{sleep:ms=>{delays.push(ms);return Promise.resolve();}});
  assert.deepEqual(result,{ok:true});
  assert.equal(attempts,3);
  assert.deepEqual(delays,[200,400]);
});

test('maintenance recovery does not silently lift a manual or shutdown pause',async () => {
  let resumed=0;
  for (const reason of ['operator', '服务正在退出',null]) {
    const recovered=await reconcileAbandonedMaintenance(
      async () => ({accepting:false,reason}),async () => {resumed++;});
    assert.equal(recovered,false);
  }
  assert.equal(resumed,0);
  assert.equal(await reconcileAbandonedMaintenance(
    async () => ({accepting:false,reason:'node-maintenance'}),
    async () => {resumed++;}),true);
  assert.equal(resumed,1);
});

test('exhausted resume retries reject instead of declaring work ready',async () => {
  let attempts=0;
  await assert.rejects(resumeAdmissionWithRetry(async () => {
    attempts++;throw new Error('Core still unavailable');
  },{attempts:3,sleep:async()=>{}}),/Core still unavailable/);
  assert.equal(attempts,3);
});
