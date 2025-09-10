---
description: Built in tools
---

What Built-in Tools Are Available
Continue includes several built-in tools which provide the model access to IDE functionality.
​
What Tools Are Available in Plan Mode (Read-Only)
In Plan mode, only these read-only tools are available:
Read file (read_file)
Read currently open file (read_currently_open_file)
List directory (ls)
Glob search (glob_search)
Grep search (grep_search)
Fetch URL content (fetch_url_content)
Search web (search_web)
View diff (view_diff)
View repo map (view_repo_map)
View subdirectory (view_subdirectory)
Codebase tool (codebase_tool)
​
What Tools Are Available in Agent Mode (All Tools)
In Agent mode, all tools are available including the read-only tools above plus:
Create new file (create_new_file): Create a new file within the project
Edit file (edit_file): Make changes to existing files
Run terminal command (run_terminal_command): Run commands from the workspace root
Create Rule Block (create_rule_block): Create a new rule block in .continue/rules
All other write/execute tools for modifying the codebase