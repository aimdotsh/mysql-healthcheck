#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const envExample = fs.readFileSync(path.join(root, 'deploy', 'env.example'), 'utf8');

assert.match(
  compose,
  /\$\{STORAGE_HOST_DIR:-\/var\/lib\/mysql-healthcheck\}:\/data/,
  'Compose 必须保留默认宿主机数据路径，避免升级后历史数据不可见'
);
assert.match(envExample, /^STORAGE_HOST_DIR=\/var\/lib\/mysql-healthcheck$/m);

const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const entrypoint = fs.readFileSync(path.join(root, 'docker', 'docker-entrypoint.sh'), 'utf8');

assert.match(dockerfile, /\bgosu\b/, '镜像必须包含降权工具 gosu');
assert.match(dockerfile, /mysql-healthcheck-entrypoint/, '镜像必须通过权限初始化入口启动');
assert.match(entrypoint, /chown mysqlhc:mysqlhc/, '入口必须把数据目录交给 mysqlhc');
assert.match(entrypoint, /exec gosu mysqlhc "\$@"/, '入口必须以 mysqlhc 身份运行 Node 服务');
assert.match(entrypoint, /\[ "\$storage_root" = "\/" \]/, '入口必须拒绝修改根目录属主');

console.log('Docker Compose persistence tests passed (7 assertions).');
