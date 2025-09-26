Rooms are the core domain. A room is a coordinated interaction between agents to produce an outcome for a task.

Key pieces:

- protocols/: schemas for task, message, outcome, consensus
- controllers/: dispatcher and aggregator to route and combine results
- runners/: execution loops (scheduler/watchdog)
- impl/: concrete rooms (e.g., brainstorm, consensus)

Contracts are intentionally minimal at this stage to unblock smoke tests.
