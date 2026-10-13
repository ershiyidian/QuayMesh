---
name: subagents
description: Use when a task benefits from independent implementation, investigation, or review.
---

# Subagents

Give each agent a focused task, relevant paths, constraints, and the expected result.
Use spawn_agent for independent work and followup_agent for related work in an existing agent.
Do useful, non-overlapping work while agents run. Use wait_agent when their result blocks the next step.
Use send_message to guide an active agent and interrupt_agent to stop its current work.
Read returned results before relying on them. Keep project instructions and the requested scope.
