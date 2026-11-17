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
#
# Pinned to an exact minor, like every other image in deploy/: a rebuild next month is the image this
# repository tested, and a minor upgrade is a line in a diff rather than a side effect of a rebuild.
ARG POSTGRES_IMAGE=postgres:16.16-bookworm
FROM ${POSTGRES_IMAGE}

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
# the package name carries, and that is the only axis on which this can be incompatible.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-pg-uuidv7"; \
    rm -rf /var/lib/apt/lists/*

# The `backup` service runs this image as `postgres` (so pg_dump matches the server's major exactly).
# /backups is created here owned by that user because a named volume is initialised from the image's
# directory on first mount, ownership included; without it the volume is root's and the service
# cannot write. A bind-mounted BACKUP_DIR has to be owned by uid 999 instead (deploy/README.md).
COPY backup/run-backups.sh /usr/local/bin/crossengin-backup
RUN mkdir -p /backups && chown postgres:postgres /backups
