#!/usr/bin/env bash
# pr-review-cli's split step: slices oversized file sections at hunk
# boundaries and splits the scope diff into bounded review chunks.
set -e
shopt -s inherit_errexit

# Inherited workflow and step environment variables.
: "${CHUNK_DIR:=}"
: "${COPIES:=}"
: "${GITHUB_OUTPUT:=}"
: "${MAX_CHUNKS:=}"
: "${MAX_CHUNK_FILES:=}"
: "${READ_BUDGET:=}"
: "${RENAMES:=}"
: "${SCOPE:=}"
: "${SCOPE_BYTES:=}"
: "${SCOPE_DIFF:=}"
: "${SOURCE:=}"

unsplit() {
  echo "chunks=1" >>"$GITHUB_OUTPUT"
  exit 0
}
# Files, not sections: a type change is two sections of one file,
# which the full-diff step's file count counts once. A section that
# deletes a file whole (git's deleted file mode, the scope step's
# status: removed) counts no file, as in the full-diff and scope
# steps' counts, so a chunk of deletions alone counts 0. A section
# header listed in the optional second file counts no file.
count_files() {
  SKIP="${2:-}" awk 'FILENAME == ENVIRON["SKIP"] { s[$0] = 1; next }
    /^diff --git /{ if (h != "" && !d && !(h in s)) n[h] = 1; h = $0; d = 0; next }
    /^(deleted file mode |status: removed$)/{ d = 1 }
    END { if (h != "" && !d && !(h in s)) n[h] = 1; for (k in n) c++; print c + 0 }' ${2:+"$2"} "$1"
}
if ! [[ "$SCOPE_BYTES" =~ ^[0-9]{1,12}$ ]]; then
  unsplit
fi
if [[ -L .claude-lane ]] || [[ -L "$SCOPE_DIFF" ]] || [[ ! -f "$SCOPE_DIFF" ]]; then
  echo "::warning::the diff in scope is not a regular file; it is reviewed unsplit, as a partial review"
  unsplit
fi
scope_files=$(count_files "$SCOPE_DIFF")
if [[ "$SCOPE_BYTES" -le "$READ_BUDGET" ]] && [[ "$scope_files" -le "$MAX_CHUNK_FILES" ]]; then
  unsplit
fi
if ! mkdir "$CHUNK_DIR" 2>/dev/null; then
  echo "::warning::the head already holds $CHUNK_DIR; the diff is reviewed unsplit, as a partial review"
  unsplit
fi
# The diff without the copies and verified renames, used only when
# it holds exactly the files in scope but those.
input="$SCOPE_DIFF"
excluded=0
# The bytes of the diff split below: the whole scope unless its
# copies and renames are left out.
distinct_bytes=$SCOPE_BYTES
identical=.claude-lane/identical.txt
renamed=.claude-lane/renames.txt
lists=()
skipped=0
if [[ "$COPIES" =~ ^[1-9][0-9]{0,5}$ ]] && [[ -f "$identical" ]] && [[ ! -L "$identical" ]]; then
  lists+=("$identical")
  skipped=$COPIES
fi
if [[ "$RENAMES" =~ ^[1-9][0-9]{0,5}$ ]] && [[ -f "$renamed" ]] && [[ ! -L "$renamed" ]]; then
  lists+=("$renamed")
  skipped=$((skipped + RENAMES))
fi
if [[ "$skipped" -gt 0 ]]; then
  distinct="$CHUNK_DIR/distinct.diff"
  # A copy's section header names its path twice; a rename's, its
  # old path then its new.
  IDENTICAL="$identical" RENAMED="$renamed" awk -F '\t' '
    FILENAME == ENVIRON["IDENTICAL"] { for (i = 2; i <= NF; i++) left["diff --git a/" $i " b/" $i] = 1; next }
    FILENAME == ENVIRON["RENAMED"] { if (NF == 2) left["diff --git a/" $1 " b/" $2] = 1; next }
    /^diff --git / { skip = ($0 in left) }
    !skip' "${lists[@]}" "$SCOPE_DIFF" >"$distinct"
  measured_bytes=$(wc -c <"$distinct" | tr -d ' ')
  distinct_files=$(count_files "$distinct")
  if [[ $((distinct_files + skipped)) -eq "$scope_files" ]]; then
    if [[ "$SCOPE_BYTES" -le "$READ_BUDGET" ]] && [[ "$distinct_files" -le "$MAX_CHUNK_FILES" ]]; then
      unsplit
    fi
    if [[ "$measured_bytes" -le "$READ_BUDGET" ]] && [[ "$distinct_files" -le "$MAX_CHUNK_FILES" ]]; then
      {
        echo "chunks=1"
        echo "excluded=$skipped"
        echo "distinct-bytes=$measured_bytes"
      } >>"$GITHUB_OUTPUT"
      echo "::notice title=pr-review-cli chunks::chunks=1 bytes=$SCOPE_BYTES distinct-bytes=$measured_bytes files=$distinct_files excluded=$skipped"
      exit 0
    fi
    input="$distinct"
    excluded=$skipped
    distinct_bytes=$measured_bytes
  fi
fi
# A file whose section is over the read budget is cut at its `@@`
# hunk boundaries into pieces of at most the budget, each under the
# file's own header (its lines before the first hunk), in order, and
# the split reads the cut diff; sliced.txt lists each cut file's
# header. A file with a hunk over the budget with its header is not
# cut, so the split refuses it and the review stays partial. A diff
# with no section over the budget reaches the split as it was.
sliced="$CHUNK_DIR/sliced.txt"
# A diff whose last line has no newline is a byte shorter than awk counts it.
open=0
if [[ -n "$(tail -c 1 "$input")" ]]; then
  open=1
fi
LC_ALL=C awk -v budget="$READ_BUDGET" -v open="$open" -v cut="$CHUNK_DIR/sliced.diff" -v list="$sliced" '
  # A header names its path only as `a/<p> b/<p>`.
  function named(header,   rest, half, p) {
    rest = substr(header, 12)
    half = int((length(rest) - 1) / 2)
    p = substr(rest, 3, half - 2)
    return (rest == "a/" p " b/" p && p ~ /^[A-Za-z0-9._\/@+-]+$/ && length(p) <= 500) ? p : "a file"
  }
  # Line i of the section, with its newline unless it is the last
  # line of a diff that ends without one.
  function put(i) {
    printf "%s%s", line[i], (i == n && size_end ? "" : "\n") > cut
  }
  function flush(   i, h, k, hunks, start, size, head, piece, big, last, gone) {
    if (n == 0) return
    if (bytes > budget) {
      h = 0
      head = 0
      gone = 0
      while (h < n && substr(line[h + 1], 1, 2) != "@@") {
        head += length(line[++h]) + 1
        if (line[h] ~ /^(deleted file mode |status: removed$)/) gone = 1
      }
      hunks = 0
      for (i = h + 1; i <= n; i++) {
        if (substr(line[i], 1, 2) == "@@") start[++hunks] = i
        size[hunks] += length(line[i]) + 1
      }
      size[hunks] -= size_end
      big = 0
      for (k = 1; k <= hunks; k++) if (head + size[k] > big) big = head + size[k]
      if (gone) {
        # A deletion is one hunk of the old file: never cut.
      } else if (big > budget) {
        print "::warning::" named(line[1]) ": one hunk of " big " bytes with its header is larger than one chunk of " budget " bytes, so the file cannot be cut at its hunks; the diff is reviewed unsplit, as a partial review"
      } else if (hunks > 1) {
        print line[1] > list
        piece = budget
        for (k = 1; k <= hunks; k++) {
          if (piece + size[k] > budget) {
            for (i = 1; i <= h; i++) put(i)
            piece = head
          }
          last = k < hunks ? start[k + 1] - 1 : n
          for (i = start[k]; i <= last; i++) put(i)
          piece += size[k]
        }
        n = 0
        bytes = 0
        return
      }
    }
    for (i = 1; i <= n; i++) put(i)
    n = 0
    bytes = 0
  }
  /^diff --git / { flush() }
  { line[++n] = $0; bytes += length($0) + 1 }
  END { bytes -= open; size_end = open; flush() }' "$input"
slices=0
if [[ -f "$sliced" ]]; then
  slices=$(wc -l <"$sliced" | tr -d ' ')
fi
cut_note=
if [[ "$slices" -gt 0 ]]; then
  input="$CHUNK_DIR/sliced.diff"
  cut_note=" sliced=$slices"
else
  rm -f "$CHUNK_DIR/sliced.diff"
fi
status=0
# The source's splitter is diff_chunking.py's `split` subcommand; an older
# source has the same CLI as pr-review-main/split-diff.py.
splitter=("$SOURCE/.github/scripts/diff-chunking/diff_chunking.py" split)
[[ -f "${splitter[0]}" ]] || splitter=("$SOURCE/.github/scripts/pr-review-main/split-diff.py")
python3 -I "${splitter[@]}" "$input" "$CHUNK_DIR" "$READ_BUDGET" "$MAX_CHUNKS" "$CHUNK_DIR/manifest.txt" "$READ_BUDGET" "$MAX_CHUNK_FILES" 2>"$CHUNK_DIR/split-error.txt" || status=$?
if [[ "$status" -ne 0 ]]; then
  cat "$CHUNK_DIR/split-error.txt" >&2
  # split-diff.py's refusal of a diff over the ceiling names its chunk count.
  needed=$(grep -oE '^split-diff: the diff needs [0-9]{1,6} chunks, more than [0-9]+$' "$CHUNK_DIR/split-error.txt" | grep -oE '[0-9]+' | head -n 1) || needed=
  if [[ -n "$needed" ]]; then
    echo "over-chunks=$needed" >>"$GITHUB_OUTPUT"
    echo "::warning::the diff in scope ($SCOPE_BYTES bytes, $scope_files files, $excluded copies and renames left out) needs $needed chunks of $READ_BUDGET bytes and $MAX_CHUNK_FILES files, more than the ceiling of $MAX_CHUNKS; it is reviewed unsplit, as a partial review"
  else
    echo "::warning::the diff in scope ($SCOPE_BYTES bytes, $scope_files files, $excluded copies and renames left out) did not split into at most $MAX_CHUNKS chunks of $READ_BUDGET bytes and $MAX_CHUNK_FILES files (exit $status); it is reviewed unsplit, as a partial review"
  fi
  unsplit
fi
chunks=$(find "$CHUNK_DIR" -name 'chunk-*.patch' | wc -l)
# A chunk over the file cap (a split-diff.py that ignored it) is one
# review, which the extract step then calls partial. A cut file
# counts once, in the chunk holding its last piece, so the chunks'
# counts add up to the files in scope.
files=
for k in $(seq "$chunks"); do
  later=
  if [[ "$slices" -gt 0 ]] && [[ "$k" -lt "$chunks" ]]; then
    later="$CHUNK_DIR/later-$k.txt"
    for j in $(seq $((k + 1)) "$chunks"); do
      grep -Fx -f "$sliced" "$CHUNK_DIR/chunk-$j.patch" || true
    done >"$later"
  fi
  n=$(count_files "$CHUNK_DIR/chunk-$k.patch" "$later")
  if [[ "$n" -gt "$MAX_CHUNK_FILES" ]]; then
    echo "::warning::chunk $k holds $n files, over $MAX_CHUNK_FILES; the diff is reviewed unsplit, as a partial review"
    unsplit
  fi
  files="$files${files:+,}$n"
done
{
  echo "chunks=$chunks"
  echo "files=$files"
  echo "excluded=$excluded"
} >>"$GITHUB_OUTPUT"
if [[ "$slices" -gt 0 ]]; then
  echo "sliced=$slices" >>"$GITHUB_OUTPUT"
fi
echo "::notice title=pr-review-cli chunks::chunks=$chunks bytes=$SCOPE_BYTES distinct-bytes=$distinct_bytes files=$files excluded=$excluded$cut_note"
