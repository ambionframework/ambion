#!/bin/sh
# Fail when the Dafny of a listed rules file differs from its generation.
# `lsc gen-check` passes a `.dfy` that only adds lines to the generation, so
# this step compares the committed `.dfy` with the fresh `.dfy.gen`. It reads
# the list as `lsc` does: a last line with no newline, a CR, and a blank line.
cr="$(printf '\r')"
status=0
while read -r file _ || [ -n "$file" ]; do
	file="${file%"$cr"}"
	[ -z "$file" ] && continue
	base="${file%.ts}"
	if ! cmp -s "$base.dfy" "$base.dfy.gen"; then
		echo "stale: $base.dfy differs from $base.dfy.gen. Run: pnpm rule:check $file"
		status=1
	fi
done <LemmaScript-files.txt
exit $status
