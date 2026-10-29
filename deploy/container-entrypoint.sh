#!/bin/sh
set -eu
umask 077
node /app/dist/doctor.js
exec "$@"
