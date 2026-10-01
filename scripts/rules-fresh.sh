#!/bin/sh
# Fail when the Dafny of a listed rules file differs from its generation.
# `lsc gen-check` writes each `.dfy.gen` and exits 0, so this step compares
# the committed `.dfy` with the fresh generation.
status=0
while read -r file _; do
	base="${file%.ts}"
	if ! cmp -s "$base.dfy" "$base.dfy.gen"; then
		echo "stale: $base.dfy. Run: pnpm rule:check $file"
		status=1
	fi
done <LemmaScript-files.txt
exit $status
