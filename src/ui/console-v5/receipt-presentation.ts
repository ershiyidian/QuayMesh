import { receiptResponsePending } from '../../console-receipt-state.js';
import type { ActionReceipt } from './contracts.js';

const names:Record<ActionReceipt['state'],string>={started:'已接收，等待结果',completed:'请求结果已确认',rejected:'已拒绝',partial:'部分完成',unknown:'结果待核对'};
export function receiptLabel(receipt: ActionReceipt): string {
  if(receipt.state==='completed'&&receiptResponsePending(receipt.response))
    return /\/nodes\/[^/]+\/settings$|\/roots\/save$/.test(receipt.path)?'配置已保存，仍待应用':'请求已接收，执行待结束';
  return names[receipt.state] || receipt.state;
}
export function canQueryReceipt(receipt: ActionReceipt): boolean {
  return ['started','unknown','partial'].includes(receipt.state)||receiptResponsePending(receipt.response);
}
