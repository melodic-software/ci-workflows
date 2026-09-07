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
# judged AT LEAST AS STRICTLY whether it lives in a workflow or a composite —
# not merely identically. actionlint's own dialect resolution (rule_shellcheck
# .go) matches only a bare "bash"/"sh" or its literal leading word in GitHub's
# custom-shell form ("bash [options] {0}"), so a path-qualified custom shell
# (`shell: /usr/bin/bash --noprofile {0}`, which GitHub documents and runs as
# bash) falls through actionlint's own check unanalysed. This check resolves
# by the leading command's BASENAME instead, so a path-qualified shell of
# either dialect is analysed here too rather than silently skipped as it is
# upstream — a composite step is therefore never LESS covered than the
# identical workflow step would be, only ever equally or more so. It also
# makes the in-place `# shellcheck disable=` directives those blocks already
# carry take effect.
#
# The pwsh blocks this announces as skipped are covered by the PowerShell
# counterpart, .github/scripts/Invoke-CompositeRunPssa.ps1. The two run in
# different CI lanes because each needs its own analyzer on PATH.
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
# checksum-verified one — and yq (mikefarah, preinstalled on ubuntu-24.04).
# Ratified (not an oversight): the repo has two yq conventions — pinned +
# checksum-verified (standards-sync.yml, which pushes changes to OTHER
# repositories) and the documented runner-preinstalled exception
# (tool-version-drift-check.yml, which only files an advisory tracking issue).
# This lane runs on `pull_request` and blocks every merge, a higher blast
# radius than either precedent, yet still takes the preinstalled exception:
# both this check's false-green guards (the independent `expected` count and
# the extraction it verifies) read yq's output, so a runner-image yq change
# that altered its output shape would move them together rather than one
# catching the other. That residual is accepted for now rather than pinning
# yq here in isolation, which would duplicate the install standards-sync.yml
# already performs; a shared, non-duplicated install is tracked as a
# prerequisite in #200. Revisit there if that lands.
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

  # One yq process per file. The previous loop forked yq once for `.runs.using`,
  # once for the independent expected-count selector, once for the step listing,
  # and once more per `run:` body. Those queries stay independent expressions
  # inside this single invocation — the false-green guard still compares two
  # selectors that can disagree — and each run body is base64 so a newline in
  # the block cannot split a STEP record. `@base64` / `-r` work on both
  # mikefarah yq (ubuntu-24.04) and kislyuk yq.
  dump="$(yq -r '
    "USING " + (.runs.using // ""),
    "EXPECTED " + ((.runs.steps // []) | [.[] | select(has("run")) | select((.shell // "") | test("^([^ ]*/)?(bash|sh)( |$)"))] | length | tostring),
    ((.runs.steps // []) | to_entries[] | select(.value | has("run")) | "STEP " + (.key | tostring) + " " + ((.value.shell // "") | @base64) + " " + ((.value.run // "") | @base64))
  ' "$file")"
  using=""
  expected=""
  produced=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ -z "$using" && "$line" == 'USING '* ]]; then
      using="${line#USING }"
      if [[ "$using" != composite ]]; then
        printf 'skip %s: runs.using is %s, not composite\n' "$file" "${using:-<unset>}"
        break
      fi
      continue
    fi
    case "$line" in
    'EXPECTED '*)
      expected="${line#EXPECTED }"
      ;;
    'STEP '*)
      rest="${line#STEP }"
      index="${rest%% *}"
      rest="${rest#* }"
      shell_b64="${rest%% *}"
      run_b64="${rest#* }"
      if [[ ! "$index" =~ ^[0-9]+$ ]]; then
        # `.key` is a sequence index only while `runs.steps` is a sequence. A
        # mapping makes it an arbitrary author-supplied string, and this runs
        # against pull-request content, so reject the shape at the boundary
        # rather than writing it into a path: $index reaches the destination
        # below.
        echo "::error file=$file::composite-run-shellcheck: runs.steps is not a sequence (key '$index')."
        exit 1
      fi
      shell="$(printf '%s' "$shell_b64" | base64 -d)"
      # DELIBERATELY exceeds actionlint's own dialect resolution
      # (rule_shellcheck.go), which matches only a bare name or its literal
      # leading word in GitHub's custom-shell form (`command [...options] {0}`).
      # This resolves by the leading command's BASENAME instead, so a
      # path-qualified custom shell (`shell: /usr/bin/bash --noprofile {0}`,
      # which GitHub documents and runs as bash) is classified too, rather than
      # silently skipped as it is upstream — narrower coverage would leave a
      # block GitHub runs with bash/sh unchecked while the job stayed green, the
      # coverage hole this check exists to close. Only the case sees the raw
      # scalar; everything downstream uses the resolved dialect, so no option
      # text reaches a filename. Parameter expansion (not `basename`) to avoid a
      # subprocess per step.
      if [[ -z "$shell" ]]; then
        echo "::error file=$file::composite-run-shellcheck: runs.steps[$index] has a run: block with no shell:; refusing to guess the dialect."
        exit 1
      fi
      leading="${shell%% *}"
      leading="${leading##*/}"
      case "$leading" in
      bash) dialect='bash' ;;
      sh) dialect='sh' ;;
      *)
        printf 'skip %s runs.steps[%s]: shell is %s, not bash/sh\n' "$file" "$index" "$shell"
        continue
        ;;
      esac
      relative="$file.step-$index.$dialect"
      destination="$workdir/$relative"
      mkdir -p -- "$(dirname -- "$destination")"
      # `shell_options` is the options GitHub itself runs the step's shell with,
      # prepended as actionlint does. It occupies line 1, so ShellCheck's reported
      # line N is line N-1 of the `run:` body. The dialect decides that line and
      # which per-dialect batch the extracted script joins, so both follow from
      # one branch rather than two that could drift apart.
      if [[ "$dialect" == bash ]]; then
        shell_options='set -eo pipefail'
        bash_scripts+=("$relative")
      else
        shell_options='set -e'
        sh_scripts+=("$relative")
      fi
      {
        echo "$shell_options"
        printf '%s' "$run_b64" | base64 -d | sanitize_expressions
      } >"$destination"
      produced=$((produced + 1))
      printf 'check %s runs.steps[%s] (shell: %s)\n' "$file" "$index" "$dialect"
      ;;
    *) ;;
    esac
  done <<<"$dump"

  if [[ "$using" != composite ]]; then
    continue
  fi

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

# Fan-out ShapeCheck over extracted scripts the same way shellcheck/run.sh does:
# ShellCheck itself is serial per process, so one invocation over dozens of
# extracted blocks is a serial wall. Batches replay in order so the log matches
# a single process; the exit status is the maximum over batches.
run_embedded_shellcheck() {
  local -a sc_args=()
  while (($# > 0)); do
    if [[ "$1" == -- ]]; then
      shift
      break
    fi
    sc_args+=("$1")
    shift
  done
  local capture batch=0 index=0 count=$# st=0 list log rc
  local jobs=4 batch_size
  if ((count <= 1 || jobs <= 1)); then
    shellcheck "${sc_args[@]}" "$@" || st=$?
    return "$st"
  fi
  batch_size=$(((count + jobs - 1) / jobs))
  capture="$(mktemp -d)"
  while ((index < count)); do
    printf '%s\0' "${@:index+1:batch_size}" >"$capture/$(printf '%06d' "$batch").files"
    index=$((index + batch_size))
    batch=$((batch + 1))
  done
  # shellcheck disable=SC2016
  printf '%s\0' "$capture"/*.files | xargs -0 -n 1 -P "$jobs" bash -c '
    list="${!#}"
    set -- "${@:1:$#-1}"
    mapfile -d "" -t batch <"$list"
    shellcheck "$@" "${batch[@]}" >"${list%.files}.log" 2>&1
    echo "$?" >"${list%.files}.rc"
  ' _ "${sc_args[@]}"
  for list in "$capture"/*.files; do
    log="${list%.files}.log"
    [[ ! -f "$log" ]] || cat -- "$log"
    if [[ -f "${list%.files}.rc" ]]; then
      rc="$(<"${list%.files}.rc")"
    else
      rc=2
    fi
    ((rc <= st)) || st=$rc
  done
  rm -rf -- "$capture"
  return "$st"
}

if [[ ${#bash_scripts[@]} -gt 0 ]]; then
  # The function records every batch status itself and never relies on errexit,
  # so capturing its return here is the intended path, not a suppressed exit.
  # shellcheck disable=SC2310
  run_embedded_shellcheck "${shellcheck_args[@]}" --shell=bash -- "${bash_scripts[@]}" || status=$?
fi
if [[ ${#sh_scripts[@]} -gt 0 ]]; then
  sh_status=0
  # Same intended capture as the bash lane above.
  # shellcheck disable=SC2310
  run_embedded_shellcheck "${shellcheck_args[@]}" --shell=sh -- "${sh_scripts[@]}" || sh_status=$?
  # ShellCheck reserves 1 for a completed scan with findings and 2-4 for
  # processing errors; keep the more severe result rather than masking an
  # operational failure behind a finding code.
  ((sh_status <= status)) || status=$sh_status
fi
exit "$status"
