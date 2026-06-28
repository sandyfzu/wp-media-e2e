#!/usr/bin/env bash
# Bring up the local WordPress env and install both sites. Idempotent: re-running is safe.
set -euo pipefail
cd "$(dirname "$0")"

APACHE_PORT="${APACHE_PORT:-8100}"
NGINX_PORT="${NGINX_PORT:-8101}"

# Polls a command until it succeeds, or aborts with a clear message after `timeout` seconds —
# so a misconfigured env fails fast instead of hanging forever. Usage: wait_for <desc> <secs> <cmd…>
wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local waited=0
  until "$@" >/dev/null 2>&1; do
    if [ "$waited" -ge "$timeout" ]; then
      echo "✗ Timed out after ${timeout}s waiting for ${desc}." >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

# Start the database first and wait for it ourselves, so the web/wp-cli services (which
# depend on db being healthy) are only started once it is actually ready — avoiding the
# first-init race where compose gives up waiting on the database.
echo "→ Starting the database…"
docker compose up -d db

echo "→ Waiting for the database to be ready…"
wait_for "the database to be ready" 120 \
  docker compose exec -T db healthcheck.sh --connect --innodb_initialized

# The image creates wp_apache (MARIADB_DATABASE); add the nginx site's database + grant.
echo "→ Ensuring the nginx site's database exists…"
docker compose exec -T db mariadb -uroot -proot -e \
  "CREATE DATABASE IF NOT EXISTS wp_nginx CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; \
   GRANT ALL PRIVILEGES ON wp_nginx.* TO 'wordpress'@'%'; FLUSH PRIVILEGES;"

echo "→ Starting the web + wp-cli services…"
docker compose up -d

# Installs one site through its kept-alive wp-cli container; a no-op if already installed.
install_site() {
  local service="$1" url="$2" label="$3"
  echo "→ Waiting for WordPress files ($label)…"
  wait_for "WordPress files ($label)" 120 \
    docker compose exec -T "$service" wp config path
  if docker compose exec -T "$service" wp core is-installed >/dev/null 2>&1; then
    echo "→ $label already installed."
  else
    echo "→ Installing WordPress ($label)…"
    docker compose exec -T "$service" wp core install \
      --url="$url" \
      --title="WP Media E2E ($label)" \
      --admin_user=admin \
      --admin_password=admin_password \
      --admin_email=admin@example.test \
      --skip-email
  fi
}

install_site wp-cli-apache "http://localhost:${APACHE_PORT}" apache
install_site wp-cli-nginx "http://localhost:${NGINX_PORT}" nginx

echo "✓ Ready — Apache: http://localhost:${APACHE_PORT}  ·  Nginx: http://localhost:${NGINX_PORT}  (admin / admin_password)"
