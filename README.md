# ACID Guard

A stateless transaction guard for [Thru](https://thru.org). Live on alphanet at
**`taACIDvOaO1_qsjbfFCtDbNsvlArUKheO9JmPBXMBcZ_R5`** (3,960-byte RISC-V program written in C, ABI
published on-chain).

Thru already gives every transaction **Atomicity**: any revert rolls back every account change.
ACID Guard adds the other three letters as predicates you place around arbitrary program calls
inside one Multicall transaction:

```
Multicall [
  ACID.begin  { seq_eq · data_hash · absent }   <- Isolation: the read set is unchanged
  ...any program calls (token, CLOB, transfers)...
  ACID.commit { balance_min/max · data_hash }   <- Consistency: postconditions hold
]                                               <- ancestor in either phase: Durability (fork binding)
```

If any predicate fails, the guard reverts and the whole transaction is rolled back, including
calls that already ran before it.

## Why it works on Thru

- Every Thru account carries `seq`, a version counter bumped on each write. `seq_eq` turns it into
  optimistic concurrency control: a transaction built from a stale read cannot execute.
- Programs can read the last 512 block contexts (slot, block hash, state root). `ancestor`
  binds a transaction to the fork its author observed.
- Multicall makes a guard call and arbitrary program calls one atomic unit.

## Predicates

| kind | name          | body                                          | letter |
|------|---------------|-----------------------------------------------|--------|
| 1    | `seq_eq`      | `u16 account, u64 seq`                        | I      |
| 2    | `data_hash`   | `u16 account, u32 offset, u32 length, sha256` | I / C  |
| 3    | `absent`      | `u16 account`                                 | I (phantoms) |
| 4    | `balance_min` | `u16 account, u64 amount`                     | C      |
| 5    | `balance_max` | `u16 account, u64 amount`                     | C      |
| 6    | `ancestor`    | `u64 slot, u8[32] block_hash`                 | D      |

Wire format: `u8 tag (0 begin, 1 commit) · u8 count · count × (u8 kind · body)`, little-endian,
packed. Failures revert with `0xAC1D_KK_II` (KK = kind, II = predicate index); malformed input
with `0xAC1D_FF_RR`. Each passing check emits a 10-byte event `{phase, checked, slot}`.

## Live results (alphanet, 2026-10-29)

| scenario | result | CU |
|----------|--------|----|
| stale read: `begin seq_eq(bob, 2)` after a concurrent write, then transfer 100 | revert `0xAC1D0100`, bob 2 → 2 | — |
| fresh read: `begin seq_eq(bob, 3)` + transfer 100 + `commit balance_min` | success, bob 2 → 102 | 16,612 |
| transfer 100, then `commit balance_max(bob, old)` | revert `0xAC1D0500`, bob 102 → 102 (rolled back) | — |
| `ancestor(slot, explorer block hash)` | success | 7,052 |
| `ancestor(slot, forged hash)` | revert `0xAC1D0600` | — |
| `absent(never-created address)` | success | 5,773 |
| `absent(bob)` | revert `0xAC1D0300` | — |
| code pin: `data_hash(program, 0, 3960, sha256(binary))` | success | 688,115 |

Signatures and explorer links: [`demo-results.json`](./demo-results.json).

## Layout

```
acid/
  examples/tn_acid_guard.{h,c}   program (C SDK, RISC-V)
  acid_guard.abi.yaml            ABI (explorer-compatible root types)
  GNUmakefile, examples/Local.mk build against ~/.thru/sdk
scripts/
  acid.mjs                       client encoder (predicates, Multicall payload)
  demo.mjs                       live demo: isolation, consistency, durability, phantom
  grind-address.mjs              seed grinder for the taACID vanity program address
  reflect-sample.mjs             sample payload for `thru abi reflect`
```

## Build, deploy, run

Toolchain needs x86_64 Linux with glibc ≥ 2.38 (WSL Ubuntu 24.04 works).

```bash
thru dev toolchain install && thru dev sdk install c
cd acid && make                                   # build/thruvm/bin/tn_acid_guard_c.bin
thru abi analyze --files acid_guard.abi.yaml
thru program create acid2i709 build/thruvm/bin/tn_acid_guard_c.bin
thru abi prep-for-publish --file acid_guard.abi.yaml --target-network alphanet --output dist/acid_guard.publish.abi.yaml
thru abi account create acid2i709 dist/acid_guard.publish.abi.yaml
cd ../scripts && npm i && node demo.mjs
```

`thru txn execute` defaults to a 0 CU budget; pass `--compute-units` and `--memory-units`.

## License

MIT
