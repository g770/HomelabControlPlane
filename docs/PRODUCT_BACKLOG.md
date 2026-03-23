# Product Backlog

## Instructions for AI Agents

This is a backlog of product features to be implmemented by an AI agent. Agents working on this backlog should work as follows:

- A parent agent will orchestrate the process. You are the parent agent.
- The parent agent MUST NEVER do research or write code.
- If the parent agent wants to look ahead or prepare work to help with tasks it MUST spawn research agents to do so.
- Subagents with the same model settings as the parent agent MUST spawned for each backlog item.
- Tasks that will produce code MUST be executed serially, there is no parallel execution of code modification tasks.
- When the work is complete, the subagent will make sure all tests pass and the quality bar for the repo is met.
- The subagent will check in their changes with a descriptive comment.
- When a subagent is complete it MUST write a report about the changes it made. This report will be written as markdown file in the agent-reports directory and checked in.
- The parent agent MUST update this file to move tasks to the completed list immediately after they are complete give the corresponding commit number.
- As items are moved to completed, the parent agent MUST commit changes to this file.
- When executing design tasks the rules in the DESIGN_TASK.md file must be followed.
- Design tasks CAN be executed in parallel.
- ONLY execute tasks that are in the open backlog items list.

## Open Backlog Items

## Completed Backlog Items

- [x] TASK-001: DESIGN TASK. Design support for ollama hosted models. Research how to integrate with ollama and make sure the user can select different AI API providers in the settings interface. Remember there is only one AI api configured at one time. Write a full plan to implement this as a markdown file in the docs folder. (`1b6d0b8`)
- [x] TASK-002: DESIGN TASK. Design a feature to show open AI useage and spend. The user should be able to view this in the settings menu. Write a detailed plan on how to implement this as a markdown file in the docs directory. (`65f2237`)
