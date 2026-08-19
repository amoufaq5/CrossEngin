# syntax=docker/dockerfile:1
#
# Postgres with the pg_uuidv7 extension baked in. The CrossEngin meta-schema
# defaults every id to uuid_generate_v7(), and the migration applier hard-requires
# the pg_uuidv7 EXTENSION (it checks pg_extension) — a plain SQL function will not
# satisfy the precondition, so the extension .so must be installed here.
FROM postgres:16-bookworm

# Bump to pick up a newer pg_uuidv7 release. The tarball ships:
#   pg_uuidv7.control, pg_uuidv7--<ver>.sql, <pgmajor>/pg_uuidv7.so
ARG PG_UUIDV7_VERSION=1.6.0

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    curl -fsSL -o /tmp/pg_uuidv7.tar.gz \
      "https://github.com/fboulnois/pg_uuidv7/releases/download/v${PG_UUIDV7_VERSION}/pg_uuidv7.tar.gz"; \
    mkdir -p /tmp/pg_uuidv7; \
    tar -xzf /tmp/pg_uuidv7.tar.gz -C /tmp/pg_uuidv7; \
    cp "/tmp/pg_uuidv7/${PG_MAJOR}/pg_uuidv7.so" "$(pg_config --pkglibdir)/"; \
    cp /tmp/pg_uuidv7/pg_uuidv7.control        "$(pg_config --sharedir)/extension/"; \
    cp /tmp/pg_uuidv7/pg_uuidv7--*.sql          "$(pg_config --sharedir)/extension/"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/* /tmp/pg_uuidv7*
