#!/usr/bin/env bash
###############################################################################
# MySQL 巡检数据采集脚本 V3.0
# 单脚本、单 txt 输出，段名规范 ----->>>---->>>  [NN] 段名
#
# 用法（交互式，兼容 V2.0 习惯）：
#   ./mysqlHealthCheckV3.0.sh
#
# 用法（命令行参数，可批量自动化）：
#   ./mysqlHealthCheckV3.0.sh \
#       --user dbadmin --password 'xxx' \
#       --host 127.0.0.1 --port 3306 \
#       --socket /path/to/mysql.sock \
#       --defaults-file /path/to/my.cnf \
#       --mysql-cmd /usr/local/mysql/bin/mysql \
#       --output-dir ./reports \
#       --slow-log-lines 5000 \
#       --error-log-lines 1000 \
#       --backup-paths /backup,/data/backup
#
# 登录预检：
#   ./mysqlHealthCheckV3.0.sh --test-login --non-interactive
#
# 自动发现：
#   默认从 ps -ef 中的 mysqld/mariadbd 进程解析 --defaults-file、--basedir、
#   --socket、--port，并优先使用 basedir/bin/mysql 作为客户端。
#
# 输出：MySQLHealthCheck_<IP>_<TS>.txt
###############################################################################

set -uo pipefail

# ============== 默认值 ==============
EXEC_MYSQL=""
DEFAULTS_FILE=""
DB_SOCKET=""
DB_USER="dbadmin"
DB_PWD=""
DB_HOST="127.0.0.1"
DB_PORT="3306"
OUT_DIR="."
SLOW_LOG_LINES=5000
ERROR_LOG_LINES=1000
BACKUP_PATHS="/backup,/data/backup,/data/mysql/backup,/home/backup,/data/backup_mysql,/opt/backup,/opt/db_bak,/opt/db_bak/bak_dir"
SKIP_MODULES=""
NON_INTERACTIVE=0
TEST_LOGIN_ONLY=0
MYSQL_SSL_OPTION=""
MYSQL_DEFAULTS_EXTRA_FILE=""
AUTO_DETECT_NOTES=()
MYSQLD_PID_DETECTED=""
EXPLICIT_MYSQL_CMD=0
EXPLICIT_DEFAULTS_FILE=0
EXPLICIT_SOCKET=0
EXPLICIT_USER=0
EXPLICIT_PASSWORD=0
EXPLICIT_HOST=0
EXPLICIT_PORT=0

# ============== 命令行参数解析 ==============
while [[ $# -gt 0 ]]; do
    case "$1" in
        --user) DB_USER="$2"; EXPLICIT_USER=1; shift 2 ;;
        --password) DB_PWD="$2"; EXPLICIT_PASSWORD=1; shift 2 ;;
        --host) DB_HOST="$2"; EXPLICIT_HOST=1; shift 2 ;;
        --port) DB_PORT="$2"; EXPLICIT_PORT=1; shift 2 ;;
        --socket) DB_SOCKET="$2"; EXPLICIT_SOCKET=1; shift 2 ;;
        --defaults-file) DEFAULTS_FILE="$2"; EXPLICIT_DEFAULTS_FILE=1; shift 2 ;;
        --mysql-cmd) EXEC_MYSQL="$2"; EXPLICIT_MYSQL_CMD=1; shift 2 ;;
        --ssl-mode) MYSQL_SSL_OPTION="--ssl-mode=$2"; shift 2 ;;
        --output-dir) OUT_DIR="$2"; shift 2 ;;
        --slow-log-lines) SLOW_LOG_LINES="$2"; shift 2 ;;
        --error-log-lines) ERROR_LOG_LINES="$2"; shift 2 ;;
        --backup-paths) BACKUP_PATHS="$2"; shift 2 ;;
        --skip-modules) SKIP_MODULES="$2"; shift 2 ;;
        --non-interactive) NON_INTERACTIVE=1; shift ;;
        --test-login) TEST_LOGIN_ONLY=1; shift ;;
        -h|--help)
            awk '/^###############################################################################/ { block++; next } block == 1 && /^#/ { sub(/^# ?/, ""); print }' "$0"
            cat <<'EOF'

常用自动发现参数：
  --test-login              只测试数据库登录，成功后退出，不生成报告
  --defaults-file PATH      指定 mysqld 配置文件；不指定时从 ps -ef 的 --defaults-file 自动发现
  --socket PATH             指定 socket；不指定时从 mysqld 进程或 cnf 自动发现
  --ssl-mode MODE           传给 mysql 客户端的 SSL 模式，例如 DISABLED / PREFERRED

默认会在采集前执行登录测试；无法登录会报错退出，避免生成空报告。
EOF
            exit 0
            ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

# ============== 自动发现与登录测试 ==============
read_ps_lines() {
    if [[ -n "${MYSQL_HEALTHCHECK_PS_FILE:-}" && -f "${MYSQL_HEALTHCHECK_PS_FILE}" ]]; then
        cat "${MYSQL_HEALTHCHECK_PS_FILE}"
    else
        ps -ef 2>/dev/null
    fi
}

print_cnf_redacted() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    echo "===== ${file} ====="
    sed -E \
        -e 's/^([[:space:]]*(password|loose-password|ssl_key)[[:space:]]*=[[:space:]]*).*/\1*******/I' \
        -e 's/^([[:space:]]*(user)[[:space:]]*=[[:space:]]*).*/\1*******/I' \
        "$file"
}

print_include_cnf_files() {
    local file="$1" base inc dir
    [[ -f "$file" ]] || return 0
    base="$(dirname "$file")"
    while IFS= read -r inc; do
        inc="${inc%%#*}"
        inc="${inc%%;*}"
        inc="$(printf '%s\n' "$inc" | awk '{$1=$1; print}')"
        [[ -z "$inc" ]] && continue
        case "$inc" in
            '!include '*)
                inc="${inc#!include }"
                [[ "$inc" != /* ]] && inc="$base/$inc"
                [[ -f "$inc" ]] && print_cnf_redacted "$inc"
                ;;
            '!includedir '*)
                dir="${inc#!includedir }"
                [[ "$dir" != /* ]] && dir="$base/$dir"
                if [[ -d "$dir" ]]; then
                    for f in "$dir"/*.cnf; do
                        [[ -f "$f" ]] && print_cnf_redacted "$f"
                    done
                fi
                ;;
        esac
    done < "$file"
}

extract_proc_arg() {
    local line="$1"
    local key="$2"
    local m
    m=$(printf '%s\n' "$line" | sed -n "s/.*${key}=\\([^[:space:]]*\\).*/\\1/p" | head -1)
    [[ -n "$m" ]] && printf '%s\n' "$m"
}

cnf_get() {
    local file="$1"
    local section="$2"
    local key="$3"
    [[ -f "$file" ]] || return 1
    awk -v section="$section" -v key="$key" '
        BEGIN { in_section = 0; found = "" }
        /^[[:space:]]*[#;]/ { next }
        /^[[:space:]]*\[/ {
            in_section = ($0 ~ "^[[:space:]]*\\[" section "\\]")
            next
        }
        in_section {
            line = $0
            sub(/[[:space:]]*[#;].*$/, "", line)
            if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
                sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
                gsub(/^[\"\047]|[\"\047]$/, "", line)
                found = line
            }
        }
        END { if (found != "") print found }
    ' "$file" | tail -1
}

first_existing_file() {
    for f in "$@"; do
        [[ -n "$f" && -f "$f" ]] && { printf '%s\n' "$f"; return 0; }
    done
    return 1
}

detect_mysql_runtime() {
    local ps_lines mysqld_line mysqld_safe_line basedir datadir socket port defaults_file mysqld_bin
    ps_lines="$(read_ps_lines)"
    mysqld_line="$(printf '%s\n' "$ps_lines" | grep -E '[ /](mysqld|mariadbd)( |$)' | grep -vE 'mysqld_safe|grep' | head -1 || true)"
    mysqld_safe_line="$(printf '%s\n' "$ps_lines" | grep -E '[ /](mysqld_safe|mariadbd-safe)( |$)' | grep -v grep | head -1 || true)"
    MYSQLD_PID_DETECTED="$(printf '%s\n' "$mysqld_line" | awk '{print $2}')"

    defaults_file="$(extract_proc_arg "$mysqld_line" '--defaults-file')"
    [[ -z "$defaults_file" ]] && defaults_file="$(extract_proc_arg "$mysqld_safe_line" '--defaults-file')"
    if [[ "$EXPLICIT_DEFAULTS_FILE" -eq 0 && -n "$defaults_file" && -f "$defaults_file" ]]; then
        DEFAULTS_FILE="$defaults_file"
        AUTO_DETECT_NOTES+=("defaults-file=${DEFAULTS_FILE}")
    elif [[ -z "$DEFAULTS_FILE" ]]; then
        DEFAULTS_FILE="$(first_existing_file /etc/my.cnf /etc/mysql/my.cnf /usr/local/mysql/etc/my.cnf /opt/mysql/my.cnf 2>/dev/null || true)"
        [[ -n "$DEFAULTS_FILE" ]] && AUTO_DETECT_NOTES+=("defaults-file=${DEFAULTS_FILE}")
    fi

    basedir="$(extract_proc_arg "$mysqld_line" '--basedir')"
    datadir="$(extract_proc_arg "$mysqld_line" '--datadir')"
    socket="$(extract_proc_arg "$mysqld_line" '--socket')"
    port="$(extract_proc_arg "$mysqld_line" '--port')"
    mysqld_bin="$(printf '%s\n' "$mysqld_line" | awk '{for (i=8; i<=NF; i++) if ($i ~ /\/(mysqld|mariadbd)$/) { print $i; exit }}')"

    if [[ -n "$DEFAULTS_FILE" ]]; then
        [[ -z "$basedir" ]] && basedir="$(cnf_get "$DEFAULTS_FILE" mysqld basedir || true)"
        [[ -z "$datadir" ]] && datadir="$(cnf_get "$DEFAULTS_FILE" mysqld datadir || true)"
        [[ -z "$socket" ]] && socket="$(cnf_get "$DEFAULTS_FILE" mysqld socket || true)"
        [[ -z "$socket" ]] && socket="$(cnf_get "$DEFAULTS_FILE" client socket || true)"
        [[ -z "$port" ]] && port="$(cnf_get "$DEFAULTS_FILE" mysqld port || true)"
        [[ -z "$port" ]] && port="$(cnf_get "$DEFAULTS_FILE" client port || true)"
        if [[ "$EXPLICIT_USER" -eq 0 ]]; then
            local cnf_user
            cnf_user="$(cnf_get "$DEFAULTS_FILE" client user || true)"
            [[ -n "$cnf_user" ]] && DB_USER="$cnf_user"
        fi
        if [[ "$EXPLICIT_PASSWORD" -eq 0 ]]; then
            local cnf_pwd
            cnf_pwd="$(cnf_get "$DEFAULTS_FILE" client password || true)"
            [[ -n "$cnf_pwd" ]] && DB_PWD="$cnf_pwd"
        fi
    fi

    if [[ "$EXPLICIT_SOCKET" -eq 0 && -n "$socket" ]]; then
        DB_SOCKET="$socket"
        AUTO_DETECT_NOTES+=("socket=${DB_SOCKET}")
    fi
    if [[ "$EXPLICIT_PORT" -eq 0 && -n "$port" ]]; then
        DB_PORT="$port"
        AUTO_DETECT_NOTES+=("port=${DB_PORT}")
    fi

    if [[ "$EXPLICIT_MYSQL_CMD" -eq 0 ]]; then
        local candidate=""
        if [[ -n "$basedir" && -x "$basedir/bin/mysql" ]]; then
            candidate="$basedir/bin/mysql"
        elif [[ -n "$mysqld_bin" && -x "$(dirname "$mysqld_bin")/mysql" ]]; then
            candidate="$(dirname "$mysqld_bin")/mysql"
        elif command -v mysql >/dev/null 2>&1; then
            candidate="$(command -v mysql)"
        elif [[ -x /usr/local/mysql/bin/mysql ]]; then
            candidate="/usr/local/mysql/bin/mysql"
        elif [[ -x /opt/mysql/bin/mysql ]]; then
            candidate="/opt/mysql/bin/mysql"
        fi
        EXEC_MYSQL="$candidate"
        [[ -n "$EXEC_MYSQL" ]] && AUTO_DETECT_NOTES+=("mysql-cmd=${EXEC_MYSQL}")
    fi

    if [[ -z "$MYSQL_SSL_OPTION" ]]; then
        MYSQL_SSL_OPTION="--ssl-mode=DISABLED"
    fi
}

cleanup_defaults_extra_file() {
    [[ -n "$MYSQL_DEFAULTS_EXTRA_FILE" && -f "$MYSQL_DEFAULTS_EXTRA_FILE" ]] && rm -f "$MYSQL_DEFAULTS_EXTRA_FILE"
}
trap cleanup_defaults_extra_file EXIT

prepare_mysql_defaults_extra_file() {
    MYSQL_DEFAULTS_EXTRA_FILE="$(mktemp /tmp/mysql-healthcheck-client.XXXXXX.cnf)"
    chmod 600 "$MYSQL_DEFAULTS_EXTRA_FILE"
    {
        echo "[client]"
        [[ -n "$DB_USER" ]] && printf 'user=%s\n' "$DB_USER"
        [[ -n "$DB_PWD" ]] && printf 'password=%s\n' "$DB_PWD"
        if [[ -n "$DB_SOCKET" ]]; then
            printf 'socket=%s\n' "$DB_SOCKET"
        else
            [[ -n "$DB_HOST" ]] && printf 'host=%s\n' "$DB_HOST"
            [[ -n "$DB_PORT" ]] && printf 'port=%s\n' "$DB_PORT"
        fi
    } > "$MYSQL_DEFAULTS_EXTRA_FILE"
}

build_mysql_args() {
    MYSQL_ARGS=(--defaults-extra-file="$MYSQL_DEFAULTS_EXTRA_FILE")
    if [[ -n "$DB_SOCKET" ]]; then
        MYSQL_ARGS+=(--protocol=SOCKET --socket="$DB_SOCKET")
    else
        MYSQL_ARGS+=(--host="$DB_HOST" --port="$DB_PORT")
    fi
    [[ -n "$MYSQL_SSL_OPTION" ]] && MYSQL_ARGS+=("$MYSQL_SSL_OPTION")
    MYSQL_ARGS+=(--connect-timeout=10)
}

mysql_try_login() {
    local ssl_opt="$1"
    local out rc
    MYSQL_SSL_OPTION="$ssl_opt"
    build_mysql_args
    out=$("$EXEC_MYSQL" "${MYSQL_ARGS[@]}" -s -N -e "SELECT VERSION();" 2>&1)
    rc=$?
    if [[ "$rc" -eq 0 && -n "$out" ]]; then
        DB_VERSION_FULL="$out"
        DB_VERSION="$(printf '%s\n' "$out" | awk -F. '{print $1 "." $2}')"
        return 0
    fi
    printf '%s\n' "$out"
    return "$rc"
}

test_mysql_login_or_exit() {
    local last_err="" err_file
    if [[ -z "$EXEC_MYSQL" || ! -x "$EXEC_MYSQL" ]]; then
        echo "错误：未找到可执行 mysql 客户端。请使用 --mysql-cmd 指定，或确认 mysqld basedir/bin/mysql 存在。" >&2
        exit 1
    fi

    prepare_mysql_defaults_extra_file

    err_file="$(mktemp /tmp/mysql-healthcheck-login.XXXXXX.err)"
    for opt in "${MYSQL_SSL_OPTION:-}" "--ssl=0" ""; do
        if mysql_try_login "$opt" >"$err_file" 2>&1; then
            [[ -n "$opt" ]] && MYSQL_SSL_OPTION="$opt"
            build_mysql_args
            rm -f "$err_file"
            return 0
        fi
        last_err="$(cat "$err_file" 2>/dev/null)"
    done
    rm -f "$err_file"

    echo "错误：无法登录 MySQL，采集已终止。" >&2
    echo "  mysql: ${EXEC_MYSQL}" >&2
    if [[ -n "$DB_SOCKET" ]]; then
        echo "  socket: ${DB_SOCKET}" >&2
    else
        echo "  host/port: ${DB_HOST}:${DB_PORT}" >&2
    fi
    echo "  user: ${DB_USER}" >&2
    [[ -n "$DEFAULTS_FILE" ]] && echo "  defaults-file: ${DEFAULTS_FILE}" >&2
    echo "  最后一次错误：" >&2
    printf '%s\n' "$last_err" >&2
    exit 1
}

detect_mysql_runtime

# ============== 交互式补全（仅在缺关键参数时）==============
if [[ "$NON_INTERACTIVE" -eq 0 && -z "$DB_PWD" ]]; then
    IP_ADDR=$(ip addr show 2>/dev/null | awk '/inet / && /brd/ {print $2}' | cut -d/ -f1 | awk 'NR==1')
    [[ -z "$IP_ADDR" ]] && IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')

    echo "============================================================"
    echo "  MySQL 巡检脚本 V3.0 — 连接信息确认"
    echo "============================================================"
    [[ ${#AUTO_DETECT_NOTES[@]} -gt 0 ]] && printf '  自动发现：%s\n' "${AUTO_DETECT_NOTES[*]}"
    read -e -p "  mysql 客户端路径   [${EXEC_MYSQL}]: " _t; EXEC_MYSQL="${_t:-$EXEC_MYSQL}"
    read -e -p "  mysqld 配置文件     [${DEFAULTS_FILE}]: " _t; DEFAULTS_FILE="${_t:-$DEFAULTS_FILE}"
    read -e -p "  用户名             [${DB_USER}]: " _t; DB_USER="${_t:-$DB_USER}"
    read -s -p "  密码               (输入隐藏): " DB_PWD; echo
    read -e -p "  Socket             [${DB_SOCKET}]: " _t; DB_SOCKET="${_t:-$DB_SOCKET}"
    read -e -p "  目标主机 IP        [${DB_HOST}（当前机器 $IP_ADDR，socket 非空时优先 socket）]: " _t; DB_HOST="${_t:-$DB_HOST}"
    read -e -p "  端口               [${DB_PORT}]: " _t; DB_PORT="${_t:-$DB_PORT}"
    read -e -p "  输出目录           [${OUT_DIR}]: " _t; OUT_DIR="${_t:-$OUT_DIR}"
fi

test_mysql_login_or_exit

if [[ "$TEST_LOGIN_ONLY" -eq 1 ]]; then
    echo "MySQL 登录测试成功"
    echo "  mysql: ${EXEC_MYSQL}"
    [[ -n "$DEFAULTS_FILE" ]] && echo "  defaults-file: ${DEFAULTS_FILE}"
    if [[ -n "$DB_SOCKET" ]]; then
        echo "  socket: ${DB_SOCKET}"
    else
        echo "  host/port: ${DB_HOST}:${DB_PORT}"
    fi
    echo "  user: ${DB_USER}"
    echo "  version: ${DB_VERSION_FULL}"
    echo "  ssl-option: ${MYSQL_SSL_OPTION:-无}"
    exit 0
fi

if [[ "${MYSQL_HEALTHCHECK_SKIP_COLLECTION:-0}" = "1" ]]; then
    echo "MySQL 登录测试成功（跳过采集：MYSQL_HEALTHCHECK_SKIP_COLLECTION=1）"
    exit 0
fi

# ============== 输出文件 ==============
IP_ADDR=$(ip addr show 2>/dev/null | awk '/inet / && /brd/ {print $2}' | cut -d/ -f1 | awk 'NR==1')
[[ -z "$IP_ADDR" ]] && IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
[[ -z "$IP_ADDR" ]] && IP_ADDR="${DB_HOST}"

QC_TIME=$(date +'%Y%m%d%H%M')
mkdir -p "$OUT_DIR"
OUT_FILE="${OUT_DIR}/MySQLHealthCheck_${IP_ADDR}_${QC_TIME}.txt"

# 重定向所有输出到 txt（保留 stderr 到屏幕）
exec 3>&1
exec > "$OUT_FILE"

# ============== MySQL 执行包装 ==============
run_sql() {
    # 表格格式（默认）
    "$EXEC_MYSQL" "${MYSQL_ARGS[@]}" -t -e "$1" 2>&1
}
run_sql_silent() {
    # 取单值
    "$EXEC_MYSQL" "${MYSQL_ARGS[@]}" -s -N -e "$1" 2>/dev/null
}
run_sql_vert() {
    # \G 垂直格式
    "$EXEC_MYSQL" "${MYSQL_ARGS[@]}" -e "$1\G" 2>&1
}

# ============== 段标记 ==============
section() {
    # $1 = 模块编号 (例: 01), $2 = 段名
    echo ""
    echo "----->>>---->>>  [$1] $2"
}

module_header() {
    # $1 = 模块标题
    echo ""
    echo "|+++++++++++++++++++++++++++++++++++++++++++++++++++++++++|"
    printf  "|  %-55s|\n" "$1"
    echo "|+++++++++++++++++++++++++++++++++++++++++++++++++++++++++|"
}

skip_module() {
    # $1 = 模块名
    [[ ",${SKIP_MODULES}," == *",$1,"* ]]
}

# ============== 全局：MySQL 版本探测 ==============
DB_VERSION=${DB_VERSION:-$(run_sql_silent "SELECT LEFT(VERSION(),3);")}
DB_VERSION_FULL=${DB_VERSION_FULL:-$(run_sql_silent "SELECT VERSION();")}
SLAVE_LOG_FILE=$(run_sql_silent "SELECT @@slow_query_log_file;")
ERROR_LOG_PATH=$(run_sql_silent "SELECT @@log_error;")
DATA_DIR=$(run_sql_silent "SELECT @@datadir;")

echo "================================================================"
echo "  MySQL 巡检报告 V3.0"
echo "  采集时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "  目标实例：${DB_HOST}:${DB_PORT}"
[[ -n "$DB_SOCKET" ]] && echo "  连接 socket：${DB_SOCKET}"
[[ -n "$DEFAULTS_FILE" ]] && echo "  配置文件：${DEFAULTS_FILE}"
echo "  mysql 客户端：${EXEC_MYSQL}"
echo "  MySQL 版本：${DB_VERSION_FULL} (主版本 ${DB_VERSION})"
echo "  本机 IP：${IP_ADDR}"
echo "================================================================"

###############################################################################
# 模块 01：操作系统与硬件
###############################################################################
collect_os() {
    skip_module "os" && { echo "(skipped)"; return; }
    module_header "[01] 操作系统与硬件"

    section "01" "hostname"
    hostname -s 2>&1

    section "01" "os kernal"
    uname -a 2>&1

    section "01" "os release"
    cat /etc/os-release 2>&1 || cat /etc/redhat-release 2>&1 || true

    section "01" "ip info"
    ip addr show 2>&1 || ifconfig 2>&1

    section "01" "CPU model"
    grep -m1 "model name" /proc/cpuinfo 2>&1 | sed 's/.*: //'
    grep -m1 "cpu MHz" /proc/cpuinfo 2>&1

    section "01" "CPU cores"
    grep "^processor" /proc/cpuinfo 2>&1 | wc -l

    section "01" "NUMA info"
    numactl --hardware 2>/dev/null || echo "(numactl 未安装)"

    section "01" "mem info"
    cat /proc/meminfo 2>&1

    section "01" "mem usage"
    free -m 2>&1
    echo ""
    vmstat 1 5 2>&1

    section "01" "CPU usage"
    sar 1 5 2>/dev/null || (top -bn 2 -d 1 2>&1 | tail -50)

    section "01" "Top Info"
    top -bn 1 2>&1 | head -30

    section "01" "ntp Info"
    chronyc tracking 2>/dev/null || ntpstat 2>/dev/null || timedatectl 2>/dev/null
    date 2>&1

    section "01" "resource limit"
    ulimit -a 2>&1
    echo ""
    cat /etc/security/limits.conf 2>&1 | grep -v "^#" | grep -v "^$" || true

    section "01" "swap method"
    cat /proc/sys/vm/swappiness 2>&1
    cat /proc/sys/vm/vfs_cache_pressure 2>&1
    cat /proc/sys/vm/dirty_ratio 2>&1
    cat /proc/sys/vm/dirty_background_ratio 2>&1

    section "01" "io scheduler"
    for dev in $(ls /sys/block/ 2>/dev/null | grep -vE 'loop|ram'); do
        if [[ -f "/sys/block/$dev/queue/scheduler" ]]; then
            echo "/sys/block/$dev/queue/scheduler: $(cat /sys/block/$dev/queue/scheduler)"
        fi
    done

    section "01" "io usage"
    iostat -x -k 2 3 2>/dev/null || echo "(iostat 未安装，请 yum install sysstat)"

    section "01" "disk mount"
    df -h 2>&1

    section "01" "mount options"
    grep -E '/data|/mysql|/opt' /proc/mounts 2>&1 || cat /proc/mounts 2>&1 | head -20

    section "01" "dist type"
    lsblk -d -o name,rota,size,model 2>&1

    section "01" "kernel params"
    sysctl -a 2>/dev/null | grep -E '^(vm\.swappiness|vm\.dirty_|vm\.overcommit_|fs\.file-max|fs\.aio-max|net\.core\.somaxconn|net\.ipv4\.tcp_)' | sort

    section "01" "network connections to MySQL"
    {
        ss -tn state established '( dport = :'$DB_PORT' or sport = :'$DB_PORT' )' 2>/dev/null | wc -l
        echo "(已建立连接数到端口 ${DB_PORT})"
    }

    section "01" "my.cnf detail"
    if [[ -n "$DEFAULTS_FILE" && -f "$DEFAULTS_FILE" ]]; then
        print_cnf_redacted "$DEFAULTS_FILE"
        print_include_cnf_files "$DEFAULTS_FILE"
    elif [[ -f /etc/my.cnf ]]; then
        print_cnf_redacted /etc/my.cnf
        print_include_cnf_files /etc/my.cnf
    elif [[ -f /etc/mysql/my.cnf ]]; then
        print_cnf_redacted /etc/mysql/my.cnf
        print_include_cnf_files /etc/mysql/my.cnf
    else
        echo "(未找到 MySQL 配置文件；已检查 mysqld --defaults-file、/etc/my.cnf、/etc/mysql/my.cnf)"
    fi

    section "01" "mysqld process"
    ps -ef 2>&1 | grep -E 'mysqld|mariadbd' | grep -v grep

    section "01" "mysqld process limits"
    MYSQLD_PID="$MYSQLD_PID_DETECTED"
    [[ -z "$MYSQLD_PID" ]] && MYSQLD_PID=$(ps -ef 2>/dev/null | grep -E '[ /](mysqld|mariadbd)( |$)' | grep -vE 'mysqld_safe|grep' | awk 'NR==1 {print $2}')
    if [[ -n "$MYSQLD_PID" ]]; then
        echo "mysqld pid: $MYSQLD_PID"
        cat /proc/$MYSQLD_PID/limits 2>/dev/null | head -20
    else
        echo "(未找到 mysqld 进程)"
    fi
}

###############################################################################
# 模块 02：MySQL 基础信息
###############################################################################
collect_mysql_basic() {
    skip_module "basic" && { echo "(skipped)"; return; }
    module_header "[02] MySQL 基础信息"

    section "02" "MySQL Database Version"
    run_sql "STATUS"

    section "02" "Version details"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_VARIABLES WHERE VARIABLE_NAME LIKE 'version_%';"
    else
        run_sql "SELECT * FROM performance_schema.global_variables WHERE VARIABLE_NAME LIKE 'version_%';"
    fi

    section "02" "Plugins info"
    run_sql "SELECT PLUGIN_NAME, PLUGIN_VERSION, PLUGIN_STATUS, PLUGIN_TYPE, PLUGIN_LIBRARY, LOAD_OPTION FROM INFORMATION_SCHEMA.PLUGINS WHERE PLUGIN_STATUS='ACTIVE';"

    section "02" "Database basic info"
    run_sql "SELECT NOW() AS now_date,USER() AS user,CURRENT_USER() AS current_user1,CONNECTION_ID() AS connection_id,DATABASE() AS db_name,VERSION() AS version,@@datadir AS datadir,@@socket AS socket,@@server_id AS server_id,@@server_uuid AS server_uuid,@@log_error AS log_error;"
}

###############################################################################
# 模块 03：变量与配置
###############################################################################
collect_variables() {
    skip_module "variables" && { echo "(skipped)"; return; }
    module_header "[03] 变量与配置"

    section "03" "MySQL Variables"
    local sql="SELECT @@global.binlog_format AS binlog_format,
@@global.innodb_buffer_pool_size/1024/1024 AS innodb_buffer_pool_size_in_mb,
@@global.innodb_flush_method,
@@global.binlog_cache_size/1024 AS binlog_cache_size_in_kb,
@@global.innodb_purge_threads,
@@global.innodb_read_io_threads,
@@global.innodb_write_io_threads,
@@global.innodb_buffer_pool_instances,
@@global.expire_logs_days AS expire_logs_days,
@@global.innodb_log_buffer_size/1024/1024 AS innodb_log_buffer_size_in_mb,
@@global.innodb_log_file_size/1024/1024 AS innodb_log_file_size_in_mb,
@@global.wait_timeout,
@@global.interactive_timeout,
@@global.innodb_lock_wait_timeout,
@@global.slave_net_timeout,
@@global.tmp_table_size/1024/1024 AS tmp_table_size_in_mb,
@@global.max_heap_table_size/1024/1024 AS max_heap_table_size_in_mb,
@@global.read_only,
@@global.join_buffer_size/1024 AS join_buffer_size_in_kb,
@@global.sort_buffer_size/1024 AS sort_buffer_size_in_kb,
@@global.read_buffer_size/1024 AS read_buffer_size_in_kb,
@@global.read_rnd_buffer_size/1024 AS read_rnd_buffer_size_in_kb,
@@global.max_allowed_packet/1024/1024 AS max_allowed_packet_in_mb,
@@global.slave_parallel_workers,
@@global.log_bin,
@@global.gtid_mode,
@@global.enforce_gtid_consistency,
@@global.innodb_doublewrite,
@@global.innodb_flush_log_at_trx_commit,
@@global.sync_binlog,
@@global.innodb_data_file_path,
@@global.innodb_temp_data_file_path,
@@global.open_files_limit,
@@global.innodb_open_files,
@@global.slow_query_log,
@@global.slow_query_log_file,
@@global.long_query_time,
@@global.lower_case_table_names,
@@global.table_open_cache,
@@global.table_definition_cache,
@@global.innodb_file_per_table,
@@global.max_connections,
@@global.max_connect_errors,
@@global.transaction_isolation,
@@global.default_storage_engine,
@@global.innodb_adaptive_hash_index,
@@global.basedir,
@@global.datadir,
@@global.socket,
@@global.pid_file,
@@global.log_error,
@@global.server_id"
    run_sql_vert "$sql"

    section "03" "Important variables (subset)"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_VARIABLES WHERE VARIABLE_NAME IN ('datadir','SQL_MODE','socket','TIME_ZONE','tx_isolation','autocommit','innodb_lock_wait_timeout','max_connections','slow_query_log','long_query_time','pid_file','log_error','lower_case_table_names','innodb_buffer_pool_size','innodb_flush_log_at_trx_commit','read_only','log_slave_updates','innodb_io_capacity','max_connect_errors','server_id');"
    else
        run_sql "SELECT * FROM performance_schema.global_variables WHERE VARIABLE_NAME IN ('datadir','SQL_MODE','socket','time_zone','transaction_isolation','autocommit','innodb_lock_wait_timeout','max_connections','slow_query_log','long_query_time','pid_file','log_error','lower_case_table_names','innodb_buffer_pool_size','innodb_flush_log_at_trx_commit','read_only','log_slave_updates','innodb_io_capacity','max_connect_errors','server_id');"
    fi

    section "03" "Performance schema sizing"
    run_sql "SELECT * FROM performance_schema.global_variables WHERE VARIABLE_NAME LIKE 'performance_schema_%' LIMIT 30;" 2>/dev/null
}

###############################################################################
# 模块 04：复制状态
###############################################################################
collect_replication() {
    skip_module "replication" && { echo "(skipped)"; return; }
    module_header "[04] 主从复制状态"

    section "04" "MySQL Replication Info"
    run_sql "SHOW SLAVE HOSTS;"
    echo ""
    run_sql_vert "SHOW SLAVE STATUS"

    section "04" "Master status"
    run_sql "SHOW MASTER STATUS;"

    section "04" "Binary logs"
    run_sql "SHOW BINARY LOGS;"

    section "04" "GTID sets"
    run_sql "SELECT @@global.gtid_executed AS gtid_executed, @@global.gtid_purged AS gtid_purged;" 2>/dev/null

    section "04" "Semi sync variables"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_VARIABLES WHERE VARIABLE_NAME LIKE 'rpl_semi%';"
    else
        run_sql "SELECT * FROM performance_schema.global_variables WHERE VARIABLE_NAME LIKE 'rpl_semi%';"
    fi

    section "04" "Semi sync status"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_STATUS WHERE VARIABLE_NAME LIKE 'rpl_semi%';"
    else
        run_sql "SELECT * FROM performance_schema.global_status WHERE VARIABLE_NAME LIKE 'rpl_semi%';"
    fi

    section "04" "Replication threads"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT * FROM performance_schema.threads WHERE NAME LIKE '%slave%' OR NAME LIKE '%replica%' OR PROCESSLIST_COMMAND LIKE 'Binlog%';"
    fi

    section "04" "Replication group members"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT * FROM performance_schema.replication_group_members;" 2>/dev/null
        run_sql_vert "SELECT * FROM performance_schema.replication_group_member_stats" 2>/dev/null
    fi

    section "04" "Replication connection status"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql_vert "SELECT * FROM performance_schema.replication_connection_status" 2>/dev/null
        run_sql_vert "SELECT * FROM performance_schema.replication_applier_status_by_worker" 2>/dev/null
    fi
}

###############################################################################
# 模块 05：存储与对象
###############################################################################
collect_storage() {
    skip_module "storage" && { echo "(skipped)"; return; }
    module_header "[05] 存储与对象"

    section "05" "DB TOTAL SIZE"
    run_sql "SELECT 'DATABASE TOTAL SIZE' AS database_name, ROUND(SUM(data_length+index_length)/1024/1024/1024,3) AS 'DATABASE SIZE GB'
FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
UNION ALL
SELECT table_schema, ROUND(SUM(data_length+index_length)/1024/1024/1024,3)
FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
GROUP BY table_schema ORDER BY 2 DESC;"

    section "05" "All databases and size details"
    run_sql "SELECT a.SCHEMA_NAME, a.DEFAULT_CHARACTER_SET_NAME, a.DEFAULT_COLLATION_NAME,
SUM(b.table_rows) AS table_rows,
TRUNCATE(SUM(b.data_length)/1024/1024, 2) AS data_size_mb,
TRUNCATE(SUM(b.index_length)/1024/1024, 2) AS index_size_mb,
TRUNCATE(SUM(b.data_length+b.index_length)/1024/1024, 2) AS all_size_mb,
TRUNCATE(SUM(b.data_free)/1024/1024, 2) AS free_size_mb
FROM INFORMATION_SCHEMA.SCHEMATA a
LEFT JOIN INFORMATION_SCHEMA.TABLES b ON a.SCHEMA_NAME=b.TABLE_SCHEMA
WHERE a.SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema')
GROUP BY a.SCHEMA_NAME, a.DEFAULT_CHARACTER_SET_NAME, a.DEFAULT_COLLATION_NAME
ORDER BY SUM(b.data_length) DESC;"

    section "05" "Database objects summary"
    run_sql "SELECT db AS db_name, type AS ob_type, cnt AS sums FROM (
SELECT 'TABLE' AS type, table_schema AS db, COUNT(*) AS cnt FROM information_schema.tables WHERE table_type='BASE TABLE' GROUP BY table_schema
UNION ALL SELECT 'EVENT', event_schema, COUNT(*) FROM information_schema.events GROUP BY event_schema
UNION ALL SELECT 'TRIGGER', trigger_schema, COUNT(*) FROM information_schema.triggers GROUP BY trigger_schema
UNION ALL SELECT 'PROCEDURE', routine_schema, COUNT(*) FROM information_schema.routines WHERE routine_type='PROCEDURE' GROUP BY routine_schema
UNION ALL SELECT 'FUNCTION', routine_schema, COUNT(*) FROM information_schema.routines WHERE routine_type='FUNCTION' GROUP BY routine_schema
UNION ALL SELECT 'VIEW', table_schema, COUNT(*) FROM information_schema.views GROUP BY table_schema
) t ORDER BY db, type;"

    section "05" "Top 10 Tables"
    run_sql "SET sql_mode='';
SELECT table_schema, table_name,
ROUND(SUM(data_length+index_length)/1024/1024/1024,3) AS 'SIZE(GB)',
table_rows, engine
FROM information_schema.tables
WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
GROUP BY table_schema, table_name
ORDER BY SUM(data_length+index_length) DESC LIMIT 10;"

    section "05" "Top 10 Index Size"
    run_sql "SELECT iis.database_name, iis.table_name, iis.index_name,
ROUND((iis.stat_value*@@innodb_page_size)/1024/1024, 2) AS SizeMB,
s.NON_UNIQUE, s.INDEX_TYPE,
GROUP_CONCAT(s.COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLUMN_NAME
FROM (SELECT * FROM mysql.innodb_index_stats WHERE index_name NOT IN ('PRIMARY','GEN_CLUST_INDEX') AND stat_name='size' ORDER BY (stat_value*@@innodb_page_size) DESC LIMIT 10) iis
LEFT JOIN INFORMATION_SCHEMA.STATISTICS s ON (iis.database_name=s.TABLE_SCHEMA AND iis.table_name=s.TABLE_NAME AND iis.index_name=s.INDEX_NAME)
GROUP BY iis.database_name, iis.table_name, iis.index_name, (iis.stat_value*@@innodb_page_size), s.NON_UNIQUE, s.INDEX_TYPE
ORDER BY (stat_value*@@innodb_page_size) DESC;" 2>/dev/null

    section "05" "Tables fragment rate > 30%"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, table_rows, data_length, index_length, data_free,
IF(table_rows IS NULL, 0, ROUND(data_free/(data_length+index_length+data_free), 2)) AS fragment_rate
FROM information_schema.TABLES
WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','performance_schema')
AND (data_length+index_length) > 4194304
AND IF(table_rows IS NULL, 0, ROUND(data_free/(data_length+index_length+data_free), 2)) > 0.3
LIMIT 100;"

    section "05" "Not utf8 table"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_COLLATION NOT LIKE 'utf8%' AND table_schema NOT IN ('information_schema','mysql','performance_schema','sys');"

    section "05" "BLOB info"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','performance_schema')
AND DATA_TYPE IN ('BLOB','LONGBLOB','LONGTEXT','MEDIUMBLOB','MEDIUMTEXT','TEXT','TINYBLOB','TINYTEXT');"

    section "05" "PARTITIONS table"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, COUNT(1) AS PARTITION_COUNT FROM information_schema.PARTITIONS
WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','performance_schema')
GROUP BY TABLE_SCHEMA, TABLE_NAME HAVING PARTITION_COUNT > 1 LIMIT 100;"

    section "05" "NOT BASE TABLE"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','performance_schema') AND TABLE_TYPE <> 'BASE TABLE' LIMIT 100;"

    section "05" "ROUTINES OBJECTS"
    run_sql "SELECT routine_schema, routine_name, routine_type, definer FROM information_schema.routines WHERE routine_schema NOT IN ('information_schema','mysql','sys','performance_schema');"

    section "05" "database CHARACTER"
    run_sql "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema');"

    section "05" "DATA_TYPE (non-standard)"
    run_sql "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, CAST(DATA_TYPE AS CHAR) AS DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','performance_schema')
AND UPPER(DATA_TYPE) NOT IN ('BIGINT','CHAR','DATE','DATETIME','DECIMAL','DOUBLE','FLOAT','INTEGER','MEDIUMINT','SMALLINT','TIMESTAMP','TINYINT','VARCHAR','INT')
LIMIT 100;"

    section "05" "auto_increment usage"
    run_sql "SELECT
    t.table_schema, t.table_name, c.column_name, t.AUTO_INCREMENT,
    ROUND(t.AUTO_INCREMENT * 1.0 / (POW(2,
        CASE c.data_type WHEN 'tinyint' THEN 7 WHEN 'smallint' THEN 15 WHEN 'mediumint' THEN 23 WHEN 'int' THEN 31 WHEN 'bigint' THEN 63 END
        + (c.column_type LIKE '% unsigned')
    ) - 1), 4) AS auto_increment_rate
FROM information_schema.TABLES t
JOIN information_schema.COLUMNS c USING (table_schema, table_name)
WHERE c.extra = 'auto_increment'
AND t.TABLE_SCHEMA NOT IN ('information_schema','mysql','sys','test','performance_schema')
AND t.AUTO_INCREMENT IS NOT NULL
ORDER BY auto_increment_rate DESC LIMIT 30;"

    section "05" "NO PRIMARY KEY TABLES"
    run_sql "SELECT A.table_schema, A.table_name FROM information_schema.tables A
LEFT JOIN (SELECT table_schema, table_name FROM information_schema.statistics WHERE index_name='PRIMARY') B
ON A.table_schema=B.table_schema AND A.table_name=B.table_name
WHERE A.table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
AND A.table_type='BASE TABLE' AND B.table_name IS NULL;"

    section "05" "Not innodb table"
    run_sql "SELECT table_schema, table_name, engine FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema') AND engine <> 'InnoDB';"

    section "05" "All engines"
    run_sql "SELECT * FROM information_schema.ENGINES;"

    section "05" "innodb_tablespaces (含 ibtmp1)"
    if [[ "$DB_VERSION" == "8.0" ]]; then
        run_sql "SELECT SPACE, NAME, FLAG, FILE_SIZE, ALLOCATED_SIZE, AUTOEXTEND_SIZE FROM information_schema.INNODB_TABLESPACES WHERE NAME LIKE '%ibtmp%' OR NAME='innodb_temporary';"
    else
        run_sql "SELECT * FROM INFORMATION_SCHEMA.FILES WHERE FILE_TYPE <> 'TABLESPACE' OR TABLESPACE_NAME IN ('innodb_system','innodb_temporary');"
    fi
}

###############################################################################
# 模块 06：用户与权限
###############################################################################
collect_users() {
    skip_module "users" && { echo "(skipped)"; return; }
    module_header "[06] 用户与权限"

    section "06" "user check"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT user, host, password_expired FROM mysql.user;"
    else
        run_sql "SELECT user, host, password_expired, password_last_changed, password_lifetime, account_locked, plugin FROM mysql.user;"
    fi

    section "06" "All users (with privileges)"
    run_sql "SELECT user, host, plugin,
Select_priv, Insert_priv, Update_priv, Delete_priv,
Create_priv, Drop_priv, Reload_priv, Shutdown_priv,
Process_priv, File_priv, Grant_priv, Super_priv, Repl_slave_priv, Repl_client_priv,
Create_user_priv
FROM mysql.user;"

    section "06" "password check (expire within 30 days)"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT CONCAT(USER,'@',HOST) AS user_host, DATE_ADD(password_last_changed, INTERVAL password_lifetime DAY) AS expire_time
FROM mysql.user
WHERE password_lifetime IS NOT NULL
AND DATEDIFF(DATE_ADD(password_last_changed, INTERVAL password_lifetime DAY), NOW()) < 30;"
    fi

    section "06" "current connection user and host"
    run_sql "SELECT DISTINCT USER, HOST FROM information_schema.PROCESSLIST WHERE USER NOT IN ('repl','system user') LIMIT 100;"

    section "06" "host connections stats"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT HOST, CURRENT_CONNECTIONS, TOTAL_CONNECTIONS FROM performance_schema.hosts ORDER BY TOTAL_CONNECTIONS DESC LIMIT 50;"
    fi

    section "06" "failed login attempts (host_cache)"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT IP, HOST, SUM_CONNECT_ERRORS, COUNT_HANDSHAKE_ERRORS, COUNT_AUTHENTICATION_ERRORS, COUNT_HOST_BLOCKED_ERRORS, FIRST_ERROR_SEEN, LAST_ERROR_SEEN FROM performance_schema.host_cache ORDER BY SUM_CONNECT_ERRORS DESC LIMIT 20;" 2>/dev/null
    fi

    section "06" "login info by user+host"
    run_sql "SELECT USER AS login_user, LEFT(HOST, IFNULL(POSITION(':' IN HOST)-1, LENGTH(HOST))) AS login_ip, COUNT(1) AS login_count FROM information_schema.PROCESSLIST GROUP BY USER, LEFT(HOST, IFNULL(POSITION(':' IN HOST)-1, LENGTH(HOST)));"

    section "06" "login info by db+user+host"
    run_sql "SELECT DB AS database_name, USER AS login_user, LEFT(HOST, IFNULL(POSITION(':' IN HOST)-1, LENGTH(HOST))) AS login_ip, COUNT(1) AS login_count FROM information_schema.PROCESSLIST GROUP BY DB, USER, LEFT(HOST, IFNULL(POSITION(':' IN HOST)-1, LENGTH(HOST)));"
}

###############################################################################
# 模块 07：会话与锁
###############################################################################
collect_sessions_locks() {
    skip_module "sessions" && { echo "(skipped)"; return; }
    module_header "[07] 会话与锁"

    section "07" "Processlist info"
    run_sql "SELECT * FROM information_schema.processlist WHERE id <> CONNECTION_ID() ORDER BY time DESC;"

    section "07" "All processlist (no sleep)"
    run_sql "SELECT * FROM information_schema.PROCESSLIST WHERE command <> 'Sleep' AND id <> CONNECTION_ID();"

    section "07" "Sleep threads top 20"
    run_sql "SELECT * FROM information_schema.PROCESSLIST WHERE command = 'Sleep' ORDER BY time DESC LIMIT 20;"

    section "07" "Threads info (no sleep, perf_schema)"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT THREAD_ID, NAME, TYPE, PROCESSLIST_ID, PROCESSLIST_USER, PROCESSLIST_HOST, PROCESSLIST_DB, PROCESSLIST_COMMAND, PROCESSLIST_TIME, PROCESSLIST_STATE FROM performance_schema.threads WHERE TYPE <> 'BACKGROUND' AND PROCESSLIST_COMMAND <> 'Sleep' AND PROCESSLIST_ID <> CONNECTION_ID();"
    fi

    section "07" "Open tables in use"
    run_sql "SHOW OPEN TABLES WHERE in_use > 0;"

    section "07" "INNODB LOCKS"
    if [[ "$DB_VERSION" == "8.0" ]]; then
        run_sql "SELECT * FROM performance_schema.data_locks LIMIT 100;" 2>/dev/null
    else
        run_sql "SELECT * FROM information_schema.innodb_locks LIMIT 100;" 2>/dev/null
    fi

    section "07" "INNODB LOCK WAITS"
    if [[ "$DB_VERSION" == "8.0" ]]; then
        run_sql "SELECT * FROM performance_schema.data_lock_waits LIMIT 100;" 2>/dev/null
    else
        run_sql "SELECT * FROM information_schema.innodb_lock_waits LIMIT 100;" 2>/dev/null
    fi

    section "07" "INNODB TRX"
    run_sql "SELECT * FROM information_schema.innodb_trx LIMIT 50;"

    section "07" "LOCK DETAILS (waiting & blocking)"
    if [[ "$DB_VERSION" == "8.0" ]]; then
        run_sql "SELECT r.trx_id AS waiting_trx_id, r.trx_mysql_thread_id AS waiting_thread, r.trx_query AS waiting_query, b.trx_id AS blocking_trx_id, b.trx_mysql_thread_id AS blocking_thread, b.trx_query AS blocking_query FROM performance_schema.data_lock_waits w INNER JOIN information_schema.innodb_trx b ON b.trx_id=w.BLOCKING_ENGINE_TRANSACTION_ID INNER JOIN information_schema.innodb_trx r ON r.trx_id=w.REQUESTING_ENGINE_TRANSACTION_ID LIMIT 50;" 2>/dev/null
    else
        run_sql "SELECT r.trx_id AS waiting_trx_id, r.trx_mysql_thread_id AS waiting_thread, r.trx_query AS waiting_query, b.trx_id AS blocking_trx_id, b.trx_mysql_thread_id AS blocking_thread, b.trx_query AS blocking_query FROM information_schema.innodb_lock_waits w INNER JOIN information_schema.innodb_trx b ON b.trx_id=w.blocking_trx_id INNER JOIN information_schema.innodb_trx r ON r.trx_id=w.requesting_trx_id LIMIT 50;" 2>/dev/null
    fi

    section "07" "Metadata locks"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT * FROM performance_schema.metadata_locks LIMIT 50;" 2>/dev/null
    fi

    section "07" "Lock status counters"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_STATUS WHERE VARIABLE_NAME LIKE '%lock%';"
    else
        run_sql "SELECT * FROM performance_schema.global_status WHERE VARIABLE_NAME LIKE '%lock%';"
    fi
}

###############################################################################
# 模块 08：InnoDB 引擎
###############################################################################
collect_innodb() {
    skip_module "innodb" && { echo "(skipped)"; return; }
    module_header "[08] InnoDB 引擎"

    section "08" "Engine innodb status"
    run_sql_vert "SHOW ENGINE INNODB STATUS"

    section "08" "InnoDB key metrics (filtered)"
    run_sql "SELECT name, count, subsystem FROM information_schema.innodb_metrics WHERE status='enabled' AND subsystem IN ('buffer','transaction','dml','lock','adaptive_hash_index','recovery','log','cpu') ORDER BY count DESC LIMIT 80;" 2>/dev/null

    section "08" "InnoDB buffer pool stats (per pool)"
    if [[ "$DB_VERSION" != "5.6" ]]; then
        run_sql "SELECT POOL_ID, POOL_SIZE, FREE_BUFFERS, DATABASE_PAGES, OLD_DATABASE_PAGES, MODIFIED_DATABASE_PAGES, PENDING_DECOMPRESS, PENDING_READS, PENDING_FLUSH_LRU, PENDING_FLUSH_LIST, PAGES_MADE_YOUNG, PAGES_NOT_MADE_YOUNG, PAGES_MADE_YOUNG_RATE, PAGES_MADE_NOT_YOUNG_RATE, NUMBER_PAGES_READ, NUMBER_PAGES_CREATED, NUMBER_PAGES_WRITTEN, PAGES_READ_RATE, PAGES_CREATE_RATE, PAGES_WRITTEN_RATE, HIT_RATE FROM information_schema.innodb_buffer_pool_stats;"
    fi
}

###############################################################################
# 模块 09：SQL 性能分析（专业巡检核心）
###############################################################################
collect_sql_performance() {
    skip_module "sql" && { echo "(skipped)"; return; }
    module_header "[09] SQL 性能分析"

    section "09" "Performance status"
    if [[ "$DB_VERSION" == "5.6" ]]; then
        run_sql "SELECT * FROM INFORMATION_SCHEMA.GLOBAL_STATUS WHERE VARIABLE_NAME IN ('Connections','Uptime','Com_select','Com_insert','Com_update','Com_delete','Com_commit','Com_rollback','Slow_queries','Created_tmp_tables','Created_tmp_disk_tables','Created_tmp_files','Table_locks_waited','Sort_merge_passes','Sort_range','Sort_rows','Sort_scan','Threads_connected','Threads_running','Aborted_connects','Aborted_clients');"
    else
        run_sql "SELECT * FROM performance_schema.global_status WHERE VARIABLE_NAME IN ('Connections','Uptime','Com_select','Com_insert','Com_update','Com_delete','Com_commit','Com_rollback','Slow_queries','Created_tmp_tables','Created_tmp_disk_tables','Created_tmp_files','Table_locks_waited','Sort_merge_passes','Sort_range','Sort_rows','Sort_scan','Threads_connected','Threads_running','Aborted_connects','Aborted_clients','Queries','Questions','Bytes_received','Bytes_sent');"
    fi

    if [[ "$DB_VERSION" != "5.6" ]]; then
        section "09" "TOP 20 SQL by total latency"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count,
sys.format_time(SUM_TIMER_WAIT) AS total_latency,
sys.format_time(AVG_TIMER_WAIT) AS avg_latency,
sys.format_time(MAX_TIMER_WAIT) AS max_latency,
SUM_ROWS_EXAMINED AS rows_examined,
SUM_ROWS_SENT AS rows_sent,
ROUND(SUM_ROWS_EXAMINED/NULLIF(SUM_ROWS_SENT,0), 1) AS examined_per_sent,
FIRST_SEEN, LAST_SEEN, DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema') OR SCHEMA_NAME IS NULL
ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;"

        section "09" "TOP 20 SQL by exec count"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count,
sys.format_time(SUM_TIMER_WAIT) AS total_latency,
sys.format_time(AVG_TIMER_WAIT) AS avg_latency,
SUM_ROWS_EXAMINED AS rows_examined, SUM_ROWS_SENT AS rows_sent,
FIRST_SEEN, LAST_SEEN, DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema') OR SCHEMA_NAME IS NULL
ORDER BY COUNT_STAR DESC LIMIT 20;"

        section "09" "TOP 20 SQL by avg latency"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count,
sys.format_time(AVG_TIMER_WAIT) AS avg_latency,
sys.format_time(SUM_TIMER_WAIT) AS total_latency,
SUM_ROWS_EXAMINED AS rows_examined,
FIRST_SEEN, LAST_SEEN, DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE COUNT_STAR > 10
AND (SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema') OR SCHEMA_NAME IS NULL)
ORDER BY AVG_TIMER_WAIT DESC LIMIT 20;"

        section "09" "SQL with full scan"
        run_sql "SELECT object_schema, object_name, count_read AS rows_full_scanned, sys.format_time(sum_timer_wait) AS latency FROM performance_schema.table_io_waits_summary_by_index_usage WHERE index_name IS NULL AND count_read > 0 ORDER BY count_read DESC LIMIT 20;"

        section "09" "SQL with temp tables (top 20)"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count,
sys.format_time(SUM_TIMER_WAIT) AS total_latency,
SUM_CREATED_TMP_TABLES AS memory_tmp,
SUM_CREATED_TMP_DISK_TABLES AS disk_tmp,
ROUND(IFNULL(SUM_CREATED_TMP_DISK_TABLES / NULLIF(SUM_CREATED_TMP_TABLES,0), 0)*100) AS tmp_disk_pct,
DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_CREATED_TMP_TABLES > 0
ORDER BY SUM_CREATED_TMP_DISK_TABLES DESC, SUM_CREATED_TMP_TABLES DESC LIMIT 20;"

        section "09" "SQL with disk sort"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count, sys.format_time(SUM_TIMER_WAIT) AS total_latency,
SUM_SORT_MERGE_PASSES AS merges, SUM_SORT_ROWS AS rows_sorted, DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_SORT_ROWS > 0
ORDER BY SUM_TIMER_WAIT DESC LIMIT 20;"

        section "09" "SQL no good index"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count, sys.format_time(SUM_TIMER_WAIT) AS total_latency,
SUM_NO_INDEX_USED AS no_index_count, SUM_NO_GOOD_INDEX_USED AS no_good_index_count,
ROUND(IFNULL(SUM_NO_INDEX_USED/NULLIF(COUNT_STAR,0), 0)*100) AS no_index_pct,
SUM_ROWS_EXAMINED AS rows_examined, ROUND(SUM_ROWS_EXAMINED/NULLIF(COUNT_STAR,0)) AS avg_rows_examined,
DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE (SUM_NO_INDEX_USED > 0 OR SUM_NO_GOOD_INDEX_USED > 0)
AND DIGEST_TEXT NOT LIKE 'SHOW%'
ORDER BY no_index_pct DESC, total_latency DESC LIMIT 20;"

        section "09" "SQL errors and warnings"
        run_sql "SELECT sys.format_statement(DIGEST_TEXT) AS query, SCHEMA_NAME AS db,
COUNT_STAR AS exec_count, SUM_ERRORS AS errors, SUM_WARNINGS AS warnings, DIGEST
FROM performance_schema.events_statements_summary_by_digest
WHERE SUM_ERRORS > 0 OR SUM_WARNINGS > 0
ORDER BY SUM_ERRORS DESC, SUM_WARNINGS DESC LIMIT 20;"

        section "09" "Schema unused indexes"
        run_sql "SELECT * FROM sys.schema_unused_indexes WHERE object_schema NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 200;"

        section "09" "Schema redundant indexes"
        run_sql "SELECT * FROM sys.schema_redundant_indexes WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 100;" 2>/dev/null

        section "09" "Index low cardinality (sel < 10%)"
        run_sql "SELECT i.database_name AS db, i.table_name AS tbl, i.index_name AS idx, i.stat_value AS distinct_rows, t.n_rows AS table_rows, ROUND(i.stat_value/NULLIF(t.n_rows,0)*100, 2) AS selectivity_pct FROM mysql.innodb_index_stats i INNER JOIN mysql.innodb_table_stats t ON i.database_name=t.database_name AND i.table_name=t.table_name WHERE i.index_name <> 'PRIMARY' AND i.stat_name LIKE 'n_diff_pfx%' AND t.n_rows > 1000 AND i.stat_value > 0 AND ROUND(i.stat_value/NULLIF(t.n_rows,0)*100, 2) < 10 AND i.database_name NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 50;"
    fi
}

###############################################################################
# 模块 10：日志采集（关键新增）
###############################################################################
collect_logs() {
    skip_module "logs" && { echo "(skipped)"; return; }
    module_header "[10] 日志采集"

    section "10" "Slow query log status"
    echo "slow_query_log: $(run_sql_silent 'SELECT @@slow_query_log;')"
    echo "slow_query_log_file: ${SLAVE_LOG_FILE}"
    echo "long_query_time: $(run_sql_silent 'SELECT @@long_query_time;')"
    echo "log_queries_not_using_indexes: $(run_sql_silent 'SELECT @@log_queries_not_using_indexes;' 2>/dev/null)"
    if [[ -n "$SLAVE_LOG_FILE" && -f "$SLAVE_LOG_FILE" ]]; then
        echo "file size: $(ls -lh "$SLAVE_LOG_FILE" 2>/dev/null | awk '{print $5}')"
        echo "mtime: $(stat -c '%y' "$SLAVE_LOG_FILE" 2>/dev/null || stat -f '%Sm' "$SLAVE_LOG_FILE" 2>/dev/null)"
    fi

    section "10" "Slow query log tail (last ${SLOW_LOG_LINES} lines)"
    if [[ -n "$SLAVE_LOG_FILE" && -r "$SLAVE_LOG_FILE" ]]; then
        tail -n "$SLOW_LOG_LINES" "$SLAVE_LOG_FILE" 2>&1
    else
        echo "(慢日志文件不可读：${SLAVE_LOG_FILE})"
    fi

    section "10" "Error log status"
    echo "log_error: ${ERROR_LOG_PATH}"
    if [[ -n "$ERROR_LOG_PATH" && -f "$ERROR_LOG_PATH" ]]; then
        echo "file size: $(ls -lh "$ERROR_LOG_PATH" 2>/dev/null | awk '{print $5}')"
    elif [[ -f "${DATA_DIR}${ERROR_LOG_PATH}" ]]; then
        ERROR_LOG_PATH="${DATA_DIR}${ERROR_LOG_PATH}"
        echo "resolved: ${ERROR_LOG_PATH}"
    fi

    section "10" "Error log tail (last ${ERROR_LOG_LINES} lines)"
    local err_file="$ERROR_LOG_PATH"
    [[ ! -f "$err_file" ]] && err_file="${DATA_DIR}${ERROR_LOG_PATH}"
    if [[ -n "$err_file" && -r "$err_file" ]]; then
        tail -n "$ERROR_LOG_LINES" "$err_file" 2>&1
    else
        echo "(错误日志文件不可读：${err_file})"
    fi
}

###############################################################################
# 模块 11：备份与恢复
###############################################################################
collect_backup() {
    skip_module "backup" && { echo "(skipped)"; return; }
    module_header "[11] 备份与恢复"

    section "11" "Backup tools available"
    for tool in mysqldump xtrabackup mariabackup mydumper innobackupex mysqlpump; do
        if command -v "$tool" >/dev/null 2>&1; then
            echo "[OK] $tool: $(command -v $tool)"
            "$tool" --version 2>&1 | head -1 || true
        else
            echo "[--] $tool: NOT FOUND"
        fi
    done

    section "11" "Crontab for mysql user"
    crontab -u mysql -l 2>/dev/null || echo "(mysql 用户无 crontab 或权限不足)"

    section "11" "Crontab for root"
    crontab -l 2>/dev/null | grep -iE 'mysql|backup|dump' || echo "(root crontab 中无 mysql 备份任务)"

    section "11" "System cron files for backup"
    for f in /etc/cron.d/* /etc/cron.daily/* /etc/cron.hourly/* /etc/cron.weekly/*; do
        if [[ -f "$f" ]] && grep -qiE 'mysql|backup|dump|xtrabackup' "$f" 2>/dev/null; then
            echo "===== $f ====="
            cat "$f"
            echo ""
        fi
    done

    section "11" "Backup directory inspection"
    IFS=',' read -ra BPS <<< "$BACKUP_PATHS"
    for bp in "${BPS[@]}"; do
        if [[ -d "$bp" ]]; then
            echo "===== ${bp} ====="
            echo "总大小: $(du -sh "$bp" 2>/dev/null | awk '{print $1}')"
            echo "最近修改文件 (TOP 20)："
            # 备份文件扩展名识别（覆盖主流备份工具产物）：
            # mysqldump: *.sql / *.sql.gz / *.dump
            # xtrabackup: *.xb / *.xbstream / *.xbcrypt
            # mariabackup: *.mbi / *.mbstream
            # mydumper: *.dump
            # 通用压缩: *.gz / *.bz2 / *.zip / *.tar* / *.zst / *.lz4
            # 通用备份: *.bak / *.bk
            find "$bp" -type f \( \
                -name "*.sql" -o -name "*.sql.*" \
                -o -name "*.dump" -o -name "*.dump.*" \
                -o -name "*.xb" -o -name "*.xbstream" -o -name "*.xbcrypt" \
                -o -name "*.mbi" -o -name "*.mbstream" \
                -o -name "*.tar" -o -name "*.tar.*" \
                -o -name "*.gz" -o -name "*.bz2" -o -name "*.zip" \
                -o -name "*.zst" -o -name "*.lz4" -o -name "*.xz" \
                -o -name "*.bak" -o -name "*.bk" \
                \) -printf "%T+ %s %p\n" 2>/dev/null | sort -r | head -20
            # 兜底：xtrabackup / mariabackup 常用以目录形式存储（无扩展名），扫一下子目录命名
            echo "(目录形式备份样本)"
            find "$bp" -mindepth 1 -maxdepth 2 -type d \
                \( -name "*backup*" -o -name "*xtra*" -o -name "*maria*" -o -name "20[0-9][0-9]*" \) \
                -printf "%T+ %p\n" 2>/dev/null | sort -r | head -10
            echo ""
        else
            echo "[--] ${bp} 不存在"
        fi
    done

    section "11" "Binlog directory"
    BINLOG_BASENAME=$(run_sql_silent "SELECT @@log_bin_basename;")
    if [[ -n "$BINLOG_BASENAME" ]]; then
        BINLOG_DIR=$(dirname "$BINLOG_BASENAME")
        echo "binlog dir: $BINLOG_DIR"
        echo "总大小: $(du -sh "$BINLOG_DIR" 2>/dev/null | awk '{print $1}')"
        ls -lt "$BINLOG_DIR" 2>/dev/null | head -10
    fi

    # v4.9：datadir / relay log 目录大小独立采集，让根因关联可以拆解「磁盘高位」主因
    section "11" "Datadir size"
    if [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
        echo "datadir: $DATA_DIR"
        echo "总大小: $(du -sh "$DATA_DIR" 2>/dev/null | awk '{print $1}')"
    else
        echo "(datadir 不可读)"
    fi

    section "11" "Relay log directory"
    RELAY_LOG_BASENAME=$(run_sql_silent "SELECT @@relay_log_basename;" 2>/dev/null)
    [[ -z "$RELAY_LOG_BASENAME" ]] && RELAY_LOG_BASENAME=$(run_sql_silent "SELECT @@relay_log;" 2>/dev/null)
    if [[ -n "$RELAY_LOG_BASENAME" ]]; then
        RELAY_LOG_DIR=$(dirname "$RELAY_LOG_BASENAME")
        # relay log 可能与 binlog 同目录（避免重复计数）
        if [[ -n "$RELAY_LOG_DIR" && "$RELAY_LOG_DIR" != "$BINLOG_DIR" && -d "$RELAY_LOG_DIR" ]]; then
            echo "relay log dir: $RELAY_LOG_DIR"
            echo "总大小: $(du -sh "$RELAY_LOG_DIR" 2>/dev/null | awk '{print $1}')"
        else
            echo "(relay log 与 binlog 同目录 或 该节点不是从库；跳过独立度量)"
        fi
    else
        echo "(本节点未启用 relay log 或不是从库)"
    fi
}

###############################################################################
# 模块 12：安全与合规
###############################################################################
collect_security() {
    skip_module "security" && { echo "(skipped)"; return; }
    module_header "[12] 安全与合规"

    section "12" "Audit plugin status"
    run_sql "SHOW PLUGINS;" 2>&1 | grep -iE 'audit|firewall' || echo "(无审计相关插件)"

    section "12" "TLS / SSL configuration"
    run_sql "SHOW VARIABLES LIKE 'have_ssl';"
    run_sql "SHOW VARIABLES WHERE Variable_name IN ('ssl_ca','ssl_cert','ssl_key','ssl_cipher','tls_version','require_secure_transport');"

    section "12" "TLS / SSL status"
    run_sql "SHOW STATUS WHERE Variable_name LIKE 'Ssl_%' AND Variable_name IN ('Ssl_accepts','Ssl_accept_renegotiates','Ssl_connect_renegotiates','Ssl_finished_accepts','Ssl_session_cache_hits','Ssl_session_cache_misses','Ssl_used_session_cache_entries','Ssl_version','Ssl_cipher');"

    section "12" "Password validation policy"
    run_sql "SHOW VARIABLES LIKE 'validate_password%';" 2>/dev/null || echo "(validate_password 插件未启用)"

    section "12" "InnoDB encryption status"
    if [[ "$DB_VERSION" == "8.0" ]]; then
        run_sql "SELECT SPACE, NAME, ENCRYPTION FROM information_schema.INNODB_TABLESPACES WHERE ENCRYPTION='Y' LIMIT 30;" 2>/dev/null || echo "(未启用 InnoDB 加密)"
    else
        run_sql "SELECT SPACE, NAME, FLAG FROM information_schema.INNODB_SYS_TABLESPACES WHERE FLAG & 8192 LIMIT 30;" 2>/dev/null || echo "(未启用 InnoDB 加密)"
    fi
    run_sql "SHOW VARIABLES WHERE Variable_name IN ('innodb_encrypt_tables','innodb_encrypt_log','innodb_encrypt_online_alter_logs','default_table_encryption');" 2>/dev/null

    section "12" "Keyring plugin"
    run_sql "SHOW PLUGINS;" 2>&1 | grep -iE 'keyring' || echo "(无 keyring 插件)"

    section "12" "Users with empty password"
    run_sql "SELECT user, host FROM mysql.user WHERE authentication_string = '' OR authentication_string IS NULL;" 2>/dev/null || \
    run_sql "SELECT user, host FROM mysql.user WHERE password = '' OR password IS NULL;" 2>/dev/null

    section "12" "Users with old auth plugin"
    run_sql "SELECT user, host, plugin FROM mysql.user WHERE plugin IN ('mysql_native_password','mysql_old_password');" 2>/dev/null

    section "12" "Global SQL_MODE"
    run_sql "SELECT @@global.sql_mode;"

    section "12" "Audit log files (if any)"
    AUDIT_FILE=$(run_sql_silent "SELECT @@audit_log_file;" 2>/dev/null)
    if [[ -n "$AUDIT_FILE" ]]; then
        echo "audit_log_file: $AUDIT_FILE"
        ls -lh "$AUDIT_FILE"* 2>/dev/null | head -5
    fi
}

###############################################################################
# 模块 13：客户访谈占位（留给业务方手填）
###############################################################################
collect_interview_template() {
    skip_module "interview" && { echo "(skipped)"; return; }
    module_header "[13] 客户访谈占位（人工补充）"

    cat <<'EOF'

----->>>---->>>  [13] interview template

# ============================================================
# 以下信息无法通过技术手段自动采集，请由业务方/DBA 手工补充
# ============================================================

[业务信息]
- 项目正式名：
- 业务峰值时段（如 9:00-11:00 / 双 11）：
- 峰值 QPS 预估：
- 业务高峰是否能容忍数据库重启？是否有维护窗口？
- 业务允许的最大数据丢失（RPO）：
- 业务允许的最大恢复时间（RTO）：

[SLA / 可用性]
- 集群承诺的可用性 SLA（如 99.9% / 99.99%）：
- 过去 12 个月发生过几次故障？典型恢复时间？
- 是否做过故障切换演练？多久一次？

[备份策略]
- 备份频率（全量/增量）：
- 备份保留期：
- 上次执行的恢复演练日期：
- 备份是否异地保存？

[变更与权限管理]
- 是否有变更审批流程？
- DBA 数量 / 操作权限分配：
- 是否有操作审计？

[合规要求]
- 适用的合规框架（等保 2.0 / SOX / GDPR / PCI）：
- 数据加密要求（rest / transit）：
- 数据保留法律要求：

[扩容历史]
- 上次扩容时间：
- 上次扩容内容（CPU/内存/磁盘）：
- 下一次预计扩容窗口：

EOF
}

###############################################################################
# 主流程
###############################################################################
collect_os
collect_mysql_basic
collect_variables
collect_replication
collect_storage
collect_users
collect_sessions_locks
collect_innodb
collect_sql_performance
collect_logs
collect_backup
collect_security
collect_interview_template

echo ""
echo "================================================================"
echo "  采集完成 - $(date '+%Y-%m-%d %H:%M:%S')"
echo "================================================================"

# 恢复 stdout
exec 1>&3
echo "采集完成，输出文件：$OUT_FILE"
echo "  大小: $(ls -lh "$OUT_FILE" | awk '{print $5}')"
echo "  行数: $(wc -l < "$OUT_FILE")"
