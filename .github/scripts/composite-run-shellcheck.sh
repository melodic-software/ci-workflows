# shellcheck shell=bash
# Run ShellCheck over the shell embedded in composite action `run:` blocks.
#
# Neither existing lane sees that shell. actionlint's docs state that `steps` in
# a composite action's metadata "is not checked at this point", and passing an
# action.yml on its command line makes actionlint parse the file as a workflow
# and fail with `"jobs" section is missing`; the upstream request for it is
# still open (linked below). The shellcheck lane discovers *.sh/*.bash, so
# YAML-embedded shell is invisible to it too.
#
# This extracts each bash/sh `run:` block and hands it to ShellCheck under the
# same contract actionlint applies to workflow `run:` blocks, so a step is
# judged identically whether it lives in a workflow or a composite. It also
# makes the in-place `# shellcheck disable=` directives those blocks already
# carry take effect.
#
# Refs: https://github.com/rhysd/actionlint/blob/main/docs/checks.md
#       https://github.com/rhysd/actionlint/blob/main/rule_shellcheck.go
#       https://github.com/rhysd/actionlint/issues/46
#
# Usage: bash .github/scripts/composite-run-shellcheck.sh [action.yml ...]
# Run from the repository root; each path must be repo-relative. With no
# arguments, every tracked .github/actions/*/action.yml is checked.
#
# Requires shellcheck on PATH — the ci.yml lane action installs a pinned,
# checksum-verified one — and yq (mikefarah, preinstalled on ubuntu-24.04),
# which is the same exception tool-version-drift-check.yml takes rather than
# the pinned install standards-sync.yml performs.
set -euo pipefail

# GitHub expands `${{ }}` before the runner writes the step script, so a raw
# block is not valid shell on its own. Each expression becomes a same-width run
# of underscores, following actionlint's sanitizeExpressionsInScript: the width
# keeps reported columns aligned with the action.yml source, and
# underscores (rather than blanks) keep constructs such as `if ${{ x }}; then`
# syntactically whole. The whole block is processed at once so an expression
# spanning lines is handled, and an unterminated `${{` is left intact to be
# reported rather than silently mangled.
#
# Where the span ends is decided the way GitHub's own runner decides it, not the
# way actionlint does. actionlint takes the next `}}` verbatim; the runner scans
# for it while toggling on `'` — the only string delimiter a GitHub expression
# has, double quotes being an error — so a `}}` inside a literal cannot end the
# span. Taking the next one truncates the expression and leaks the literal's
# remainder into the script, whose unbalanced quoting makes ShellCheck stop
# analysing the file: every real finding after it is masked, and the parse error
# reported instead points at synthesized underscores.
# Ref: actions/runner, TemplateReader.ParseScalar (`inString`).
#
# An unterminated `${{` has no runner behaviour to follow: ParseScalar fails the
# whole document, so GitHub rejects the shape as a workflow-parse error and it
# never reaches a real action. What happens to it here is therefore this
# check's own choice, made for diagnosability. A second unquoted `${{` is taken
# as proof the first never closed, so the scan stops there rather than running
# on to a later span's `}}` and underscoring a well-formed expression along with
# the broken text. Substitution resumes past the opener, leaving only the
# opener itself in the extracted script for ShellCheck to report (SC1073).
#
# An unterminated `'` is the one broken shape still able to consume text, and
# only when a later odd quote re-opens the scan and a `}}` arrives before any
# unquoted `${{`. Bounding it would take a rule about whether an expression
# string literal may cross a newline, which the runner does not state; it is
# left as an accepted limitation on the same ground as the opener above — the
# document does not parse, so no real action reaches this code.
#
# A newline inside a span is likewise preserved rather than overwritten, so the
# substitution is equal-length per line rather than equal-length overall and the
# banner below holds for a block containing a multi-line expression. actionlint
# overwrites it and documents the resulting shift as known; here the shift would
# be silent, since nothing downstream reconciles a reported line against the
# action.yml source. The cost is that a span broken across lines is two shell
# words rather than one, which can itself produce a finding — the deliberate
# trade, because a wrong line number is silent and a bogus finding is loud.
sanitize_expressions() {
  # A literal quote cannot appear inside the single-quoted shell string holding
  # the awk program, so the character the scan pivots on is passed in rather
  # than written as the octal escape awk would otherwise need.
  awk -v quote="'" '
    # Equal length per line: every byte of the span becomes an underscore except
    # a newline, which stays a newline.
    function fill(span) {
      gsub(/[^\n]/, "_", span)
      return span
    }

    # The index of the close marker ending the span opened at `s`, or 0 when
    # that opener is unterminated. Scanning starts just past the opener, so its
    # own trailing `{` can never be read as the first half of a close marker. A
    # doubled quote — the expression syntax escape for a literal one — toggles
    # twice and so is inert, which is exactly how the runner absorbs it.
    function span_end(text, s,   n, i, c, quoted) {
      n = length(text)
      for (i = s + 3; i <= n; i++) {
        c = substr(text, i, 1)
        if (c == quote) {
          quoted = !quoted
        } else if (quoted) {
          continue
        } else if (c == "}" && substr(text, i - 1, 1) == "}") {
          return i
        } else if (substr(text, i, 3) == "${{") {
          return 0
        }
      }
      return 0
    }

    { src = src $0 ORS }
    END {
      out = ""
      while ((s = index(src, "${{")) > 0) {
        e = span_end(src, s)
        if (e == 0) {
          out = out substr(src, 1, s + 2)
          src = substr(src, s + 3)
          continue
        }
        out = out substr(src, 1, s - 1) fill(substr(src, s, e - s + 1))
        src = substr(src, e + 1)
      }
      printf "%s%s", out, src
    }
  '
}

files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then
  mapfile -d '' -t files < <(git ls-files -z -- '.github/actions/*/action.yml')
fi
if [[ ${#files[@]} -eq 0 ]]; then
  echo '::error::composite-run-shellcheck: no composite action metadata files to check.'
  exit 1
fi

# Each path is reused verbatim as the extracted script's location under the
# temp workdir and as the argument ShellCheck is given after cd'ing there, so
# the two only coincide for a repo-relative path. An absolute one writes under
# the workdir but is read from the real filesystem root — ShellCheck reports a
# bogus "does not exist" and never lints. A `..` one resolves outside the
# workdir entirely, past the cleanup trap. git ls-files only ever yields the
# safe form; this guards the documented explicit-argument form.
for file in "${files[@]}"; do
  case "$file" in
  /* | [A-Za-z]:[/\\]*) reason='an absolute path' ;;
  .. | ../* | */.. | */../*) reason='a path with a ".." component' ;;
  *) continue ;;
  esac
  echo "::error::composite-run-shellcheck: '$file' is $reason; each argument must be a repo-relative path — run from the repository root."
  exit 1
done

workdir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/composite-run-shellcheck.XXXXXXXX")"
trap 'rm -rf -- "$workdir"' EXIT

bash_scripts=()
sh_scripts=()
for file in "${files[@]}"; do
  # Announced for every file discovery reaches, before any shape check can skip
  # it, so the coverage floor can distinguish "discovery missed this action"
  # from "this action has no shell to check". A composite whose steps are all
  # `uses:` is legitimate and emits no step line of its own.
  printf 'visit %s\n' "$file"

  using="$(yq -r '.runs.using // ""' "$file")"
  if [[ "$using" != composite ]]; then
    printf 'skip %s: runs.using is %s, not composite\n' "$file" "${using:-<unset>}"
    continue
  fi

  # Counted with an expression independent of the extraction query below, so a
  # selector that silently matches nothing is caught rather than passing as a
  # zero-block success — the false green this check exists to prevent.
  expected="$(yq -r \
    '[.runs.steps[] | select(has("run")) | select((.shell // "") | test("^(bash|sh)( |$)"))] | length' \
    "$file")"
  produced=0

  while IFS=$'\t' read -r index shell; do
    [[ -n "$index" ]] || continue

    # `.key` is a sequence index only while `runs.steps` is a sequence. A
    # mapping makes it an arbitrary author-supplied string, and this runs
    # against pull-request content, so reject the shape at the boundary rather
    # than escaping it at each use: $index reaches both the write path below
    # and an interpolated yq expression.
    if [[ ! "$index" =~ ^[0-9]+$ ]]; then
      echo "::error file=$file::composite-run-shellcheck: runs.steps is not a sequence (key '$index')."
      exit 1
    fi

    # actionlint's own dialect resolution (rule_shellcheck.go): the bare names,
    # plus GitHub's custom-shell form `command [...options] {0}`, whose dialect
    # is the leading command word. Matching only the bare names would leave a
    # block GitHub runs with bash unchecked while the job stayed green — the
    # coverage hole this check exists to close. Only the case sees the raw
    # scalar; everything downstream uses the resolved dialect, so no option text
    # reaches a filename.
    case "$shell" in
    bash | 'bash '*) dialect='bash' ;;
    sh | 'sh '*) dialect='sh' ;;
    '')
      echo "::error file=$file::composite-run-shellcheck: runs.steps[$index] has a run: block with no shell:; refusing to guess the dialect."
      exit 1
      ;;
    *)
      printf 'skip %s runs.steps[%s]: shell is %s, not bash/sh\n' "$file" "$index" "$shell"
      continue
      ;;
    esac

    relative="$file.step-$index.$dialect"
    destination="$workdir/$relative"
    mkdir -p -- "$(dirname -- "$destination")"
    {
      # The options GitHub itself runs the step's shell with, prepended as
      # actionlint does. It occupies line 1, so ShellCheck's reported line N is
      # line N-1 of the `run:` body.
      if [[ "$dialect" == bash ]]; then
        echo 'set -eo pipefail'
      else
        echo 'set -e'
      fi
      yq -r ".runs.steps[$index].run" "$file" | sanitize_expressions
    } >"$destination"
    produced=$((produced + 1))
    if [[ "$dialect" == bash ]]; then
      bash_scripts+=("$relative")
    else
      sh_scripts+=("$relative")
    fi
    printf 'check %s runs.steps[%s] (shell: %s)\n' "$file" "$index" "$dialect"
  done < <(yq -r \
    '.runs.steps | to_entries[] | select(.value | has("run")) | (.key | tostring) + "\t" + (.value.shell // "")' \
    "$file")

  if [[ "$produced" -ne "$expected" ]]; then
    echo "::error file=$file::composite-run-shellcheck: extracted $produced of $expected bash/sh run: block(s)."
    exit 1
  fi
done

total=$((${#bash_scripts[@]} + ${#sh_scripts[@]}))
if [[ "$total" -eq 0 ]]; then
  echo '::error::composite-run-shellcheck: no bash/sh run: block was extracted; the file set or the extraction is wrong.'
  exit 1
fi

# actionlint's exact ShellCheck contract for embedded `run:` scripts, so a step
# is not judged differently for living in a composite. Each excluded code is a
# false positive of the artifact class, not a relaxation of shell policy: SC1091
# (sources resolve only in the CI environment), SC2153/SC2154 (the block reads
# variables injected by the step's `env:`), and SC2194/SC2050/SC2157/SC2043
# (constant-expression artifacts of the `${{ }}` substitution above). `--norc`
# is likewise actionlint's, and keeps the repo .shellcheckrc — whose optional
# checks are written for standalone scripts — from applying here.
# Ref: https://github.com/rhysd/actionlint/blob/main/rule_shellcheck.go
excluded_codes='SC1091,SC2194,SC2050,SC2153,SC2154,SC2157,SC2043'
shellcheck_args=(--norc -x "--exclude=$excluded_codes")

printf 'Checking %d embedded run: block(s); reported line N is line N-1 of the run: body.\n' "$total"
status=0
cd -- "$workdir"
if [[ ${#bash_scripts[@]} -gt 0 ]]; then
  shellcheck "${shellcheck_args[@]}" --shell=bash "${bash_scripts[@]}" || status=$?
fi
if [[ ${#sh_scripts[@]} -gt 0 ]]; then
  sh_status=0
  shellcheck "${shellcheck_args[@]}" --shell=sh "${sh_scripts[@]}" || sh_status=$?
  # ShellCheck reserves 1 for a completed scan with findings and 2-4 for
  # processing errors; keep the more severe result rather than masking an
  # operational failure behind a finding code.
  ((sh_status <= status)) || status=$sh_status
fi
exit "$status"
