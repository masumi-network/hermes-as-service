#!/usr/bin/env bash
# install-skills.sh — runs INSIDE a sprite.
# Idempotent installer for the orchestrator's curated skill packs.
# Each repo is cloned into a versioned cache directory, then copied (rsync-
# style) into /opt/data/skills/ so user-added skills are preserved.

set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  exec sudo "$0" "$@"
fi

SKILLS_DIR=/opt/data/skills
CACHE_DIR=/opt/hermes-skills-cache

mkdir -p "$SKILLS_DIR" "$SKILLS_DIR/meta" "$CACHE_DIR"

clone_or_pull() {
  local url="$1" dest="$2"
  if [ -d "$dest/.git" ]; then
    git -C "$dest" fetch --depth 1 origin && git -C "$dest" reset --hard FETCH_HEAD
  else
    rm -rf "$dest"
    git clone --depth 1 "$url" "$dest"
  fi
}

echo "[skills] marketingskills (coreyhaines31)"
clone_or_pull https://github.com/coreyhaines31/marketingskills.git "$CACHE_DIR/marketingskills"
# Each subdirectory of skills/ becomes a Hermes skill at /opt/data/skills/<name>.
for src in "$CACHE_DIR/marketingskills/skills"/*/; do
  [ -d "$src" ] || continue
  name=$(basename "$src")
  rm -rf "$SKILLS_DIR/$name"
  cp -r "$src" "$SKILLS_DIR/$name"
done

echo "[skills] avoid-ai-writing (conorbronsdon)"
clone_or_pull https://github.com/conorbronsdon/avoid-ai-writing.git "$CACHE_DIR/avoid-ai-writing"
rm -rf "$SKILLS_DIR/avoid-ai-writing"
mkdir -p "$SKILLS_DIR/avoid-ai-writing"
cp "$CACHE_DIR/avoid-ai-writing/SKILL.md" "$SKILLS_DIR/avoid-ai-writing/SKILL.md"
# CLAUDE.md is the longer reference — copy alongside for completeness.
[ -f "$CACHE_DIR/avoid-ai-writing/CLAUDE.md" ] && cp "$CACHE_DIR/avoid-ai-writing/CLAUDE.md" "$SKILLS_DIR/avoid-ai-writing/CLAUDE.md"

echo "[skills] hermes-skill-factory (Romanescu11)"
clone_or_pull https://github.com/Romanescu11/hermes-skill-factory.git "$CACHE_DIR/skill-factory"
rm -rf "$SKILLS_DIR/meta/skill-factory"
mkdir -p "$SKILLS_DIR/meta/skill-factory"
cp "$CACHE_DIR/skill-factory/skills/skill-factory/SKILL.md" "$SKILLS_DIR/meta/skill-factory/SKILL.md"
# Templates / examples are useful context for the meta-skill.
[ -d "$CACHE_DIR/skill-factory/templates" ] && cp -r "$CACHE_DIR/skill-factory/templates" "$SKILLS_DIR/meta/skill-factory/templates"
[ -d "$CACHE_DIR/skill-factory/examples" ] && cp -r "$CACHE_DIR/skill-factory/examples" "$SKILLS_DIR/meta/skill-factory/examples"

echo "[skills] claude-ads (AgriciDaniel)"
clone_or_pull https://github.com/AgriciDaniel/claude-ads.git "$CACHE_DIR/claude-ads"
for src in "$CACHE_DIR/claude-ads/skills"/*/; do
  [ -d "$src" ] || continue
  name=$(basename "$src")
  # Prefix avoids collisions with toprank's ads-* and marketingskills' ad-* names.
  dest="$SKILLS_DIR/$name"
  if [ -d "$dest" ] && [ "$name" != "${name#ads-}" ]; then
    dest="$SKILLS_DIR/${name}-cad"
  fi
  rm -rf "$dest"
  cp -r "$src" "$dest"
done

echo "[skills] toprank (nowork-studio)"
clone_or_pull https://github.com/nowork-studio/toprank.git "$CACHE_DIR/toprank"
# toprank organises skills by category (seo/, google-ads/, meta-ads/, gemini/)
# each containing N subdirs with SKILL.md. Walk every category.
for category in seo google-ads meta-ads gemini; do
  cat_dir="$CACHE_DIR/toprank/$category"
  [ -d "$cat_dir" ] || continue
  for src in "$cat_dir"/*/; do
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || continue
    name=$(basename "$src")
    # Namespace under "tr-<category>-<name>" so we don't clash with marketing
    # or claude-ads skills that may have the same short name.
    dest="$SKILLS_DIR/tr-${category}-${name}"
    rm -rf "$dest"
    cp -r "$src" "$dest"
  done
done

# Make the whole skills tree readable by the hermes runtime user (Sprites
# runs services as root, but if Hermes ever drops privileges this stays safe).
chown -R root:root "$SKILLS_DIR"
chmod -R a+rX "$SKILLS_DIR"

# Count installed
count=$(find "$SKILLS_DIR" -name SKILL.md -type f | wc -l | tr -d ' ')
echo "[skills] installed ${count} SKILL.md files"
