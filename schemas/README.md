# VURA Shared JSON Schemas

These schema files serve as the cross-language contract between TypeScript/Node (`vura-io`, `vura-runner`) and Python (`vura-io-py`).

## Contract Maintenance Rules
1. These files are the cross-language contract; any change requires updating both `vura-io` and `vura-io-py` in the same PR.
2. The contract tests (in both TypeScript and Python) must pass whenever these schema files or their loaders are changed.
