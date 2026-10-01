# orbis registry

`index.json` lists modules the hub's store can install. this folder is meant to become its own repo in the org (`orbis-os/registry`); the hub's default registry url points at its raw `main/index.json`.

entry fields: `id`, `name`, `description`, `repo` (`github:owner/repo`), `latest` (semver), optional `tags`, `author`, `icon`, `tarball` (`{version}` placeholder). without `tarball` the hub downloads `https://github.com/<repo>/releases/download/v<latest>/module.tgz`.
