#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${TESTS_DIR}/.." && pwd)"
export ROOT_DIR

FAILED=0

assert_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    printf 'FAIL: %s\n  expected to contain: %s\n' "${msg}" "${needle}" >&2
    FAILED=1
    return 1
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="${3:-}"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    printf 'FAIL: %s\n  expected NOT to contain: %s\n' "${msg}" "${needle}" >&2
    FAILED=1
    return 1
  fi
}

assert_equals() {
  local actual="$1" expected="$2" msg="${3:-}"
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "${msg}" "${expected}" "${actual}" >&2
    FAILED=1
    return 1
  fi
}

export -f assert_contains assert_not_contains assert_equals

for test_file in "${TESTS_DIR}"/*.test.sh; do
  [[ -e "${test_file}" ]] || continue
  printf '== %s\n' "$(basename "${test_file}")"
  # shellcheck disable=SC1090
  source "${test_file}"
done

if [[ "${FAILED}" -ne 0 ]]; then
  printf 'TESTS FAILED\n' >&2
  exit 1
fi
printf 'ALL TESTS PASSED\n'
