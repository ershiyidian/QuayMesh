import assert from 'node:assert/strict';
import test from 'node:test';
import {compatibleToolReceipt} from '../src/bounded-reply.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';

for (const phase of ['preparing','dispatching','running']) {
  test(`旧 Worker 的 ${phase} 回执保留身份与状态，展示字段不污染协议`, () => {
    const reply:CallToolResult = {
      content:[{type:'text',text:'原操作已接收，请读取原结果。'}],
      structuredContent:{operation_id:'op_abcdef',accepted:true,running:true,result:'',state:'accepted',effect:'unknown',
        phase,message:'原操作已接收，请读取原结果。'},
      _meta:{quaymesh:{execution:{platform:'linux'}},other:'preserved'},
    };
    const fixed=compatibleToolReceipt(reply);
    assert.deepEqual(fixed.structuredContent,{operation_id:'op_abcdef',accepted:true,running:true,result:'',state:'accepted',effect:'unknown'});
    assert.deepEqual(fixed.content,reply.content);
    assert.deepEqual(fixed._meta,{quaymesh:{execution:{platform:'linux'},phase},other:'preserved'});
    assert.equal(reply.structuredContent?.phase,phase);
    assert.deepEqual(compatibleToolReceipt(fixed),fixed);
  });
}

test('不悄悄清除未知字段，不修改普通查询或失败结果', () => {
  for (const reply of [
    {content:[],structuredContent:{result:'ordinary',phase:'other',message:'preserve'}},
    {content:[],isError:true,structuredContent:{message:'actual error'}},
  ] satisfies CallToolResult[]) assert.equal(compatibleToolReceipt(reply),reply);
  const fixed=compatibleToolReceipt({content:[],structuredContent:{accepted:true,phase:'preparing',unadvertised:42}});
  assert.equal(fixed.structuredContent?.unadvertised,42);
});

test('旧 Worker 的资源冲突保持明确拒绝，严格客户端不会拿成功 schema 校验错误详情', () => {
  const error={code:'EXECUTION_CONFLICT',details:{operationId:'op_busy'},started:false};
  const result=compatibleToolReceipt({isError:true,content:[{type:'text',text:'执行资源暂时不可用。操作尚未开始。'}],
    structuredContent:{result:'conflict',error},_meta:{quaymesh:{request:'retained'}}});
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent,undefined);
  assert.deepEqual(result._meta,{quaymesh:{request:'retained',error}});
  assert.match((result.content[0] as {text:string}).text,/尚未开始/);
});
