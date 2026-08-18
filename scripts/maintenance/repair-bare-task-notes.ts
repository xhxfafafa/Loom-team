import { pathToFileURL } from "node:url";

import { getRoutaSystem } from "../../src/core/routa-system";
import { repairBareTaskNotes } from "../../src/core/notes/repair-bare-task-notes";
import type { RepairBareTaskNotesResult } from "../../src/core/notes/repair-bare-task-notes";

/**
 * Repair tool for malformed bare task Notes (issue 2026-08-18).
 *
 * Bare task Notes carry `metadata.type === "task"` without any task-semantic
 * field (linkedTaskId, taskStatus, parentNoteId, or assignment) and are
 * really reports/research/QA/handoff documents. This tool reclassifies them
 * to `general`. It is dry-run by default, workspace-scoped (optionally
 * narrowed to one Team Run/session), and idempotent.
 *
 * Usage:
 *   node --import tsx scripts/maintenance/repair-bare-task-notes.ts --workspace default
 *   node --import tsx scripts/maintenance/repair-bare-task-notes.ts --workspace default --session <team-run-id> --apply
 */

interface Options {
  workspaceId?: string;
  sessionId?: string;
  apply: boolean;
  json: boolean;
}

function printUsage(): void {
  console.log(`Reclassify bare task Notes (type "task" without task semantics) to "general".

Usage:
  node --import tsx scripts/maintenance/repair-bare-task-notes.ts --workspace <id> [options]

Options:
  --workspace <id>   Required workspace scope
  --session <id>     Optional Team Run / session scope
  --apply            Apply the reclassification (default is dry-run)
  --json             Print machine-readable JSON
  --help, -h         Show this help
`);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { apply: false, json: false };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--workspace") options.workspaceId = next();
    else if (arg === "--session") options.sessionId = next();
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.workspaceId) {
    throw new Error("--workspace is required");
  }

  return options;
}

function printResult(result: RepairBareTaskNotesResult): void {
  const scope = result.sessionId
    ? `workspace ${result.workspaceId}, session ${result.sessionId}`
    : `workspace ${result.workspaceId}`;
  console.log(`Bare task note repair (${result.mode}) — ${scope}`);
  console.log(`Candidates: ${result.candidates.length}`);
  for (const candidate of result.candidates) {
    console.log(
      `  - ${candidate.noteId} | ${candidate.title} | workspace=${candidate.workspaceId}` +
        `${candidate.sessionId ? ` | session=${candidate.sessionId}` : ""}`,
    );
  }
  if (result.mode === "dry-run") {
    console.log("Dry-run: no changes were written. Re-run with --apply to reclassify.");
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseOptions(argv);
    const system = getRoutaSystem();
    const scope = {
      workspaceId: options.workspaceId!,
      sessionId: options.sessionId,
    };

    // Always review candidates first so identity fields are printed before any
    // change, including in apply mode.
    const preview = await repairBareTaskNotes(system.noteStore, scope);

    if (options.json) {
      const result = options.apply
        ? await repairBareTaskNotes(system.noteStore, { ...scope, apply: true })
        : preview;
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(preview);
      if (options.apply) {
        const applied = await repairBareTaskNotes(system.noteStore, { ...scope, apply: true });
        console.log(`Reclassified: ${applied.reclassified.length}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // One-shot maintenance script: exit explicitly because getRoutaSystem()
  // starts the workflow orchestrator and file-change bridge, whose timers
  // would otherwise keep the event loop alive after the repair completes.
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
