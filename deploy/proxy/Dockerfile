# Auth proxy image (for Railway/managed deploys where you run the proxy as its
# own service in front of the operate-web UI). On a single VM use the `proxy`
# service in deploy/docker-compose.yml instead (it mounts the Caddyfile directly).
#
#   docker build -f deploy/proxy/Dockerfile -t crossengin-proxy .
#
# Set at runtime: UI_UPSTREAM (the operate-web host:port), CROSSENGIN_UI_TOKEN
# (the ui's --api-key token), PROXY_USERNAME / PROXY_PASSWORD_HASH (login creds).
# Caddy binds $PORT automatically (Railway provides it; defaults to 80).
FROM caddy:2
COPY deploy/proxy/Caddyfile /etc/caddy/Caddyfile
