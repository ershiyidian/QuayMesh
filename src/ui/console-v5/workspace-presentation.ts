import logo from '../../../app.ico';
import { esc,status,smallTime } from './presentation.js';
import { icon } from './icons.js';
import type { Run,Sessions } from './contracts.js';

export const brand = (size=32) => `<img class="brand-image" src="${logo}" width="${size}" height="${size}" alt="QuayMesh">`;

export function workspaceSummary(run:Run):string {
  const members=run.workspaces?.length ? run.workspaces : [{nodeId:run.nodeId,projectId:run.projectId,memberId:run.memberId,name:run.projectName,root:run.root}];
  const label=members.length===1 ? members[0]!.name : `${members.length} 个工作区`;
  return `<details class="workspace-disclosure" data-key="scope-${esc(run.id)}"><summary title="${esc(members.map(m=>m.nodeId+' · '+m.root).join('\n'))}">${icon('workspaces',12)}<span>${esc(label)}</span>${icon('down',12)}</summary><div class="workspace-popover">${members.map(member=>`<div><button type="button" class="run-title" data-action="project-tasks" data-id="${esc(member.projectId)}">${esc(member.name)}</button><span class="badge">${esc(member.nodeId)}</span><code>${esc(member.root)}</code><button type="button" class="icon-btn" data-action="copy" data-text="${esc(member.root)}" aria-label="复制工作区路径">${icon('copy',14)}</button></div>`).join('')}</div></details>`;
}

export function conversationCards(conversations:Sessions['conversations']):string {
  if(!conversations.length)return '<div class="empty"><h3>暂无会话</h3></div>';
  return `<div class="conversation-list">${conversations.map(session=>`<article class="conversation" data-key="conversation-${esc(session.id)}"><header><div><h3>${esc(session.title)}</h3><div class="run-sub"><span>${session.taskCount} 个任务</span>${session.activeCount ? `<span class="accent">${session.activeCount} 项运行</span>`:''}<code title="${esc(session.id)}">${esc(session.id.slice(0,8))}</code></div></div>${smallTime(session.updatedAt)}</header><details><summary>查看任务 ${icon('down',14)}</summary><div>${session.tasks.map(task=>`<button class="conversation-task" type="button" ${task.hasRun ? `data-action="open-run" data-id="${esc(task.id)}"` : 'disabled title="尚无执行记录"'}><span>${esc(task.title)}</span>${status(task.status)}${smallTime(task.finishedAt ?? task.startedAt)}</button>`).join('')}</div></details></article>`).join('')}</div>`;
}
