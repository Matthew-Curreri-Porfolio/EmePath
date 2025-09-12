<AGENT_PATTERN id="rapid-whoogle-investigation" v="2025-09-12">
  <GOAL>Make a brief TODO plan, inspect relevant gateway/tools files, probe Whoogle locally, propose a minimal fix, verify with tests, and report.</GOAL>

  <DEFAULTS>
    env.WHOOGLE_BASE = "http://127.0.0.1:5010"
    terminal.isBackground = true
    planning.max_bullets = 4
    trace.max_lines = 5
    reflection.tokens = 128
    debates.enabled = false
  </DEFAULTS>

  <FLOW>
    1. TODOS — Call manage_todo_list.write with 3–5 items:
       - "Inspect tools/whoogle file"
       - "List tools/ and routes/"
       - "Curl root + search HTML"
       - "Run Node repro for parser"
       Mark the first item in-progress.

    2. ENUMERATE — list_dir("/oss-codex/gateway/tools"), list_dir("/oss-codex/gateway/routes")

    3. READ — read_file("/oss-codex/gateway/tools/action/whoogle.js", 1, 400)
             read_file("/oss-codex/gateway/routes/index.js", 1, 240)

    4. PROBE HTML — run_in_terminal:
       - curl -sS -D - ${WHOOGLE_BASE}/ -o /tmp/whoogle_root.html
       - curl -sS "${WHOOGLE_BASE}/search?q=example&gbv=1&safe=off" -o /tmp/whoogle_search.html
       Then grep_search on /tmp/whoogle_search.html for anchors/classes and show the first 40 hits.

    5. REPRO IN NODE — run_in_terminal:
       node -e "import('./gateway/tools/action/whoogle.js').then(m=>m.searchWhoogle('example',{base:process.env.WHOOGLE_BASE})).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>console.error(e))"

    6. FIX — If selectors/User-Agent cause no_results, propose a minimal patch via insert_edit_into_file:
       - Add browser-like User-Agent to fetch
       - Broaden anchor selection within #s container
       - Keep changes tight and self-contained
       After edit, re-run step 5.

    7. VERIFY — If tests exist, runTests (targeted). Otherwise, repeat curl/Node repro and confirm non-empty results.

    8. REPORT — Output:
       <TRACE> condensed steps + key observations </TRACE>
       <FINDINGS> root cause in 1–2 lines </FINDINGS>
       <RECOMMENDED_FIX> bullet list of edits </RECOMMENDED_FIX>
       <VERIFY> commands + pass/fail </VERIFY>
       <NEXT> one concrete next action </NEXT>
  </FLOW>

  <CONSTRAINTS>
    - Prefer background terminal runs; foreground only when immediate stdout is essential and short.
    - Do not dump large HTML; sample head and a few result blocks.
    - Use absolute paths in all tool calls.
    - Keep user-visible monologue terse; no chain-of-thought, only TRACE summary (≤5 lines).
  </CONSTRAINTS>
</AGENT_PATTERN>
