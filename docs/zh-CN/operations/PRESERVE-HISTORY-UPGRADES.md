# 保留未核实执行历史的升级

[English](../../operations/PRESERVE-HISTORY-UPGRADES.md)

本流程要求发行包与受审维护 provider 都实现 **preserve-v2** 协议。它只替换已核实的服务进程范围，保留尚未核实的执行记录及资源占用。该范围之外受保护的进程必须保持存活，且进程代次不变。

## 显式选择策略

| 策略 | 行为 |
| --- | --- |
| `prove`，默认 | 普通维护必须排空工作；显式外部 provider 可以提供受审的物理收尾证据。排空失败不会自动切换策略。 |
| `preserve`，显式选择 | 必须提供外部 provider，旧服务必须正在运行，并审核完整历史集合。未知结果和占用继续保留，不能据此声称节点已经空闲。 |

激活接口为：

```js
await activateInstallation(preparedManifest, {
  maintenanceLease: reviewedProvider,
  historyPolicy: "preserve",
});
```

`activateInstallation` 由 `node/install.mjs` 导出。`reviewedProvider` 必须实现已有的 `acquire`、`assertHeld`、`release` 合同。这段示例不是可独立执行的命令，也没有新增 `--force` 参数。安装器把策略固定在 version 2 context 中，provider 返回的版本与策略必须一致，不能单方面选择保留模式。

## 必须保持的边界

1. **取得准确的维护窗口。** 核实 prepared manifest、旧发行、节点、manager/Core 进程代次、准入暂停归属、完整执行对象及完整 claim 集合，并关闭相关入口。当前服务工作、队列、等待者及持久化 runtime work 必须排空；保留历史 claim 本身不代表满足这一条件。
2. **保留全部四次检查。** provider 必须在 `before_backup`、`after_backup`、`before_stop`、`after_stop` 提供新鲜的进程清点证据。官方数据库备份及每项身份、计数检查均不可省略。历史身份变化、减少或增加都会拒绝本次操作。域外受保护进程不属于停机范围。
3. **在暂停状态验证新代次。** installation transition 保持准入关闭。保留模式会延后启动核对和会话后台维护，避免验证之前改写受审历史。新 Core 必须报告正确的发行及运行时身份，并通过原有的连续稳定窗口。
4. **只验证保留，不记录完成。** 独立的 `verify-retained` 以只读方式打开 SQLite，将完整执行对象、claim 指纹及历史不确定状态计数，与安装器固定的身份进行比对。它不会调用物理收尾回执写入器，也不会删除 claim。`quiescent`、`idle` 的原有含义不变；即使升级成功，未知物理执行或 claim 仍可能使它们为 false。
5. **只释放自己持有的维护暂停。** 恢复准入前再次核对保留集合及受保护进程，确认准确的 transition 已释放、准入已恢复。随后继续正常核对；没有证明的 claim 不会仅因旧 owner 退出而释放。

### 数据库兼容必须明确

preserve-v2 inspection 返回 `protocolVersion: 2` 和 `claimFingerprintVersion: 2`。`retainableCommandClaims` 支持 schema version 16 及以上；唯一的规范化是准确对应 version 18 迁移：claim 中尚不存在的 `execution_id`、`execution_generation`、`owner_process_start` 三列按 `NULL` 计算，与该迁移新增可空列、没有回填的行为一致。

指纹仍覆盖完整 claim 行及其执行对象和 owner。已有值、新增非 `NULL` 值、任何字段变化，以及未审核的未来新增列都不会被忽略。默认 `prove` 指纹保持不变。必须重新采集并审核 preserve-v2 集合，不能沿用另一协议的指纹。

## 失败与后续恢复

尚未尝试停机时，补偿只能释放本次操作已经核实归属的 pause 和 transition。尝试停机后，`preserve` 激活失败会保留数据库、备份、租约及 `recovery_required` 记录。即使 schema version 相同，也**不会自动启动旧二进制**，因为它可能不认识保留模式的保护。若激活已经提交、只是恢复准入失败，则保留已验证的新服务，等待明确核对。

恢复必须依据保存的 attempt、manifest、数据库版本、备份及当前进程代次。重启服务或释放暂停之前，应重新审核状态；维护记录不会自动过期。

升级成功后，按原 Task、operation/execution、执行代次和物理证据逐条核对保留的 claim。仍然存活但安静的进程必须继续受到保护。业务结果、旧 owner 退出、Task 超过 30 分钟没有活动，都不是物理完成证明。30 分钟展示规则不会关闭 Task、停止进程或让资源占用过期。在准确的物理边界得到证明之前，保留的 claim 仍可能阻挡冲突工作。

实现入口：[安装与回滚](../../../node/install.mjs)、[租约检查](../../../node/maintenance-lease.mjs)、[只读验证](../../../node/maintenance-proof.mjs)、[历史身份](../../../src/maintenance-status.ts)。
