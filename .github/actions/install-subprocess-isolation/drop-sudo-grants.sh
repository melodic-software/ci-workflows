#!/usr/bin/env bash
# Usage: drop-sudo-grants.sh ETC PRINCIPAL...
#
# Run as root. Deletes every ETC/sudoers.d file holding a rule for one of the
# principals (a user name, #uid, %group, %#gid or ALL) and drops such rules
# from ETC/sudoers. A rule's principals are its first field, comma-separated.
# A grant through a User_Alias is not matched; the caller's `sudo -n true`
# check fails the job on one.
set -euo pipefail

etc=$1
shift
alternatives=$(printf '%s\n' "$@" | sed 's/[]\/$*.^|[(){}+?]/\\&/g' | paste -sd '|')
rule="^[[:space:]]*([^#[:space:]][^[:space:]]*,)?($alternatives)(,[^[:space:]]*)?[[:space:]]"

shopt -s nullglob
for file in "$etc"/sudoers.d/*; do
  if grep -Eq "$rule" "$file"; then
    rm -f -- "$file"
    echo "removed sudo drop-in: $file"
  fi
done
if [[ -f $etc/sudoers ]] && grep -Eq "$rule" "$etc/sudoers"; then
  sed -i -E "/$rule/d" "$etc/sudoers"
  echo "dropped the runner's rules from $etc/sudoers"
fi
