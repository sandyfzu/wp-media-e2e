/**
 * A bash function for a stub `wp` that answers the plugin-folder inspection (`wp/plugin-dir.ts`) from
 * a real directory, as the site's own snippet would — so the specs of everything built on it run
 * without PHP, against folders they make and break themselves. The snippet itself runs under real
 * PHP in `plugin-dir.php.spec.ts`.
 *
 * `inspect_plugin_dir <plugins folder> <slug>` prints the reply for that one slug: `absent` when
 * nothing (not even a link) is there, `recognised` when a `main.php` is, else `orphaned`; the type,
 * a folder's entry count, its top-level count and first names in byte order (as PHP's `scandir`
 * sorts), a fixed owner and age. A folder that can be read but not entered counts its top-level
 * names only, as PHP's walk does; one that cannot be read, nothing.
 */
export const INSPECT_PLUGIN_DIR_BASH = String.raw`
inspect_plugin_dir() {
  local p="$1/$2" kind type extra n top sample
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then
    printf '{"%s":{"kind":"absent","path":"%s"}}' "$2" "$p"
    return
  fi
  if [ -L "$p" ]; then type=link; elif [ -d "$p" ]; then type=directory; else type=file; fi
  if [ -d "$p" ] && [ -e "$p/main.php" ]; then kind=recognised; else kind=orphaned; fi
  extra=',"sample":[]'
  if [ "$type" = link ]; then
    extra="$extra,\"target\":\"$(readlink "$p")\""
  elif [ "$type" = directory ] && [ -r "$p" ]; then
    top=$(LC_ALL=C ls -A "$p" | wc -l | tr -d ' ')
    sample=$(LC_ALL=C ls -A "$p" | head -8 | sed 's/.*/"&"/' | paste -sd, -)
    if [ -x "$p" ]; then n=$(find "$p" -mindepth 1 2>/dev/null | wc -l | tr -d ' '); else n=$top; fi
    extra=",\"entries\":$n,\"top\":$top,\"sample\":[$sample]"
  fi
  printf '{"%s":{"kind":"%s","path":"%s","type":"%s","owner":"tester","age":60%s}}' \
    "$2" "$kind" "$p" "$type" "$extra"
}
`;
