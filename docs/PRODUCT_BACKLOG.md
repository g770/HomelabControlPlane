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

- [x] TASK-036: Confirm the estimated cost of API usage is correct. I see an estimated usage of 47961 tokens and the cost is 0. (`665e539`)
- [x] TASK-031: DESIGN TASK. The widgets on the dashboard are still not a consistent size, even after the recent changes. This can be seen in the dashboard image file in the docs directory. Look back at TASK-017 and design a plan to properly fix this as a markdown file in the docs folder. (`8f43044`)
- [x] TASK-037: DESIGN TASK. Write a document explaining how the memory feature is implemented and used across the application. Explain how the memory is stored, what is added to it and when it is passed to openai calls. Also explain if there is a memory compaction system. Write this to a markdown file in the docs directory. (`6bc5c71`)
- [x] TASK-034: DESIGN TASK. In the drawdown strategy page I see text on the timeline that says "legacy fallback before first strategy". Explain what that is and how it works across the entire product. I think I also saw this in the simultion output. Write a markdown file explaining this concept. (`94b5dcd`)
- [x] TASK-035: DESIGN TASK. Write a document explaining how the failure analysis question influences the different stress tests that are run. The connection isn't clear and the user doesn't get a clear answer to their question. Write this investigation outcome to a markdown file in the docs directory. Also explain what should happen when you click "Run this stress test" on a specfic stress test. It seems to do nothing. (`4e66d6a`)
- [x] TASK-032: The timeline visualization is not correct. This is shown at the bottom of the timeline page. I added timeline events for income and expenses and the graph only shows bars for income. There should be bars going below 0 for the expenses. The file docs/timeline1.png shows this. (`73a5820`)
- [x] TASK-033: Fix the bulk AI account intake to clearly show failures to save. Right now a small message shows at the very bottom of the screen. The error should show up in an obvious place such as next to the save button. Also, there should be a second save button at the bottom of the parsed account descriptions, not just at the top. (`ff23968`)
- [x] TASK-030: On the account setup page remove this sentence: The password is hashed server-side and can be rotated later from the Security section in Settings. (`6bbc4a5`)
- [x] TASK-001: Remove the add memory activity as a dashboard widget (`4f541ca`)
- [x] TASK-002: Remove the add integration status as a dashboad widget (`ca0a0cf`)
- [x] TASK-003: The readiness checklist widget should have a wide option that spans the page, like it did previously and should be the first widget on the page (`96bd5b8`)
- [x] TASK-004: The net worth overview should be the first widget on the top left, below the readiness checklist (`018ce7d`)
- [x] TASK-005: Make the readiness checklist widget short and horizontally arranged blocks show the steps. Complete blocks should show a check mark. This is how this page looked before the recent large dashbaord changes. The repo has the history if needed. (`9dd8293`)
- [x] TASK-006: Each widget size should have fixed sizes. Right now some widgets are slightly taller or shorter than others (`38bf175`)
- [x] TASK-007: When you are viewing the dynamic floor and ceiling drawdown strategy, the target rate, floor and ceiling fields don't look like they are shown as percentages, they should be. (`80e9225`)
- [x] TASK-008: On the account page, each account tile shows the order in the upper right. These should never say "default order", it should always be a numerical order. (`6352186`)
- [x] TASK-009: When you enter the fields for an account description the dropdown menus for Type and Recurrance should have their options correctly capitialized (first letter) (`4156176`)
- [x] TASK-010: In the ai account intake I entered "Gross income of xxx per year". When the AI parsed this into the account fields, it did not set a tax classification, this should have been set to taxable ordinary income (`f900152`)
- [x] TASK-011: DESIGN TASK. Design a feature to manage AI API usage. This task MUST NOT change any code. The feature will live in Settings and allow the user to see their API usage and change the model used. Use the 5.4 extra high model to research and design this feature and write the plan to a markdown file in the docs directory. The plan must be detailed and structured to be executed by multiple agents. (`6dedcbe`)
- [x] TASK-012: When the Latest Simulation widget is on the dashboard, it seems to flash like it is refreshing the summary over and over. This widget should not be live refreshing any AI summary. It should use the one that was generated when the simulation was run. (`49c7fc4`)
- [x] TASK-013: When I start using the tool, sometimes I will click on a tab such as Scenarios or Failure Analysis and it will show a mostly blank screen that says "Checking session". Then 10-15 seconds later it will show the screen. Figure out the problem here and fix it. (`00f3f02`)
- [x] TASK-014: DESIGN TASK. On the timeline page, design a visualization that shows the timeline events over time. It should be a graph at the bottom of the page that shows time on the x axis and then shows shaded regions representing the different timeline events. Make sure to consider how to visually represent overlapping events. This task MUST NOT change any code. It must use the 5.4 extra high model for design and write the plan to a markdown file in the docs directory. The plan should be detailed and structured to be executed by multiple agents. (`9781bca`)
- [x] TASK-015: DESIGN TASK. On the drawdown page, design a visualization that shows the drawdown events over time. It should be a graph at the bottom of the page that shows time on the x axis and then shows shaded regions representing the different drawdown events. This task MUST NOT change any code. It must use the 5.4 extra high model for design and write the plan to a markdown file in the docs directory. The plan should be detailed and structured to be executed by multiple agents. (`d510f20`)
- [x] TASK-016: On the sign in page the welcome and sign in buttons at the top right flash back and forth quickly. Fix this (`64d5ed2`)
- [x] TASK-017: Widgets on the dashboard are still too tall and have varying heights. There should be fixed sizes for widgets that are 1x1, 2x2, 3x3, 2x1, 3x1. There are in the format of width x height. These need to be mapped to actual pixel dimensions and then each widget must conform to these specs. (`7da898d`)
- [x] TASK-018: When I go to the dashboard sometimes it seems to pause for many seconds while it shows "loading layout". Investigate why this is so slow and fix it. If this is due to some background API call, this needs to be fixed so it is not blocking. (`7da898d`)
- [x] TASK-019: Some widget say "Core Widget" on them. Remove this text (`bc0018b`)
- [x] TASK-020: Change the net worth overview widget to only show the household balance, remove the accounts and timeline events boxes. (`7b3103b`)
- [x] TASK-021: The latest simultion widget should not support a small setting, just medium and large (`f396289`)
- [x] TASK-022: Implement the plan in the file docs/TASK-011-ai-api-usage-management-plan.md (`e914177`)
- [x] TASK-023: Implement the plan in the file docs/TASK-014-timeline-visualization-plan.md (`a558049`)
- [x] TASK-024: Implement the plan in the file docs/TASK-015-drawdown-visualization-plan.md (`834e989`)
- [x] TASK-025: Fix the width of widgets on the dashboard. See the file docs/dashboard1.png for an example. The widgets don't fill the size of the window and they are not aligned with top 2 boxes. (`a00661c`)
- [x] TASK-026: On the dashboard screen, in the box called Control Center, there is text that says 0/4 readiness steps complete. Remove this text. (`54b310a`)
- [x] TASK-027: If you don't have an AI key configured, featured that need it should show as disabled. (`638c20c`)
- [x] TASK-028: The timeline visualization at the bottom of the accounts page isn't correct. It has a box at the top that says "Age Axis" and shows nothing. Age should be an axis label below the graphs. Change the representation to be stacked bars for each year, where each bar in the stack is one of the income or expense items. (`2a75bef`)
- [x] TASK-029: Implement the plan in the file docs/ai-request-id-fix-plan.md (`10251d8`)
