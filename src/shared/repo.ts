/**
 * Room/project name for a session's working directory: its last path segment, for Windows and POSIX paths alike.
 * "D:\Work\shop-api\" -> "shop-api", "/home/me/api" -> "api", "C:\" -> "C:". Used everywhere a repo is derived from a cwd,
 * so the same session always lands in the same room.
 */
export function repoFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || trimmed || cwd;
}
