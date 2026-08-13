#!/bin/sh

set -eu

storage_root="${STORAGE_ROOT:-/data}"

if [ -z "$storage_root" ] || [ "$storage_root" = "/" ]; then
  echo "拒绝使用不安全的 STORAGE_ROOT: '$storage_root'" >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p \
    "$storage_root/uploads" \
    "$storage_root/reports" \
    "$storage_root/history"
  chown mysqlhc:mysqlhc \
    "$storage_root" \
    "$storage_root/uploads" \
    "$storage_root/reports" \
    "$storage_root/history"
  exec gosu mysqlhc "$@"
fi

exec "$@"
