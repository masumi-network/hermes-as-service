#!/usr/bin/env bash
# This script exists for backwards compatibility with the original brief, which
# assumed a Docker registry workflow. Sprites.dev does NOT run arbitrary OCI
# images — sprites are stateful Linux microVMs you populate via the REST API
# (filesystem write + exec).
#
# The actual "user image" is built INSIDE each sprite by the orchestrator,
# using scripts/bootstrap-hermes-sprite.sh. There's nothing to push.
#
# If you ever migrate to a runtime that DOES take Docker images (Fly Machines,
# Cloud Run, etc.), this is where the build+push would live.

set -euo pipefail
echo "Sprites.dev does not accept Docker images."
echo "User sprites are bootstrapped at first boot via:"
echo "  scripts/bootstrap-hermes-sprite.sh"
echo
echo "Nothing to build or push. Exiting cleanly."
exit 0
