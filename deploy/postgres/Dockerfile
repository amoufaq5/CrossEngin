# syntax=docker/dockerfile:1
#
# Postgres with the pg_uuidv7 extension installed. The CrossEngin meta-schema defaults every id to
# uuid_generate_v7(), so that function has to exist before `crossengin apply` runs.
#
# It does NOT have to be the extension. `checkPgUuidv7Extension` accepts either an installed
# pg_uuidv7 OR any callable `uuid_generate_v7()` — it asks pg_extension and pg_proc in one
# statement — which is what makes the managed-provider path work (deploy/supabase/00-uuidv7.sql
# defines the same function in pure SQL). This file's own comment used to claim the applier
# "hard-requires the EXTENSION … a plain SQL function will not satisfy the precondition", which is
# contradicted by preconditions.ts:34 and by deploy/README.md's own Notes section, and would send
# the next reader to rebuild a C extension where one `psql -f` would do.
#
# The extension is still what this image installs, because it is the better of the two where you
# control the server: a C function against a per-row SQL one, on a path every INSERT takes. So an
# image built to install it and failing to is a build defect rather than a degraded runtime, and
# postgres/init/00-extension.sql is right to let that abort initialisation.
FROM postgres:16-bookworm

# From the PGDG apt repository, NOT the project's GitHub release, and the difference is
# architectural. That release ships ONE prebuilt .so and it is x86_64 only (fboulnois/pg_uuidv7#24:
# "the releases are built for x86_64 and not for ARM"), while `cp` of a file succeeds on every
# architecture — so an arm64 build produced an image that looked correct and whose
# `CREATE EXTENSION` failed at initdb time with a wrong-ELF-class error, under ON_ERROR_STOP=1,
# which aborts initialisation so the container never comes up at all. That is every Apple-silicon
# laptop and the whole of Oracle Cloud's Always Free tier, whose only usefully-sized shape is
# Ampere A1 (arm64).
#
# PGDG publishes postgresql-<major>-pg-uuidv7 for amd64, arm64 and ppc64el, and the official
# postgres image leaves that repository configured (/etc/apt/sources.list.d/pgdg.list plus its
# keyring survive the build on exactly those three arches), so apt resolves the right binary by
# construction and there is no architecture named anywhere here.
#
# $PG_MAJOR and not a pinned extension version: the .so must match the server's major ABI, which
# the package name carries, and that is the only axis on which this can be incompatible. The
# version floats as `node:20-bookworm-slim` and `caddy:2` do elsewhere in deploy/.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pg-uuidv7"; \
    rm -rf /var/lib/apt/lists/*
