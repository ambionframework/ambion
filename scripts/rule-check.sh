#!/bin/sh
# Check one rules file after an edit: regenerate its Dafny, prove it, and prove
# the hand-written proofs file beside it when one exists.
#
#   pnpm rule:check packages/ambion/src/room/rules.verified.ts
set -e
file="$1"
if [ -z "$file" ]; then
	echo "usage: pnpm rule:check <path/to/rules.verified.ts>" >&2
	exit 2
fi
lsc regen --backend=dafny "$file"
lsc check --backend=dafny "$file"
proofs="${file%.ts}.proofs.dfy"
if [ -f "$proofs" ]; then
	echo "== $proofs"
	dafny verify "$proofs"
fi
