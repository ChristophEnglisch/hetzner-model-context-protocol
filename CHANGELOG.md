# Changelog

## [1.0.0](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/compare/v0.1.0...v1.0.0) (2026-10-31)


### Features

* add config, logging and version modules ([bb4a2d7](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/bb4a2d7fad783da910026350da5871451964baae))
* add core toolset part 1 (server list, get, update, power, protection) ([23d88e1](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/23d88e1993840c2802c84a822aab7420f68f2351))
* add cost module with exact decimals, cost lines and cost limit ([d50f2af](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/d50f2af2183e2b30ce922a43b5e07b41761dddfe))
* add firewall rule diff and lock-out warning ([07bb1ac](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/07bb1ac1873d30a700ecc6c270f75a6420fa3d34))
* add firewalls toolset without rule diff ([914fee7](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/914fee72901868395b157c4b6854a5d37bb914f4))
* add guard chain, label helpers and defineTool ([d0fee21](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/d0fee212172753ced8a4a2338fa0b2712366eb13))
* add Hetzner gateway, error mapping and API types ([34501d9](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/34501d93c9ec494e349ad2c54155831a148a951e))
* add info and actions toolsets ([519ec82](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/519ec826fc99bd5c9306979b73f5eece139d6d98))
* add prompts audit_project_security, review_costs and provision_web_server ([d5950e1](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/d5950e14319a4b22491d720158234101c92541d3))
* add resources inventory, servers/{id} and pricing ([e4c4f5a](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/e4c4f5a6bde2c390d95069781af0123de3e68e06))
* add server lifecycle tools (create, delete, rebuild, change_type) ([d43ef53](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/d43ef535d74be982e50fb952baa2d2e3820f881f))
* add server wiring, toolset registry and cross-cutting registry tests ([cd9d86c](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/cd9d86c76ccbfbab7ba6ed0318599118b1f0ecb3))
* add ssh_keys toolset ([9ebe0ed](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/9ebe0edb987143e93d79e524fd3249ea3addffea))
* add storage toolset with volumes, snapshots and backups ([745bca3](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/745bca377d9140b7f961e63f1c36cf9b20d3e024))


### Bug Fixes

* count unlisted Primary IPv6 as free, release server_rebuild, apply AP-24b findings ([f157a12](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/f157a127b8dc1b2430f9bdbd40bc30e4f86bc2d6))
* keep Hetzner error text out of logs and harden config and release ([a422e20](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/a422e2086949d52e2da8359ac3ead240a1c47556))
* keep tokenSource visible in the startup log ([2f15463](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/2f1546303ea885d6d2ed3916f237f7453232fbd6))
* log all startup fields from the spec ([03da544](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/03da544fe596be73ee67b281c8830dc3d60dd917))
* mark server_rebuild non-idempotent and refine volume location ([f4c75a7](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/f4c75a7286f1de42aef91c250e6167ce6440c94a))
* name the SSH keys in the server_create preview ([7314df0](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/7314df06401724bed3e61ddc04048b56f00b9e23))
* reject unknown toolset names next to 'all' ([fc606d9](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/fc606d959be6386cf72d5f01237f61a1949fbfe5))
* say in the security audit prompt that port any covers all ports ([2a68493](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/2a684938e80e50639668a8d5e87cc8a4d1d0deaa))
* share one control-character definition and name resource types ([427742d](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/427742df4fec18e02093aa12fd31a969353abf5f))
* start the server unconditionally from the entry point ([3b8fd8c](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/3b8fd8c85e8d4b98fddff48ce6b8da10add386ef))
* surface caller cancellation as AbortError in the gateway ([7a5c193](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/7a5c1934f70d25969b203ec6edec157fb0aba262))
* treat firewall port "any" as all ports ([ce9cd30](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/ce9cd303a68ae03f5754d6d1e0e7cfef8e51f724))


### Documentation

* add user documentation, tools reference generator and diagrams ([44d0a94](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/44d0a949662f8deaa613d029115a30d42e2b00ae))
* link implementation plan in planning README ([55639a7](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/55639a7fd257ca92f3985ba0caa19f8ac6efd0de))
* regenerate tools reference and name the contract test script ([0300369](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/030036941f71161f6525c6b596d30c4321bb0319))


### Miscellaneous

* release 1.0.0 ([26728e2](https://github.com/ChristophEnglisch/hetzner-model-context-protocol/commit/26728e25cf33a72b81c2d1e72dc6272b4078e7dd))
