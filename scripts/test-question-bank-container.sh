#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ocs_image="${1:-ocs-server-headless:local}"
bank_image="${2:-ocs-zerror-headless:local}"
project="ocs-bank-test-$$"
compose=(docker compose --project-name "$project" --file deploy/compose.yaml)
export OCS_IMAGE="$ocs_image" ZERROR_IMAGE="$bank_image" OCS_PORT=0 OCS_BIND_ADDRESS=127.0.0.1
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 90
"${compose[@]}" exec -T zerror zerror-headless --healthcheck
"${compose[@]}" exec -T ocs node <<'NODE'
const fs=require('fs'),assert=require('assert/strict');
const base='http://127.0.0.1:15319';
const headers={Authorization:'Bearer '+fs.readFileSync('/data/admin.token','utf8').trim(),'Content-Type':'application/json'};
const admin=async(path,method='GET',body)=>{
  const response=await fetch(base+'/api/v1/question-bank'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const json=await response.json();assert(response.ok,JSON.stringify(json));return json.data;
};
(async()=>{
  assert.notEqual(process.getuid(),0);
  const status=await admin('/status');assert.equal(status.available,true);
  await admin('/questions','POST',{question:'container fixture',answer:'container answer'});
  const connection=await admin('/connections','POST',{name:'container test',baseUrl:base});
  const response=await fetch(connection.queryUrl,{method:'POST',headers:connection.wrapper[0].headers,body:JSON.stringify({title:'container fixture'})});
  assert.equal(response.status,200);assert.equal((await response.json()).data.answer,'container answer');
  await admin('/tokens/'+connection.client.id,'DELETE');
  assert.equal((await fetch(connection.queryUrl,{method:'POST',headers:connection.wrapper[0].headers,body:JSON.stringify({title:'container fixture'})})).status,401);
  assert.equal(fs.statSync('/run/zerror/admin.token').mode&0o777,0o600);
})().catch(error=>{console.error(error);process.exitCode=1;});
NODE
"${compose[@]}" restart zerror
"${compose[@]}" up --detach --no-build --pull never --wait --wait-timeout 90
"${compose[@]}" exec -T ocs node -e 'const fs=require("fs"),assert=require("assert/strict");fetch("http://127.0.0.1:15319/api/v1/question-bank/status",{headers:{Authorization:"Bearer "+fs.readFileSync("/data/admin.token","utf8").trim()}}).then(r=>r.json()).then(j=>assert.equal(j.data.stats.questions,1)).catch(e=>{console.error(e);process.exitCode=1;});'
printf '%s\n' 'Question bank Compose health, shared credentials, OCS query, revocation and persistence passed.'
