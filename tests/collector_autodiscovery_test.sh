#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

BASE_DIR="$TMP_DIR/opt/mysql"
DATA_DIR="$TMP_DIR/data"
OUT_DIR="$TMP_DIR/out"
mkdir -p "$BASE_DIR/bin" "$DATA_DIR" "$OUT_DIR"

cat > "$BASE_DIR/bin/mysql" <<'MYSQL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_MYSQL_ARGS_LOG}"
case "$*" in
  *"SELECT VERSION()"*) echo "5.7.20" ;;
  *"SELECT LEFT(VERSION(),3)"*) echo "5.7" ;;
  *"SELECT @@slow_query_log_file"*) echo "/tmp/mysql-slow.log" ;;
  *"SELECT @@log_error"*) echo "/tmp/mysql-error.log" ;;
  *"SELECT @@datadir"*) echo "/tmp/mysql-data" ;;
  *) echo "ok" ;;
esac
MYSQL
chmod +x "$BASE_DIR/bin/mysql"

cat > "$TMP_DIR/ps.txt" <<EOF
root 3549 1 0 May07 ? 00:00:00 /bin/sh $BASE_DIR/bin/mysqld_safe --defaults-file=$DATA_DIR/my3306.cnf
mysql 4696 3549 0 May07 ? 00:04:49 $BASE_DIR/bin/mysqld --defaults-file=$DATA_DIR/my3306.cnf --basedir=$BASE_DIR --datadir=$DATA_DIR/mydata --user=mysql --log-error=$DATA_DIR/mydata/error.log --pid-file=$DATA_DIR/mydata/mysql.pid --socket=$DATA_DIR/mydata/mysql.sock --port=13306
EOF

cat > "$DATA_DIR/my3306.cnf" <<EOF
[mysqld]
socket=$DATA_DIR/mydata/mysql.sock
port=13306
basedir=$BASE_DIR
datadir=$DATA_DIR/mydata

[client]
user=dbadmin
password=secret
EOF

export MYSQL_HEALTHCHECK_PS_FILE="$TMP_DIR/ps.txt"
export MYSQL_HEALTHCHECK_SKIP_COLLECTION=1
export FAKE_MYSQL_ARGS_LOG="$TMP_DIR/mysql-args.log"

"$ROOT_DIR/collectors/mysqlHealthCheckV3.0.sh" \
  --output-dir "$OUT_DIR" \
  --non-interactive \
  --test-login

grep -q -- "--socket=$DATA_DIR/mydata/mysql.sock" "$FAKE_MYSQL_ARGS_LOG"
grep -q -- "--defaults-extra-file=" "$FAKE_MYSQL_ARGS_LOG"
grep -Eq -- "--ssl-mode=DISABLED|--ssl=0" "$FAKE_MYSQL_ARGS_LOG"

if grep -q -- "-psecret" "$FAKE_MYSQL_ARGS_LOG"; then
  echo "password leaked on mysql command line" >&2
  exit 1
fi

echo "collector autodiscovery test passed"

FAIL_DIR="$TMP_DIR/fail"
FAIL_OUT="$TMP_DIR/fail-out"
mkdir -p "$FAIL_DIR/opt/mysql/bin" "$FAIL_OUT"
cat > "$FAIL_DIR/opt/mysql/bin/mysql" <<'MYSQL'
#!/usr/bin/env bash
echo "ERROR 1045 (28000): Access denied for user" >&2
exit 1
MYSQL
chmod +x "$FAIL_DIR/opt/mysql/bin/mysql"
cat > "$TMP_DIR/ps-fail.txt" <<EOF
mysql 5000 1 0 May07 ? 00:00:00 $FAIL_DIR/opt/mysql/bin/mysqld --basedir=$FAIL_DIR/opt/mysql --socket=$FAIL_DIR/mysql.sock --port=3307
EOF

export MYSQL_HEALTHCHECK_PS_FILE="$TMP_DIR/ps-fail.txt"
if "$ROOT_DIR/collectors/mysqlHealthCheckV3.0.sh" --output-dir "$FAIL_OUT" --non-interactive >"$TMP_DIR/fail.stdout" 2>"$TMP_DIR/fail.stderr"; then
  echo "collector should fail when login fails" >&2
  exit 1
fi
grep -q "无法登录 MySQL" "$TMP_DIR/fail.stderr"
if find "$FAIL_OUT" -name 'MySQLHealthCheck_*.txt' | grep -q .; then
  echo "collector generated report despite login failure" >&2
  exit 1
fi

echo "collector login failure test passed"
