#!/bin/sh
# Check one rules file after an edit: write its Dafny, copy the generation to
# the `.dfy`, prove it, and prove the hand-written proofs file beside it when
# one exists. The `.dfy.gen` is a build product that git ignores.
#
#   pnpm rule:check packages/ambion/src/room/rules.verified.ts
set -e
file="$1"
if [ -z "$file" ]; then
	echo "usage: pnpm rule:check <path/to/rules.verified.ts>" >&2
	exit 2
fi
base="${file%.ts}"
lsc gen --backend=dafny "$file"
cp "$base.dfy.gen" "$base.dfy"
lsc check --backend=dafny "$file"
proofs="${file%.ts}.proofs.dfy"
if [ -f "$proofs" ]; then
	echo "== $proofs"
	dafny verify "$proofs"
fi
