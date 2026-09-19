#!/bin/sh
# Verify every hand-written proofs file. The pinned LemmaScript workflow runs
# this after the listed files, and `pnpm check:lemmascript` runs it at a desk.
set -e
status=0
for proofs in $(find packages -name '*.verified.proofs.dfy' -not -path '*/node_modules/*' | sort); do
	echo "== $proofs"
	dafny verify "$proofs" || status=1
done
exit $status
