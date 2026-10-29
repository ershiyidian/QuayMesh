# Task status in the Console

[English](CONSOLE-TASK-STATUS.md) · [简体中文](zh-CN/CONSOLE-TASK-STATUS.md)

The main Task badge describes the saved work goal. An open Task remains **in progress** when no command is running, after an experimental command fails, or while the next step is being decided. This badge does not claim that a model or process is currently executing.

Background execution, result acceptance and source freshness are separate facts:

| Evidence | Display |
| --- | --- |
| Open Task, no active background command | In progress, with no background execution as a secondary badge |
| Open Task, failed command | In progress, with the execution failure as a secondary badge |
| Result confirmation pending or failed | The saved confirmation state, with any background execution shown separately |
| Closed Task with a saved result | The saved result; a late running or unknown execution receipt remains visible as a secondary badge |
| Old or unavailable source observation | Last confirmed, independently of the saved Task lifecycle |

The **In progress** and **Ended** Task scopes filter the saved `active` and `closed` states. **Background execution** filters running, stopping or queued work. These scopes intentionally differ: a closed Task can still have a background receipt that needs attention.

The lifecycle selector remains available beside an opened Task inspector. Changing the list scope does not retarget the inspector or a pending action. Changing the lifecycle scope returns the list to its first page. Counts for the open and closed scopes are calculated from the same surrounding machine, project, search and time scope, so selecting one does not make the other count become zero.

Recent time ranges retain open Tasks even when they began before the range. An explicitly selected calendar date still restricts the result. Historical records without a reliable Task lifecycle remain visible under **All** and their known execution filters; the Console does not invent an open or closed state for them.

The overview's background execution totals continue to count actual execution observations. The recent execution results section can therefore contain an open Task with a completed or failed execution phase. Its main badge continues to show the Task lifecycle.

The read API accepts `requestState=active` or `requestState=closed` on the existing runs endpoint, for example:

```text
/console/api/v4/runs?requestState=active&days=7&limit=25
```

An execution state such as `running` is not a valid `requestState`. Page cursors belong to their original filters; do not reuse an active-scope cursor for a closed-scope request.
