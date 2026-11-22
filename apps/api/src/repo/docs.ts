import type { DossierJournalRow, PhaseKey } from "@learnsdlc/shared";
import { REPO_NO_FILES_LINE } from "@learnsdlc/shared";
import type { RepoTag } from "./history";

/**
 * The two documents the archive generates. The archive holds no index of the
 * learner's artefacts; these two are the only files it writes that the
 * learner did not.
 */

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** Small numbers as a person writes them, larger ones as digits. */
export function count(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

const on = (iso: string): string => {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? DATE.format(at) : "an unknown day";
};

export interface ReadmeInput {
  projectTitle: string;
  learnerName: string;
  exportedAt: string;
  /** How many phases the pack has. */
  phaseCount: number;
  /** The top-level directories the learner's own files ended up in. */
  directories: string[];
  phasesPassed: number;
  submissions: number;
  emptyCommits: number;
  tags: RepoTag[];
}

/** The README the first commit writes: what this is, before any of it exists. */
export function readmeStart(input: ReadmeInput): string {
  return [
    `# ${input.projectTitle}`,
    "",
    `${input.learnerName}'s project for ${input.projectTitle}, in LearnSDLC.`,
    "",
    "One commit for every submission, in your name, with the message you wrote on it.",
    "A tag at every gate you passed. The last commit rewrites this file with the counts.",
    "",
  ].join("\n");
}

/** The README the last commit writes: the same page, with the term behind it. */
export function readme(input: ReadmeInput): string {
  const directories = [...new Set(input.directories)].sort();
  const lines: string[] = [
    `# ${input.projectTitle}`,
    "",
    `${input.learnerName}'s project for ${input.projectTitle}, exported from LearnSDLC on ${on(input.exportedAt)}.`,
    "",
    // "no passed" is not a sentence, so nought gets its own word.
    (() => {
      const passed =
        input.phasesPassed === 0 ? "none" : count(input.phasesPassed);
      return `${count(input.phaseCount)} phases, ${passed} recorded as passed.`.replace(
        /^./,
        (c) => c.toUpperCase(),
      );
    })(),
    "",
    "## What is here",
    "",
  ];
  if (directories.length) {
    lines.push(
      `- ${directories.map((dir) => `${dir}/`).join(", ")} — your own files, at the paths you wrote them.`,
    );
  }
  lines.push(
    "- docs/journal.md — retained review, release and saved activity summaries, oldest first; visible runs are limited to the latest 200.",
  );
  lines.push("- .git/ — the history itself. Run git log inside this folder.");
  lines.push(
    "",
    "This archive contains retained submitted editable files, not a complete standalone application or an accredited completion certificate. Starter infrastructure, unsubmitted file drafts, private message text, and full review reports are excluded. The journal includes mentor request counts and saved design or incident summaries. Historical verdicts and override tags describe their original records; they do not certify current strict completion.",
  );
  lines.push("", "## The history", "");
  lines.push(
    `One commit for every submission, oldest first, in your name. ${count(input.submissions).replace(/^./, (c) => c.toUpperCase())} ${
      input.submissions === 1 ? "submission" : "submissions"
    } in all.`,
  );
  if (input.tags.length) {
    lines.push("", "A tag at every gate:", "");
    for (const tag of input.tags) {
      lines.push(
        `- ${tag.name}, ${tag.phaseTitle}, merged ${on(tag.createdAt)}`,
      );
    }
  } else {
    lines.push("", "No gate has been merged yet, so there are no tags.");
  }
  if (input.emptyCommits > 0) {
    lines.push(
      "",
      `Some commits change nothing. ${REPO_NO_FILES_LINE.replace(/^Files: not kept\. /, "")} An attempt without retained source is recorded by its message and verdict with no new files behind it.`,
    );
  }
  lines.push(
    "",
    "    git log --oneline",
    "    git tag -n",
    "    git show v1",
    "",
  );
  return lines.join("\n");
}

const STAMP = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

const stamp = (iso: string): string => {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "unknown";
  const parts = STAMP.formatToParts(at);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};

/** `docs/journal.md`: the dossier's own rows, oldest first, one line each. */
export function journalMarkdown(
  projectTitle: string,
  rows: DossierJournalRow[],
  titleOf: Map<PhaseKey, string>,
): string {
  const oldest = [...rows].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const lines = [
    "# Journal",
    "",
    `Retained review, release and saved activity summaries on ${projectTitle}, oldest first. Visible runs are limited to the latest 200. Mentor request counts are included; private message text is excluded.`,
    "",
  ];
  if (oldest.length === 0) lines.push("Nothing has happened yet.");
  for (const row of oldest) {
    const phase = titleOf.get(row.phaseKey) ?? row.phaseKey;
    const tail = [row.detail, row.result]
      .map((part) => (part ?? "").trim())
      .filter(Boolean);
    lines.push(
      `- ${stamp(row.at)} — ${phase} — ${row.title}${tail.length ? `. ${tail.join(". ")}` : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
