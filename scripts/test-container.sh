#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
image="${1:-ocs-server-headless:local}"
network="${OCS_CONTAINER_TEST_NETWORK:-bridge}"
docker run --rm --init --network "$network" --shm-size=1g --cap-drop=ALL --cap-add=SYS_CHROOT \
  --security-opt no-new-privileges=true \
  --security-opt "seccomp=$(pwd)/deploy/seccomp-chromium.json" \
  "$image" node dist/smoke.js

# Exercise the real image entrypoint, named-volume ownership and crash recovery.
name="ocs-container-test-$$"
volume="${name}-data"
cleanup() {
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run --detach --name "$name" --init --network "$network" --shm-size=1g --cap-drop=ALL --cap-add=SYS_CHROOT \
  --security-opt no-new-privileges=true \
  --security-opt "seccomp=$(pwd)/deploy/seccomp-chromium.json" \
  --mount "type=volume,source=$volume,target=/data" "$image" >/dev/null
wait_ready() {
  for attempt in $(seq 1 90); do
    if docker exec "$name" node -e 'fetch("http://127.0.0.1:15319/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then return; fi
    sleep 1
  done
  docker logs "$name" >&2
  return 1
}
wait_ready
docker exec "$name" node -e 'const fs=require("fs"); if(process.getuid()===0)process.exit(1); if(!fs.existsSync("/data/encryption.key"))process.exit(1); fetch("http://127.0.0.1:15319/").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
docker exec "$name" node -e '
const fs=require("fs"),assert=require("assert/strict");
const headers={Authorization:"Bearer "+fs.readFileSync("/data/admin.token","utf8").trim(),"Content-Type":"application/json"};
const call=async(route,method="GET",body)=>{const r=await fetch("http://127.0.0.1:15319/api/v1"+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const json=await r.json();assert(r.ok,JSON.stringify(json));return json.data;};
(async()=>{const p=await call("/browsers","POST",{name:"container-recovery",startUrl:"http://127.0.0.1:15319/healthz"});await call("/browsers/"+p.id+"/start","POST");fs.writeFileSync("/data/test-profile-id",p.id);})().catch(e=>{console.error(e);process.exitCode=1;});'
docker kill --signal KILL "$name" >/dev/null
docker start "$name" >/dev/null
wait_ready
docker exec "$name" node -e '
const fs=require("fs"),assert=require("assert/strict");
const id=fs.readFileSync("/data/test-profile-id","utf8");
const headers={Authorization:"Bearer "+fs.readFileSync("/data/admin.token","utf8").trim()};
(async()=>{let r=await fetch("http://127.0.0.1:15319/api/v1/browsers/"+id,{headers});assert(r.ok);assert.equal((await r.json()).data.runtime.status,"stopped");r=await fetch("http://127.0.0.1:15319/api/v1/browsers/"+id+"/start",{method:"POST",headers});assert(r.ok,await r.text());})().catch(e=>{console.error(e);process.exitCode=1;});'
docker stop --timeout 30 "$name" >/dev/null
printf '%s\n' 'Container smoke, non-root startup, console, persistent volume and SIGKILL recovery passed.'
