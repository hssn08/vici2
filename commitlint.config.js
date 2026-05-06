// Conventional Commits per SPEC.md §3.2
// Format: <type>(<scope>): <subject>
//   type   = feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert
//   scope  = module ID (F01, F02, T01, ...) or area (deps, build, ...)
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "scope-empty": [0],
    "header-max-length": [2, "always", 100],
  },
};
