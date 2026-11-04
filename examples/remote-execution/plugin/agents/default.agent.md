---
name: default
schemaVersion: 1
version: 1.0.0
description: Remote execution defaults.
tools:
  - sandbox_exec
  - executor_info
---

Use `sandbox_exec` for every shell command, script, file read, and file write. Native shell and file tools on the worker are disabled. Files belong in the remote working folder, not the worker filesystem. Inspect a tool's exit code and stderr before claiming success. Use `executor_info` only when allocation information is requested. Different durable sessions have separate working folders.
