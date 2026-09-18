#!/bin/sh

set -eu

printf 'os_product_name=%s\n' "$(sw_vers -productName)"
printf 'os_product_version=%s\n' "$(sw_vers -productVersion)"
printf 'os_build_version=%s\n' "$(sw_vers -buildVersion)"
printf 'architecture=%s\n' "$(uname -m)"
printf 'rust_version=%s\n' "$(rustc --version)"
printf 'cargo_version=%s\n' "$(cargo --version)"
printf 'rust_host=%s\n' "$(rustc --print host-tuple)"
printf 'node_version=%s\n' "$(node --version)"
printf 'npm_version=%s\n' "$(npm --version)"
printf 'git_version=%s\n' "$(git --version)"

if [ -x ./node_modules/.bin/tauri ]; then
    printf 'tauri_cli_version=%s\n' "$(./node_modules/.bin/tauri --version 2>/dev/null)"
else
    printf 'tauri_cli_version=unavailable\n'
fi

for cli_name in "$@"; do
    cli_path=$(command -v "$cli_name" 2>/dev/null || true)
    if [ -z "$cli_path" ]; then
        printf 'cli.%s=not_found\n' "$cli_name"
        continue
    fi

    cli_version=$($cli_path --version 2>/dev/null | sed -n '1p' || true)
    if [ -z "$cli_version" ]; then
        cli_version=unavailable
    fi
    printf 'cli.%s.path=%s\n' "$cli_name" "$cli_path"
    printf 'cli.%s.version=%s\n' "$cli_name" "$cli_version"
done
