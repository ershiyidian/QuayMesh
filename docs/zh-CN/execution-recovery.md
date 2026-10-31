# 恢复单条执行占用

[English](../execution-recovery.md)

资源占用属于一条命令或代理的一轮执行。执行结束后，Task 可以继续保持开放。输出缺失、业务结果未知等信息仍保留在执行历史中；确认物理结束后，只释放这次执行占用的资源。

用执行冲突返回的 `claim_id` 查询其归属：

```json
{"workspace_id":"qm:worker:ws_example","action":"recovery","claim_id":"claim_example","recovery_action":"inspect"}
```

调用 `workspace_context`，使用相同参数并将 `recovery_action` 改为 `"release"`，即可根据已有的完成证明释放这条占用。该操作不会停止进程、改变 Task 结果或暂停节点。返回的 `resource_recovery` 会标明所属 Task、命令或准确代理轮次，以及物理状态。

确实需要停止这次执行时，使用 `recovery_action: "stop"`。命令复用现有取消入口；代理按保存的提供方轮次编号中断，不会把停止请求交给同一代理的新一轮执行。命令停止可能需要时间，可以继续查询同一个 claim，直到资源释放。其他占用和进程继续运行。

`unknown` 表示结束证据不足，暂时不能释放。仅凭 owner PID 消失、等待超时、代理后续轮次成功或回执缺失，都不能代替物理完成证明。原结果继续保留，供后续核对。查询和恢复都会校验保存的 Task 所有者、节点和工作区关系。

普通 `read` 保留可查询的结果回执和文件上下文证据，不再创建业务执行或持久运行时占用。取消命令等控制请求仍保留自己的执行记录，即使旧记录使用了通用的 `read` 分类。

取消请求返回 `COMMAND_NOT_ATTACHED` 时，可用取消请求自身的 `operation_id` 和 `action: "recovery"` 检查。只有保存的本机调用、所属进程代次和完成事件能证明这次守卫在发送信号前返回，`recovery_action: "release"` 才会记录物理完成。原有未知业务结果、目标命令的全部占用都保持不变；其他取消错误仍待核对。此接口只有提供 `claim_id` 时才允许 `stop`。

Agent 中断请求已经派发但结果未确认时，恢复保留 `effect: "unknown"` 和 `retry_hint: "query_original"`。重放同一请求返回保存的结果，不再次发送中断。
