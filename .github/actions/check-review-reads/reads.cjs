// Which files of a review's to-read list the leg's own transcript shows as
// read. The model's files_read is its word; this reads the CLI's stream-json
// messages (run-claude-cli's execution file, one per chunk) for the Read
// calls of the review and its subagents, and takes the line numbers each
// Read result printed. A listed file is read only when, in the transcript of
// the review that holds it, Read results printed every non-empty line of each
// of its sections in a diff file the job wrote. Anything this cannot parse or
// match counts as not read.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// A Read result's line: its number, then a tab (or, in older CLIs, an arrow).
const NUMBERED = /^ *([1-9][0-9]{0,8})(?:\t|→)/u;
// Paths printed in a log line or kept by name in the coverage: publish-review's
// DATA_PATH. Any other path is counted only.
const PLAIN_PATH = /^[A-Za-z0-9._/@+-]{1,500}$/u;
const NAMED = 50;
const MAX_REVIEW_BYTES = 100000;
const UNCHECKED = "the job could not check which files the review read";
const UNLISTED = "the job could not list the files the review had to read";

/** Each `diff --git` section: its line range, header, rename target, text and non-empty lines. */
function diffSections(text) {
	const lines = String(text).split("\n");
	if (lines.at(-1) === "") lines.pop();
	const sections = [];
	lines.forEach((line, i) => {
		if (line.startsWith("diff --git ")) {
			sections.push({ start: i + 1, header: line, lines: [] });
		}
		sections.at(-1)?.lines.push(line);
	});
	return sections.map((s) => {
		let renameTo;
		for (const line of s.lines.slice(1)) {
			if (line.startsWith("@@") || line.startsWith("--- ")) break;
			if (line.startsWith("rename to "))
				renameTo = line.slice("rename to ".length);
		}
		return {
			start: s.start,
			end: s.start + s.lines.length - 1,
			header: s.header,
			renameTo,
			text: s.lines.join("\n"),
			required: s.lines.flatMap((line, i) =>
				line === "" ? [] : [s.start + i],
			),
		};
	});
}

// One file name as the check compares it: resolved against the workspace,
// symlinks followed when it exists.
function fileKey(workspace, file) {
	const resolved = path.resolve(workspace, file);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

const resultText = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.map((block) =>
						block?.type === "text" && typeof block.text === "string"
							? block.text
							: "",
					)
					.join("\n")
			: "";

/** The line numbers Read results printed, per file, over every message (main thread and subagents). */
function linesShown(messages, workspace) {
	const shown = new Map();
	if (!Array.isArray(messages)) return shown;
	const blocks = (role) =>
		messages.flatMap((m) =>
			m?.type === role && Array.isArray(m.message?.content)
				? m.message.content
				: [],
		);
	const reads = new Map();
	for (const block of blocks("assistant")) {
		if (
			block?.type === "tool_use" &&
			block.name === "Read" &&
			typeof block.input?.file_path === "string"
		) {
			reads.set(block.id, fileKey(workspace, block.input.file_path));
		}
	}
	for (const block of blocks("user")) {
		if (
			block?.type !== "tool_result" ||
			block.is_error === true ||
			!reads.has(block.tool_use_id)
		)
			continue;
		const file = reads.get(block.tool_use_id);
		if (!shown.has(file)) shown.set(file, new Set());
		for (const line of resultText(block.content).split("\n")) {
			const match = NUMBERED.exec(line);
			if (match) shown.get(file).add(Number(match[1]));
		}
	}
	return shown;
}

// The text of a diff file the job wrote: a regular file, never a link.
function diffFile(workspace, file) {
	try {
		const full = path.resolve(workspace, file);
		if (!fs.lstatSync(full).isFile()) return null;
		return {
			key: fileKey(workspace, file),
			sections: diffSections(fs.readFileSync(full, "utf8")),
		};
	} catch {
		return null;
	}
}

// The sections of `sections` a listed path names: its header ends with the
// path's b side (git's quoted form when the list quotes it), or a rename
// names it.
function owns(section, listed) {
	if (section.renameTo === listed) return true;
	if (listed.startsWith('"'))
		return section.header.endsWith(` "b/${listed.slice(1)}`);
	return section.header.endsWith(` b/${listed}`);
}

/**
 * The listed paths with no read evidence. scopeDiff is the diff the job wrote
 * for the scope; each review gives the extra diff files it was handed (its
 * chunk) and the lines its own transcript showed. alternates are diff files
 * any review may have read a section in. A section counts only where its text
 * is the scope diff's own.
 */
function checkReads({
	workspace,
	toRead,
	scopeDiff,
	reviews,
	alternates = [],
}) {
	const scope = diffFile(workspace, scopeDiff);
	if (!scope) return { unread: [...toRead] };
	const shared = [
		scope,
		...alternates.map((file) => diffFile(workspace, file)).filter(Boolean),
	];
	const handed = reviews.map((review) =>
		(review.diffs ?? []).map((file) => diffFile(workspace, file)),
	);
	const claims = new Map(
		toRead.map((listed) => [
			listed,
			scope.sections.filter((s) => owns(s, listed)),
		]),
	);
	const claimed = new Map();
	for (const sections of claims.values()) {
		for (const s of sections) claimed.set(s, (claimed.get(s) ?? 0) + 1);
	}
	const covered = (section, review, i) => {
		const files = [...shared, ...handed[i].filter(Boolean)];
		return files.some((file) => {
			const lines = review.shown.get(file.key);
			return (
				lines !== undefined &&
				file.sections.some(
					(s) =>
						s.text === section.text && s.required.every((n) => lines.has(n)),
				)
			);
		});
	};
	const holds = (i, section) =>
		reviews.length === 1 ||
		handed[i].some((file) =>
			file?.sections.some((s) => s.text === section.text),
		);
	const read = (listed) => {
		const sections = claims.get(listed);
		return (
			sections.length > 0 &&
			sections.every(
				(section) =>
					claimed.get(section) === 1 &&
					reviews.some(
						(review, i) => holds(i, section) && covered(section, review, i),
					),
			)
		);
	};
	return { unread: toRead.filter((listed) => !read(listed)) };
}

// A job-written list: a regular file of one path per line.
function listOf(workspace, file) {
	try {
		const full = path.resolve(workspace, file);
		if (!fs.lstatSync(full).isFile()) return null;
		const lines = fs.readFileSync(full, "utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines;
	} catch {
		return null;
	}
}

function transcript(file) {
	try {
		if (file === "" || !fs.lstatSync(file).isFile()) return [];
		const messages = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(messages) ? messages : [];
	} catch {
		return [];
	}
}

const WHOLE = /^(?:0|[1-9][0-9]{0,5})$/u;

/** The step: the extract step's review with its read count held to the files the transcripts show read. */
function main(
	env = process.env,
	{ write = (line) => process.stdout.write(`${line}\n`) } = {},
) {
	const output = (values) =>
		fs.appendFileSync(
			env.GITHUB_OUTPUT,
			Object.entries(values)
				.map(([name, value]) => `${name}=${value}\n`)
				.join(""),
		);
	const verdict = env.VERDICT ?? "";
	if (verdict !== "complete") return output({ verdict: verdict || UNCHECKED });
	let review;
	try {
		review = JSON.parse(env.REVIEW ?? "");
	} catch {
		return output({ verdict: UNCHECKED });
	}
	const coverage = review?.coverage;
	const workspace = env.GITHUB_WORKSPACE || process.cwd();
	const chunks = /^[1-9][0-9]{0,5}$/u.test(env.CHUNKS ?? "")
		? Number(env.CHUNKS)
		: 0;
	if (
		!Number.isSafeInteger(coverage?.changed) ||
		!Number.isSafeInteger(coverage?.read) ||
		chunks === 0 ||
		!WHOLE.test(env.SKIPPED ?? "")
	) {
		return output({ verdict: UNCHECKED });
	}
	// With copies or verified renames counted as read, the list the full-diff
	// step wrote without them; it reports a count only for a list it wrote.
	const skipped = Number(env.SKIPPED);
	const toRead =
		skipped > 0
			? WHOLE.test(env.TO_READ ?? "")
				? listOf(workspace, env.TO_READ_FILE)
				: null
			: listOf(workspace, env.FILE_LIST);
	if (
		toRead === null ||
		toRead.length !== coverage.changed - skipped ||
		(skipped > 0 && toRead.length !== Number(env.TO_READ))
	) {
		return output({ verdict: UNLISTED });
	}
	const files = [env.EXECUTION_FILE ?? ""];
	for (let k = 2; k <= chunks; k++)
		files.push(
			env.RESULTS_DIR
				? path.join(env.RESULTS_DIR, `chunk-${k}`, "execution.json")
				: "",
		);
	const { unread } = checkReads({
		workspace,
		toRead,
		scopeDiff: env.SCOPE_DIFF,
		alternates: [path.join(env.CHUNK_DIR, "distinct.diff")],
		reviews: files.map((file, i) => ({
			diffs:
				chunks > 1 ? [path.join(env.CHUNK_DIR, `chunk-${i + 1}.patch`)] : [],
			shown: linesShown(transcript(file), workspace),
		})),
	});
	write(
		`::notice title=pr-review-cli reads::listed=${toRead.length} unread=${unread.length}`,
	);
	if (unread.length > 0) {
		const named = unread
			.filter((name) => PLAIN_PATH.test(name))
			.slice(0, NAMED);
		const more = unread.length - named.length;
		const names = [named.join(", "), more > 0 ? `${more} more` : ""]
			.filter(Boolean)
			.join(" and ");
		write(
			`::warning title=pr-review-cli reads::no Read showed the whole change of ${unread.length} listed file(s): ${names}`,
		);
		const read = Math.min(coverage.read, coverage.changed - unread.length);
		review.coverage = {
			...coverage,
			read,
			...(named.length > 0 ? { unread_files: named } : {}),
		};
		// The extract step's cap on what leaves the job; the names go first.
		if (Buffer.byteLength(JSON.stringify(review), "utf8") > MAX_REVIEW_BYTES)
			review.coverage = { ...coverage, read };
	}
	output({ verdict: "complete", review: JSON.stringify(review) });
}

module.exports = { checkReads, diffSections, linesShown, main };

if (require.main === module) {
	try {
		main();
	} catch (error) {
		process.stdout.write(
			`::error::check-review-reads: the check failed (${error.name})\n`,
		);
		process.exitCode = 1;
	}
}
